'use strict';

/**
 * BotCore: the headless daemon heart of the bot.
 *
 * Contains everything src/bot.js used to do (connect, connect watchdog,
 * exponential-backoff reconnect, anti-idle, heartbeat, metrics, clean
 * shutdown) plus three new subsystems:
 *
 *   - Actor   (src/actor.js)  autonomous goals + anti-stuck + survival layer
 *   - IpcServer (src/ipc.js)  so the TUI can drive the running daemon
 *   - renderers (src/render.js) 360 panoramas and radar maps from loaded chunks
 *
 * src/bot.js is now a thin wrapper around this class.
 */

const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const mineflayer = require('mineflayer');
const pathfinderPlugin = require('mineflayer-pathfinder').pathfinder;
const { Logger } = require('./logger');
const { Actor, isPathingNow } = require('./actor');
const { IpcServer } = require('./ipc');
const { renderPanorama, renderRadar, writePng, downsample } = require('./render');

const PROJECT_ROOT = path.resolve(__dirname, '..');

class BotCore {
  constructor(opts = {}) {
    this.cfg = opts.config;
    const cfg = this.cfg;
    this.logger = opts.logger || new Logger({
      level: cfg.logging.level,
      file: resolvePath(cfg.logging.file),
      jsonl: resolvePath(cfg.logging.jsonl),
      statusFile: resolvePath(cfg.logging.statusFile)
    });
    this.ipcPath = opts.ipcPath || path.join(PROJECT_ROOT, 'run', 'bot.sock');
    this.screenshotsDir = opts.screenshotsDir || path.join(PROJECT_ROOT, 'screenshots');
    this.homeFile = opts.homeFile || path.join(PROJECT_ROOT, 'config', 'home.json');

    this.startedAt = Date.now();
    this.stats = freshStats();
    this.bot = null;
    this.actor = null;
    this.reconnectAttempts = 0;
    // A kick that is a verdict about this client (ban), as opposed to a transient
    // failure. Set from the kicked handler; scheduleReconnect refuses to proceed.
    this.banFatal = false;
    this.retryHoldMs = 0;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.antiIdleTimer = null;
    this.heartbeatTimer = null;
    this.metricsTimer = null;
    this.tickTimer = null;
    this.shuttingDown = false;
    this.spawnYaw = null;
    this.killTimers = new Set();
    this.logBuffer = [];
    this.LOG_BUFFER = 200;
    this._busyShot = false;
    this._createBot = opts.createBot || null;
    // Called on clean shutdown so the daemon can release its single-instance lock.
    this.releaseLock = typeof opts.releaseLock === 'function' ? opts.releaseLock : () => {};
    this.demo = !!opts.demo;

    // keep the TUI's log pane fed and buffer recent lines for late attachers
    this.logger.on('log', (rec) => {
      this.logBuffer.push(rec);
      if (this.logBuffer.length > this.LOG_BUFFER) this.logBuffer.shift();
      if (this.ipc) this.ipc.broadcast('log', rec);
    });
    if (this.logger.statusFile) {
      try { this.logger.status(freshStats()); } catch (_) {}
    }
  }

  /* ------------------------------------------------------------------ *
   * lifecycle
   * ------------------------------------------------------------------ */

  async start() {
    const cfg = this.cfg;
    // try to load a persisted home point
    try {
      const h = JSON.parse(fs.readFileSync(this.homeFile, 'utf8'));
      if (h && h.home) cfg.behaviors = cfg.behaviors || {}; // actor reads its own cfg
      this._persistedHome = h && h.home ? h.home : null;
    } catch (_) { /* none yet */ }

    this.ipc = new IpcServer(this.ipcPath, (cmd, args) => this.handleIpc(cmd, args));
    try {
      await this.ipc.start();
      this.logger.info('IPC socket listening', { path: this.ipcPath });
    } catch (e) {
      this.logger.warn('IPC socket unavailable (TUI will not work)', { error: e.message });
    }

    // Optional plain-HTTP metrics endpoint for external monitoring.
    // Deliberately dependency-free: one route, GET /metrics, bound to localhost.
    const port = this.cfg.metrics && this.cfg.metrics.port;
    if (port) {
      try {
        this.http = require('http').createServer((req, res) => {
          if (req.url !== '/metrics') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found\n');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
          res.end(this.metricsText());
        });
        this.http.listen(port, '127.0.0.1');
        this.logger.info('metrics HTTP endpoint listening', { port, route: '/metrics' });
      } catch (e) {
        this.logger.warn('metrics HTTP endpoint unavailable', { error: e.message });
      }
    }

    this.logger.info('AFK bot starting', {
      config: this.cfg._configPath,
      target: `${cfg.host}:${cfg.port}`,
      username: cfg.username,
      node: process.version,
      defaultMode: (cfg.behaviors && cfg.behaviors.mode) || 'afk'
    });
    startTimers(this);
    connect(this);

    if (cfg.durationSeconds) {
      const t = setTimeout(() => {
        this.logger.info('test duration reached, shutting down', { durationSeconds: cfg.durationSeconds });
        this.shutdown('duration');
      }, cfg.durationSeconds * 1000);
      this.killTimers.add(t);
    }
  }

  /* ------------------------------------------------------------------ *
   * connection (ported from the original src/bot.js)
   * ------------------------------------------------------------------ */

  /**
   * @param {string} reason
   * @param {object} [opts] { waitIndefinitely } — set when the *proxy itself*
   *   answered that the server is stopped. An AFK bot's job is to be there when
   *   it wakes: Aternos sleeps an empty server in ~6 minutes, and if the daemon
   *   gave up (and exited) after the maxAttempts budget, the thing that was
   *   supposed to keep the server open would be gone and the server would stay
   *   down. The give-up ceiling exists to stop hammering an address that will
   *   never answer (the 694-connects bug), which is a DIFFERENT failure: a wrong
   *   address produces no ping answer at all, while a sleeping one answers
   *   "Offline" explicitly. Only the latter is exempt, and it still costs just
   *   one status ping every maxDelayMs - no handshake, no login attempt.
   */
  scheduleReconnect(reason, opts = {}) {
    if (this.shuttingDown) return;
    if (this.versionFatal) return;   // unsupported protocol: retrying cannot help
    if (this.banFatal) {
      // A ban is a decision about this account/IP, not a transient failure.
      // Retrying makes it worse, so stop and tell the operator what to do.
      this.logger.error('not reconnecting: the server banned or rejected this client', {
        reason,
        kickReason: this.stats.lastKickReason,
        hint: 'the ban must be lifted server-side; then `mc start` again'
      });
      this.stats.state = 'banned';
      this.status({ willReconnect: false });
      return;
    }
    const cfg = this.cfg;
    if (!cfg.reconnect.enabled) {
      this.logger.warn('reconnect disabled, exiting', { reason });
      this.status({ willReconnect: false });
      return;
    }
    if (this.reconnectTimer) return;

    /* A stopped server is a patient wait, not a retry to be counted: it goes
     * before the attempt increment so waiting out an hour of sleep spends none
     * of the give-up budget. The budget exists for a wrong address, which never
     * answers a ping at all; a proxy that answers "Offline" has told us exactly
     * what is wrong and that waiting is the correct action. */
    if (opts.waitIndefinitely) {
      // Do not count toward the give-up ceiling, and do not keep growing the
      // delay without bound: one cheap status ping every maxDelayMs is patient,
      // not abusive, and it is what keeps this box from hibernating forever.
      this.stats.state = 'waiting_for_server';
      const delay = Math.min(cfg.reconnect.maxDelayMs, cfg.reconnect.initialDelayMs * 4) +
        Math.round(Math.random() * cfg.reconnect.jitterMs);
      this.logger.info('server is stopped; waiting for it to start', {
        delayMs: delay, attempt: this.reconnectAttempts,
        note: 'an AFK bot that exited while the server slept could never wake it'
      });
      this.status({ willReconnect: true, nextReconnectInMs: delay });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        connect(this);
      }, delay);
      this.killTimers.add(this.reconnectTimer);
      return;
    }

    this.reconnectAttempts++;

    /* Give up on a server that has never accepted us.
     *
     * The backoff caps at maxDelayMs, so a permanently wrong host/port or a
     * server that rejects this client produces an endless cycle at the cap —
     * observed as 694 connects in 24 hours against a dead address. Retrying is
     * only rational if something might change; after `maxAttempts` spawns-worth
     * of failure with no successful spawn in between, the most likely change is
     * that the operator needs to fix the config. Stop loudly instead of
     * hammering quietly, and say exactly what to check. */
    const maxAttempts = cfg.reconnect.maxAttempts != null ? cfg.reconnect.maxAttempts : 25;
    if (this.stats.spawns === 0 && this.reconnectAttempts > maxAttempts) {
      this.logger.error('giving up: never spawned on this server, retrying will not change that', {
        attempts: this.reconnectAttempts, target: `${cfg.host}:${cfg.port}`, reason,
        hint: 'check host/port (Aternos regenerates *.aternos.host on restart), or run: mc doctor / python3 src/probe.py <host> <port>'
      });
      this.stats.state = 'giving_up';
      this.status({ fatal: true, willReconnect: false });
      if (cfg.reconnect.exitOnGiveUp !== false) setTimeout(() => this.shutdown('give-up'), 500);
      return;
    }

    const base = cfg.reconnect.initialDelayMs * Math.pow(cfg.reconnect.multiplier, this.reconnectAttempts - 1);
    let delay = Math.min(cfg.reconnect.maxDelayMs, Math.round(base)) +
      Math.round(Math.random() * cfg.reconnect.jitterMs);
    // A kick that said "come back later" (server full, whitelist queued) widens
    // the wait once, and the value is consumed rather than kept, so the next
    // ordinary blip is not permanently slowed by a transient one.
    if (this.retryHoldMs) {
      delay = Math.max(delay, this.retryHoldMs);
      this.retryHoldMs = 0;
    }
    this.logger.info('scheduling reconnect', { attempt: this.reconnectAttempts, delayMs: delay, reason });
    this.stats.state = 'waiting_to_reconnect';
    this.status({ willReconnect: true, nextReconnectInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      connect(this);
    }, delay);
    this.killTimers.add(this.reconnectTimer);
  }

  stopAntiIdle() { this.antiIdleTimer = clearTimer(this.antiIdleTimer); }

  startAntiIdle() {
    this.stopAntiIdle();
    const cfg = this.cfg;
    if (!cfg.antiIdle.enabled) return;
    if (this.spawnYaw === null && this.bot) this.spawnYaw = this.bot.entity ? this.bot.entity.yaw : 0;
    let moveToggle = false;
    this.antiIdleTimer = setInterval(() => {
      const bot = this.bot;
      if (!bot || !bot.entity) return;
      // PvP owns the movement controls; stepping away mid-fight would hand
      // the opponent free hits.
      if (this.actor && this.actor.mode === 'pvp') return;
      try {
        // Some servers (this one included) kick for "idling" based on
        // *position*, not view angle — a yaw nudge never reaches their
        // threshold and the bot gets dropped after ~35 min of perfect
        // stillness. When movement is enabled, take one small real step
        // every other cycle: walk briefly in a random direction, then walk
        // back on the next tick so the bot stays on its spot. Real packets,
        // net-zero drift.
        //
        // This branch is checked *before* the goalDesc guard on purpose: the
        // step itself creates a goal, so a guard here would see the goal it
        // just set and never fire again — the bot would take one step and
        // then be stuck motionless until the server kicked it. The goto/come
        // goals clear themselves on arrival (goal_reached), so each cycle
        // starts from a clean slate.
        if (cfg.antiIdle.movement && bot.pathfinder && this.actor && !this.actor.busy) {
          moveToggle = !moveToggle;
          const yaw = (this.spawnYaw || 0) + (Math.random() * 2 - 1) * Math.PI;
          const dist = 1.5 + Math.random() * 1.5;
          if (moveToggle) {
            const p = bot.entity.position;
            const dx = p.x - Math.sin(yaw) * dist, dz = p.z + Math.cos(yaw) * dist;
            // Delegate the ground lookup to the actor, which owns topSolidY.
            // Using the bot's raw y made the goal a point floating in mid-air
            // whenever the bot stood above or below the target's level — an
            // 8-block drop onto home left the pathfinder with no walkable
            // route, it emitted path_stop, and the bot froze in place.
            const t = this.actor.antiIdleTarget(Math.floor(dx), Math.floor(dz));
            if (t) {
              this.logger.debug('anti-idle step out', { dx: dx.toFixed(1), dz: dz.toFixed(1), y: t.y });
              this.actor.setMode('goto', [String(t.x), String(t.y), String(t.z)]);
            }
          } else {
            this.logger.debug('anti-idle step back home', {});
            this.actor.setMode('come');
          }
          return;
        }
        // never fight the actor: look-only anti-idle yields to a live goal
        if (this.actor && this.actor.goalDesc) return;
        const delta = (Math.random() * 2 - 1) * (cfg.antiIdle.maxYawDeltaDeg * Math.PI / 180);
        const yaw = (this.spawnYaw || 0) + delta;
        const pitch = bot.entity.pitch || 0;
        const p = bot.look(yaw, pitch, true);
        if (p && typeof p.catch === 'function') p.catch(() => {});
        this.logger.debug('anti-idle look', { yaw: yaw.toFixed(3) });
      } catch (e) {
        this.logger.debug('anti-idle failed', { error: e.message });
      }
    }, cfg.antiIdle.intervalMs);
    this.killTimers.add(this.antiIdleTimer);
  }

  stopWatchdog() { this.watchdog = clearTimer(this.watchdog); }

  startWatchdog() {
    this.stopWatchdog();
    this.watchdog = setTimeout(() => {
      this.logger.warn('no spawn within timeout, forcing disconnect', { timeoutMs: this.cfg.connectTimeoutMs });
      this.stats.state = 'connect_timeout';
      this.forceEnd('connect timeout');
    }, this.cfg.connectTimeoutMs);
    this.killTimers.add(this.watchdog);
  }

  forceEnd(reason) {
    const bot = this.bot;
    if (!bot) return;
    try {
      if (bot._client) bot._client.end(reason);
      else bot.quit(reason);
    } catch (e) {
      this.logger.debug('forceEnd error', { error: e.message });
    }
  }

  /**
   * Detect a server version the installed minecraft-data cannot serve.
   * Without this the bot reconnect-loops forever against an unjoinable server
   * (which is what gets an empty Aternos box hibernated). Returns true when the
   * error is unrecoverable and reconnecting should stop.
   *
   * The wording matters. mineflayer says "Unsupported protocol version '-1'" —
   * which does NOT contain the phrase "not supported", so the original pattern
   * missed it. The consequence was observed directly: a daemon hammered a dead
   * address for 24 hours and logged 694 connects, which is precisely the
   * reconnect-loop this guard exists to prevent. Match the real string.
   */
  isVersionUnsupported(err) {
    const msg = err && err.message ? err.message : String(err);
    return /no data available for version|not supported|is not supported|unsupported protocol|unsupported version|protocol version/i.test(msg);
  }

  onConnected(bot) {
    this.stats.connects++;
    this.logger.info('client connected (TCP + protocol handshake in progress)', {
      host: this.cfg.host, port: this.cfg.port, connects: this.stats.connects
    });
    this.stats.state = 'connecting';
    this.startWatchdog();
    this.status();

    bot.once('login', (packet) => {
      const uuid = (packet && packet.uuid) || bot.uuid || 'unknown';
      this.logger.info('login packet received', { username: bot.username, uuid });
      this.status();
    });

    bot.on('spawn', () => {
      const first = this.stats.spawns === 0;
      this.stats.spawns++;
      this.reconnectAttempts = 0;
    // A kick that is a verdict about this client (ban), as opposed to a transient
    // failure. Set from the kicked handler; scheduleReconnect refuses to proceed.
    this.banFatal = false;
    this.retryHoldMs = 0;
      this.stats.state = 'spawned';
      this.stats.lastSpawnAt = new Date().toISOString();
      this.stopWatchdog();
      this.spawnYaw = bot.entity ? bot.entity.yaw : 0;
      this.logger.info('spawned into world', {
        username: bot.username,
        dimension: (bot.game && bot.game.dimension) || 'unknown',
        position: bot.entity ? {
          x: +bot.entity.position.x.toFixed(2),
          y: +bot.entity.position.y.toFixed(2),
          z: +bot.entity.position.z.toFixed(2)
        } : null,
        spawns: this.stats.spawns
      });

      // (re)attach the behaviour engine to this connection
      // A successful spawn is proof the ban/verdict no longer applies: an IP ban
      // that has expired, or a whitelist that was opened. Clear the flag so the
      // daemon can resume normal operation without a restart.
      this.banFatal = false;
      if (this.actor) {
        this.actor.attach(bot);
      } else {
        const bcfg = Object.assign({}, this.cfg.behaviors || {});
        if (this._persistedHome) bcfg.home = this._persistedHome;
        this.actor = new Actor(bot, {
          logger: this.logger,
          config: bcfg,
          homeFile: this.homeFile
        });
      }
      this.actor.onSpawn();

      this.startAntiIdle();
      this.status();
      this.broadcast('spawn', { username: bot.username, spawns: this.stats.spawns });
      if (first) bot.emit('afkbot:ready');
    });

    bot.on('kicked', (reason) => {
      this.stats.kicks++;
      this.stats.lastKickReason = typeof reason === 'string' ? reason : JSON.stringify(reason);
      const kind = classifyKick(this.stats.lastKickReason);
      // Persisted on stats, not just pushed into the status file: snapshot()
      // reads stats.kickKind for `mc status`, and this handler runs before the
      // next spawn clears state, so this is the only place it can be captured.
      this.stats.kickKind = kind.kind;
      this.logger.warn('kicked by server', {
        reason: this.stats.lastKickReason, kind,
        action: kind.action
      });
      // Some kicks are verdicts about US, not about the moment. Reconnecting
      // into a ban is not persistence, it is harassment, and it is how a
      // temporary block becomes a permanent one. Observed live: a server
      // answered four consecutive connects with
      //   {"translate":"multiplayer.disconnect.banned.reason",
      //    "with":["You have been idle for too long. This violates our terms of service"]}
      // and the daemon happily retried on its backoff schedule, 25 times, then
      // would have retried forever against a second server.
      if (kind.stop) {
        this.banFatal = true;
        this.stats.state = 'banned';
        this.status({ fatal: true, willReconnect: false, kickKind: kind.kind });
        return;
      }
      // "Server full" / "whitelist" are worth waiting out, but not at the fast
      // end of the backoff: a 20-slot server that is momentarily packed will
      // still be packed in six seconds. Widen the next attempt.
      if (kind.holdMs) this.retryHoldMs = Math.max(this.retryHoldMs || 0, kind.holdMs);
      this.status({ kickKind: kind.kind });
      this.broadcast('kicked', { reason: this.stats.lastKickReason, kind: kind.kind });
    });

    bot.on('error', (err) => {
      this.stats.errors++;
      this.stats.lastError = err && err.message ? err.message : String(err);
      this.logger.error('client error', { error: this.stats.lastError, code: err && err.code });
      if (this.isVersionUnsupported(err)) {
        // The pre-flight probe is the primary gate and runs on every connect.
        // Only reach this verdict if the probe could not (e.g. it was blocked
        // and the handshake failed instead) — otherwise defer to the probe so
        // the two paths can never race to different conclusions.
        if (this._probeDecision && this._probeDecision.ok) {
          this.logger.debug('version error after a supported ping — not marking unsupported', {
            probe: this._probeDecision, error: this.stats.lastError
          });
          this.status();
          return;
        }
        // Stop the reconnect loop for the same reason as createBot above.
        this.stats.state = 'unsupported_version';
        this.logger.error('stopping: this server version is not supported by the installed minecraft-data', {
          minecraftDataVersion: require('minecraft-data/package.json').version,
          hint: 'update minecraft-data, or pin an accepted "version" in config'
        });
        this.status({ fatal: true });
        this.versionFatal = true;
        return;
      }
      this.status();
    });

    bot.on('end', (reason) => {
      this.stopWatchdog();
      this.stopAntiIdle();
      if (this.actor) { try { this.actor._clearGoal(); } catch (_) {} }
      this.stats.disconnects++;
      this.stats.lastDisconnectAt = new Date().toISOString();
      this.stats.state = 'disconnected';
      this.logger.info('disconnected', { reason: String(reason), disconnects: this.stats.disconnects });
      this.status();
      this.broadcast('end', { reason: String(reason) });
      this.scheduleReconnect(String(reason));
    });

    bot.on('health', () => {
      this.logger.debug('health', { health: bot.health, food: bot.food, saturation: bot.foodSaturation });
    });

    bot.on('respawn', () => {
      this.logger.debug('respawn packet received', { health: bot.health });
    });

    bot.on('chat', (username, message) => {
      // Passive: the bot never replies. Log only.
      this.logger.debug('chat', { from: username, message });
    });

    bot.on('whisper', (username, message) => {
      this.logger.debug('whisper', { from: username, message });
    });
  }

  /* ------------------------------------------------------------------ *
   * IPC command surface
   * ------------------------------------------------------------------ */

  async handleIpc(cmd, args) {
    switch (cmd) {
      case 'ping': return { pong: Date.now() };
      case 'debug.world': return this.debugWorld(args);
      case 'debug.chop': return this.debugChop(args);
      case 'status': return this.snapshot();
      case 'logs': return { lines: this.logBuffer.slice(-Math.min(400, args.count || 100)) };
      case 'connect':
        if (this.bot) throw new Error('already connected (or connecting)');
        connect(this);
        return { ok: true };
      case 'disconnect':
        this.forceEnd('disconnect requested by TUI');
        return { ok: true };
      case 'reconnect':
        this.forceEnd('reconnect requested by TUI');
        return { ok: true };
      case 'mode':
        this.requireSpawn();
        return this.actor.setMode(args.mode, args.args || []);
      case 'exec':
        this.requireSpawn();
        return this.actor.exec(args.line);
      case 'observe': {
        // Observed facts about another player: gamemode and any real health
        // signal. Answers "can I even hit them?" without guessing.
        this.requireSpawn();
        return this.actor.observePlayer(args.name || args.player);
      }
      case 'pvp-result':
        if (!this.actor || !this.actor.pvp) throw new Error('no pvp fight recorded');
        return this.actor.pvp.summary();
      case 'world':
        this.requireSpawn();
        return { ground: this.actor.info.ground, terrain: this.actor._groundFacts() };
      case 'survive':
        this.requireSpawn();
        // No argument => toggle. (An explicit value is honoured either way.)
        let on;
        if (args.on === undefined) on = !this.actor.survive;
        else on = ['on', 'true', '1', 'yes'].includes(String(args.on).toLowerCase());
        this.actor.survive = on;
        this.logger.info('survival layer toggled', { survive: on });
        return { ok: true, msg: `survival layer ${on ? 'on' : 'off'}` };
      case 'radar': return this.radarSnapshot(args);
      case 'screenshot': return this.takeScreenshot(args);
      case 'loglevel':
        this.logger.level = require('./logger').LEVELS[args.level] || this.logger.level;
        return { ok: true, level: args.level };
      case 'metrics': return this.metrics();
      // Prometheus-style text, one endpoint for external monitoring.
      case 'metrics-text': return { text: this.metricsText() };
      case 'quit': case 'kill':
        this.broadcast('shutdown', {});
        setTimeout(() => this.shutdown('ipc'), 250);
        return { ok: true };
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  }

  requireSpawn() {
    if (!this.bot || !this.bot.entity || this.stats.state !== 'spawned') {
      throw new Error('bot is not spawned (state: ' + this.stats.state + ')');
    }
  }

  broadcast(name, data) {
    if (this.ipc) this.ipc.broadcast(name, data);
  }

  status(extra) {
    this.stats.uptimeSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    this.logger.status(Object.assign({ state: this.stats.state, reconnectAttempts: this.reconnectAttempts }, this.stats, extra || {}));
  }

  snapshot() {
    this.stats.uptimeSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    const bot = this.bot;
    const players = [];
    if (bot && bot.players) {
      for (const name in bot.players) {
        const p = bot.players[name];
        if (p && p.entity && name !== bot.username) {
          players.push({ name, pos: roundPos(p.entity.position), dist: +horizontalDist(bot.entity.position, p.entity.position).toFixed(1) });
        }
      }
    }

    // Inventory for the TUI panel: counts by item, tools with durability, and
    // the food total so the survival layer's hunger handling is visible.
    let inventory = null;
    if (bot && bot.inventory) {
      try {
        const items = bot.inventory.items();
        const byName = {};
        for (const it of items) {
          byName[it.name] = (byName[it.name] || 0) + (it.count || 1);
        }
        const tools = items
          .filter(i => i.maxDurability && i.maxDurability > 0)
          .map(i => ({
            name: i.name,
            durability: i.maxDurability - (i.durabilityUsed || 0),
            max: i.maxDurability
          }));
        const foodNames = new Set(
          bot.registry && bot.registry.foodsByName ? Object.keys(bot.registry.foodsByName) : []);
        let foodCount = 0;
        for (const n in byName) if (foodNames.has(n)) foodCount += byName[n];
        inventory = { items: byName, tools, foodCount, slotsUsed: items.length };
      } catch (_) { inventory = null; }
    }
    return {
      pid: process.pid,
      state: this.stats.state,
      // Whether the daemon is on the offline generated world. Callers need this
      // to avoid giving live-server advice to a demo run (an idle-ban warning on
      // a server that cannot ban anything is noise that trains people to ignore
      // the real ones), and the TUI shows DEMO so nobody mistakes a demo duel
      // for a live one.
      demo: !!this.demo,
      target: `${this.cfg.host}:${this.cfg.port}`,
      username: this.cfg.username,
      version: this.cfg.version,
      uptimeSeconds: this.stats.uptimeSeconds,
      counters: {
        connects: this.stats.connects, spawns: this.stats.spawns,
        disconnects: this.stats.disconnects, kicks: this.stats.kicks, errors: this.stats.errors,
        logsChopped: this.actor ? (this.actor.logsChopped || 0) : 0,
        fleeCount: this.actor ? (this.actor.fleeCount || 0) : 0,
        hits: this.actor ? (this.actor.hitCount || 0) : 0,
        deaths: this.actor ? (this.actor.deaths || 0) : 0
      },
      lastSpawnAt: this.stats.lastSpawnAt,
      lastDisconnectAt: this.stats.lastDisconnectAt,
      lastKickReason: this.stats.lastKickReason,
      // Why the daemon is sitting idle. A ban is invisible unless it is stated:
      // the process is alive, the socket answers, and nothing moves — which reads
      // to an operator as "the bot is broken" rather than "the server refused it".
      kickKind: this.stats.kickKind || null,
      banned: !!this.banFatal,
      lastError: this.stats.lastError,
      reconnectAttempts: this.reconnectAttempts,
      health: bot && bot.health != null ? bot.health : null,
      // Hearts, the way the game shows them, plus where the number came from.
      hearts: bot && bot.health != null ? Math.max(0, Math.ceil(bot.health / 2)) : null,
      gamemode: bot && bot.game ? bot.game.gameMode : null,
      damage: this.actor && this.actor.tracker ? {
        // What the server actually reported, never inferred. This is the panel
        // that answers "did I hit them / are they even damageable?".
        incomingDamage: this.actor.tracker.lastIncomingDamage != null
          ? +this.actor.tracker.lastIncomingDamage.toFixed(1) : null,
        lastHurtAgoMs: this.actor.tracker.lastHurtAt ? Date.now() - this.actor.tracker.lastHurtAt : null,
        myHearts: this.actor.tracker.myVitals.hearts
      } : null,
      food: bot && bot.food != null ? bot.food : null,
      dimension: bot && bot.game ? bot.game.dimension : null,
      mode: this.actor ? this.actor.mode : (this.cfg.behaviors && this.cfg.behaviors.mode) || 'afk',
      // Behaviours live under cfg.behaviors; reading cfg.survive here reported
      // "off" for a config that had explicitly enabled the survival layer, which
      // matters most before the actor attaches on the first spawn.
      survive: this.actor ? !!this.actor.survive
        : !!((this.cfg.behaviors && this.cfg.behaviors.survive || this.cfg.survive) &&
             ((this.cfg.behaviors && this.cfg.behaviors.survive) || this.cfg.survive).enabled),
      goal: this.actor && this.actor.goalDesc ? this.actor.goalDesc : null,
      home: this.actor && this.actor.home ? this.actor.home : null,
      pos: bot && bot.entity ? roundPos(bot.entity.position) : null,
      yaw: bot && bot.entity ? +bot.entity.yaw.toFixed(2) : null,
      players,
      inventory,
      actor: this.actor ? this.actor.info : null,
      metrics: this.metrics()
    };
  }

  metrics() {
    const mu = process.memoryUsage();
    const cu = process.cpuUsage();
    return {
      rssMb: +(mu.rss / 1048576).toFixed(1),
      heapMb: +(mu.heapUsed / 1048576).toFixed(1),
      cpuUserS: +(cu.user / 1e6).toFixed(2),
      cpuSystemS: +(cu.system / 1e6).toFixed(2),
      // A ceiling assertion is only useful if it is visible from outside the
      // process, which is why the measured cap travels with the metrics.
      memoryCeilingMb: 220
    };
  }

  /**
   * Prometheus-style plain-text metrics, served over HTTP for external
   * monitoring. One endpoint, no dependencies: GET /metrics.
   */
  metricsText() {
    const st = this.snapshot();
    const m = st.metrics || {};
    const c = st.counters || {};
    const a = st.actor || {};
    const lines = [
      '# HELP afkbot_health Bot health (0-20)',
      '# TYPE afkbot_health gauge',
      `afkbot_health ${st.health == null ? -1 : st.health}`,
      '# HELP afkbot_food Bot food level (0-20)',
      '# TYPE afkbot_food gauge',
      `afkbot_food ${st.food == null ? -1 : st.food}`,
      '# HELP afkbot_rss_mb Resident set size in MB',
      '# TYPE afkbot_rss_mb gauge',
      `afkbot_rss_mb ${m.rssMb != null ? m.rssMb : -1}`,
      `afkbot_rss_ceiling_mb ${m.memoryCeilingMb != null ? m.memoryCeilingMb : 220}`,
      '# HELP afkbot_counters Monotonic counters',
      '# TYPE afkbot_counters counter',
      `afkbot_counters{kind="spawns"} ${c.spawns || 0}`,
      `afkbot_counters{kind="disconnects"} ${c.disconnects || 0}`,
      `afkbot_counters{kind="kicks"} ${c.kicks || 0}`,
      `afkbot_counters{kind="errors"} ${c.errors || 0}`,
      `afkbot_counters{kind="deaths"} ${c.deaths || 0}`,
      `afkbot_counters{kind="logs_chopped"} ${c.logsChopped || 0}`,
      `afkbot_counters{kind="flee_count"} ${c.fleeCount || 0}`,
      `afkbot_counters{kind="hits"} ${c.hits || 0}`,
      '# HELP afkbot_mode The current behaviour mode (0=afk)',
      '# TYPE afkbot_mode gauge',
      `afkbot_mode ${a.mode ? 1 : 0}`
    ];
    return lines.join('\n') + '\n';
  }

  /* ------------------------------------------------------------------ *
   * renderers: world adapter, panorama, radar
   * ------------------------------------------------------------------ */

  /** { getBlock(x,y,z) } over the live world, reusing one Vec3 to avoid GC. */
  worldOf() {
    const bot = this.bot;
    if (!bot || !bot.world) return null;
    const v = new Vec3(0, 0, 0);
    return {
      getBlock(x, y, z) {
        v.x = x; v.y = y; v.z = z;
        try { return bot.world.getBlock(v); } catch (_) { return null; }
      }
    };
  }

  worldBounds() {
    const bot = this.bot;
    const height = bot && bot.game && bot.game.height ? bot.game.height : 384;
    return { minY: Math.min(0, 256 - height), maxY: height - 1 };
  }

  async takeScreenshot(args = {}) {
    this.requireSpawn();
    if (this._busyShot) throw new Error('a screenshot is already being rendered');
    const bot = this.bot;
    const width = Math.min(1024, Math.max(32, args.width || 256));
    const height = Math.min(512, Math.max(16, args.height || 72));
    const radius = args.radius || 128;
    const world = this.worldOf();
    if (!world) throw new Error('world not available');
    const bounds = this.worldBounds();
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);

    this._busyShot = true;
    try {
      const { data, width: w, height: h } = await renderPanorama({
        world,
        eye: { x: eye.x, y: eye.y, z: eye.z },
        width, height,
        range: radius,
        minY: bounds.minY, maxY: bounds.maxY,
        onProgress: (done, total) => this.broadcast('shot_progress', { done, total })
      });
      try { fs.mkdirSync(this.screenshotsDir, { recursive: true }); } catch (_) {}
      const file = path.join(this.screenshotsDir, `pano_${stamp()}.png`);
      const bytes = writePng(file, w, h, data);

      const pvW = Math.min(args.previewW || 100, w);
      const pvH = Math.min(args.previewH || 40, h);
      const pv = downsample(data, w, h, pvW, pvH);
      this.logger.info('panorama written', { file, width: w, height: h, bytes });
      const out = {
        file, width: w, height: h, bytes,
        preview: { width: pv.width, height: pv.height, data: Array.from(pv.data) }
      };
      this.broadcast('shot_done', out);
      return out;
    } finally {
      this._busyShot = false;
    }
  }

  /** Diagnostic: run one gather/chop attempt with verbose logging. */
  async debugChop(args = {}) {
    const bot = this.bot;
    if (!bot || !this.actor) return { error: 'not ready' };
    const out = {};
    try {
      const logs = bot.findBlocks({
        matching: (b) => !!(b && b.name && /_log$|crimson_stem|warped_stem/.test(b.name)),
        maxDistance: Math.min(64, args.radius || 40), count: 1, minDistance: 1
      });
      if (!logs.length) return { error: 'no logs in range' };
      const p = logs[0];
      const blk = bot.blockAt(p);
      out.target = [p.x, p.y, p.z];
      out.blockName = blk ? blk.name : null;
      out.pos = bot.entity ? roundPos(bot.entity.position) : null;
      // does the actor think it can reach it?
      const a = this.actor;
      a.goalDesc = { type: 'near', x: p.x, y: p.y, z: p.z, range: 2 };
      const applied = a._applyGoal(false);
      out.applied = applied;
      out.isPathing = isPathingNow(bot);
      await new Promise(r => setTimeout(r, 3000));
      out.isPathingAfter3s = isPathingNow(bot);
      out.posAfter3s = bot.entity ? roundPos(bot.entity.position) : null;
      out.goal = a.goalDesc;
    } catch (e) { out.error = e.message; }
    return out;
  }

  /** Diagnostic: what does the bot actually see near it? Used to debug gather. */
  debugWorld(args = {}) {
    const bot = this.bot;
    if (!bot) return { error: 'not connected' };
    const radius = Math.min(48, args.radius || 24);
    const out = { pos: bot.entity ? roundPos(bot.entity.position) : null, logs: [], mobs: [] };
    try {
      const found = bot.findBlocks({
        matching: (b) => !!(b && b.name && /_log$|crimson_stem|warped_stem/.test(b.name)),
        maxDistance: radius, count: 12, minDistance: 1
      });
      for (const p of found) {
        const blk = bot.blockAt(p);
        out.logs.push({
          raw: p && p.x != null ? [p.x, p.y, p.z] : null,
          blockAtName: blk ? blk.name : null,
          typeofP: Array.isArray(p) ? 'array' : (p && p.constructor && p.constructor.name)
        });
      }
    } catch (e) { out.error = e.message; }
    try {
      if (bot.entities && bot.entity) {
        for (const id in bot.entities) {
          const e = bot.entities[id];
          if (!e || e === bot.entity || !e.position) continue;
          const d = +bot.entity.position.distanceTo(e.position).toFixed(1);
          if (d > 20) continue;
          out.mobs.push({ name: e.name || e.displayName, kind: e.kind, displayName: e.displayName, dist: d, isValid: e.isValid });
        }
      }
    } catch (e) { out.mobError = e.message; }
    return out;
  }

  radarSnapshot(args = {}) {
    const bot = this.bot;
    this.requireSpawn();
    const world = this.worldOf();
    if (!world) throw new Error('world not available');
    const bounds = this.worldBounds();
    const radius = Math.min(96, Math.max(4, args.radius || 24));
    const ref = bot.entity.position;
    const { size, rgb, topY } = renderRadar({
      world,
      cx: ref.x, cz: ref.z, refY: ref.y,
      radius,
      minY: bounds.minY, maxY: bounds.maxY
    });
    const pvW = Math.min(args.previewW || 60, size);
    const pvH = Math.min(args.previewH || 30, size);
    const pv = downsample(rgb, size, size, pvW, pvH);

    const entities = [];
    if (bot.entities) {
      for (const id in bot.entities) {
        const e = bot.entities[id];
        if (!e || !e.position || e === bot.entity) continue;
        const d = horizontalDist(ref, e.position);   // radar is top-down
        if (d > radius) continue;
        entities.push({
          // displayName is the non-deprecated field; mobType prints a
          // deprecation stack trace in live mineflayer.
          name: e.username || e.name || e.displayName || 'entity',
          kind: e.kind || (e.type === 'player' ? 'player' : 'mob'),
          dx: +(e.position.x - ref.x).toFixed(1),
          dz: +(e.position.z - ref.z).toFixed(1),
          dist: +d.toFixed(1)
        });
      }
    }
    return {
      radius, size,
      ref: { x: Math.floor(ref.x), y: Math.floor(ref.y), z: Math.floor(ref.z) },
      yaw: bot.entity.yaw,
      preview: { width: pv.width, height: pv.height, data: Array.from(pv.data) },
      topY: Array.from(topY),
      entities
    };
  }

  /* ------------------------------------------------------------------ *
   * shutdown
   * ------------------------------------------------------------------ */

  shutdown(signal) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;    this.logger.info('shutting down', { signal });
    this.stats.state = 'shutting_down';
    this.status();
    for (const t of this.killTimers) { try { clearInterval(t); clearTimeout(t); } catch (_) {} }
    this.killTimers.clear();
    this.stopAntiIdle();
    this.stopWatchdog();
    if (this.reconnectTimer) this.reconnectTimer = clearTimer(this.reconnectTimer);
    if (this.http) try { this.http.close(); } catch (_) {}
    if (this.actor) try { this.actor.destroy(); } catch (_) {}
    if (this.ipc) try { this.ipc.stop(); } catch (_) {}
    const finish = () => {
      this.logger.info('shutdown complete', { signal, uptimeSeconds: this.stats.uptimeSeconds });
      try { this.releaseLock(); } catch (_) {}   // give up the daemon lock
      process.exit(0);
    };
    if (this.bot) {
      try { this.bot.quit('AFK_Bot shutting down'); } catch (_) {}
      const t = setTimeout(() => { try { this.forceEnd('shutdown'); } catch (_) {} finish(); }, 3000);
      this.killTimers.add(t);
      this.bot.once('end', () => { clearTimer(t); finish(); });
    } else {
      finish();
    }
  }
}

/* ------------------------------------------------------------------ *
 * module-level helpers (kept close to the original bot.js structure)
 * ------------------------------------------------------------------ */

function freshStats() {
  return {
    pid: process.pid,
    state: 'starting',
    connects: 0, spawns: 0, disconnects: 0, kicks: 0, errors: 0,
    lastSpawnAt: null, lastDisconnectAt: null, lastError: null, lastKickReason: null,
    kickKind: null,
    uptimeSeconds: 0
  };
}

function clearTimer(t) { if (t) clearTimeout(t); return null; }

/**
 * Decide what to do with a status-ping version block, as ONE pure function.
 *
 * This used to be inlined in connect(), which made the two most consequential
 * branches in the daemon reachable only by running a socket against a live
 * server - i.e. untestable, and they were untested. Both had bugs of exactly
 * that kind:
 *
 *   1. "Stopped server" is NOT "unsupported version". While betahhd was asleep,
 *      its Aternos proxy answered the ping with
 *          { name: "\u00a7c\u25cf Offline", protocol: -1 }
 *      and -1 is not a Minecraft version at all - it is the value a *client*
 *      sends in the status handshake to mean "just give me the MOTD". The
 *      README documents that this placeholder means "the server is stopped", and
 *      the code contradicted the README: -1 fell through serverVersionKnown(),
 *      came back !ok, and the daemon marked the whole run fatal and quit. An
 *      Aternos box sleeps when nobody joins (here, ~6 minutes), so "stopped" is
 *      the normal state to ride out, not a verdict. This was observed live.
 *   2. The reverse error is equally fatal in the other direction: treating a
 *      genuinely unsupported version as transient is what produces a
 *      reconnect loop against an unjoinable server (694 connects in 24 hours).
 *
 * So: a real, positive protocol number we have no data for is `unsupported` and
 * stops the bot; anything that cannot be a version is `stopped` and waits.
 *
 * @param {object} version             { name, protocol } from the status ping
 * @param {function} versionKnown      protocol -> {ok, as}
 * @returns {kind:'connect'|'stopped'|'unsupported', ...diagnostics}
 */
function decideProbeAction(version, versionKnown) {
  const versionName = version && version.name;
  const protocol = version && version.protocol;
  const isRealProtocol = typeof protocol === 'number' && Number.isFinite(protocol) &&
    Number.isInteger(protocol) && protocol > 0;
  if (!isRealProtocol) {
    return {
      kind: 'stopped',
      versionName, protocol,
      probeDecision: { name: versionName, protocol, ok: false, stopped: true },
      hint: 'Aternos proxies answer with "\u25cf Offline" / a negative protocol while the server is asleep; waiting for it to start'
    };
  }
  const known = versionKnown(String(protocol));
  const log = { version: versionName, protocol, supported: known.ok, knownAs: known.as };
  if (!known.ok) {
    return {
      kind: 'unsupported',
      versionName, protocol, log,
      probeDecision: { name: versionName, protocol, ok: false },
      lastError: `server version ${versionName} (protocol ${protocol}) not supported`,
      hint: 'update minecraft-data to a release that includes this protocol, then restart'
    };
  }
  return {
    kind: 'connect',
    versionName, protocol, log,
    probeDecision: { name: versionName, protocol, ok: true, as: known.as }
  };
}

/**
 * Classify a kick reason into what the daemon should DO about it.
 *
 * The original code treated every kick identically: log it, and let the normal
 * reconnect path try again. That is right for a lag blip or a server restart and
 * catastrophically wrong for a ban, because reconnecting into a ban is how a
 * temporary block turns permanent. The categories, and why:
 *
 *   ban        - "banned", "permanently banned", "unverified reply", "ip ban".
 *                A verdict about this client. Stop entirely; retrying is hostile.
 *   idle_ban   - Aternos' "You have been idle for too long" TOoS kick (observed
 *                live). This is a ban too, but it is caused by the bot's own
 *                behaviour, so the message says which knob to turn.
 *   denied     - whitelist / server full / "you are not permitted": transient,
 *                wait longer rather than stop.
 *   transient  - everything else (restart, kicked-for-nothing, keepalive), retry
 *                on the normal schedule.
 *
 * Matching is on the translated string because mineflayer hands kicked() either
 * a raw string or a JSON chat component with `translate`/`with`, and Aternos and
 * Paper use different wordings for the same outcome.
 */
function classifyKick(reason) {
  const raw = String(reason == null ? '' : reason);
  // Match the translated text too: mineflayer hands kicked() either a raw string
  // or a JSON chat component whose `translate` key is a locale CODE
  // (multiplayer.disconnect.banned.invalid_reply), and the operator-facing
  // English may not be in the payload at all. Matching only prose is how
  // server_full fell through to "unknown" in a live test of this function.
  let text = raw.toLowerCase();
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      const bits = [j.translate, j.text, ...(Array.isArray(j.with) ? j.with : []),
                    ...(Array.isArray(j.extra) ? j.extra.map(e => (e && (e.text || e.translate)) || '') : [])];
      text = (text + ' ' + bits.filter(Boolean).join(' ')).toLowerCase();
    }
  } catch (_) { /* not JSON: match on the raw string */ }
  const has = (...ws) => ws.some(w => text.includes(w));
  if (has('idle for too long', 'idle too long', 'violates our terms', 'terms of service')) {
    return {
      kind: 'idle_ban', stop: true, holdMs: 0,
      action: 'stop: the server bans idle clients - enable antiIdle.movement or run an active mode, then start again',
      hint: 'mc start will hold position; `mc wander 32` or config antiIdle.movement=true keeps the server awake'
    };
  }
  if (has('disconnect.banned', 'banned', 'permanently banned', 'blacklisted',
          'invalid_reply', 'unverified reply', 'ip ban', 'you are banned')) {
    return { kind: 'ban', stop: true, holdMs: 0, action: 'stop: reconnecting into a ban makes it permanent', hint: 'the ban must be lifted server-side' };
  }
  if (has('whitelist', 'white_list', 'not permitted', 'server_full', 'server is full',
          'is full', 'try later', 'server white list', 'connection denied', 'rejected')) {
    return { kind: 'denied', stop: false, holdMs: 60000, action: 'wait 60s+ before the next attempt' };
  }
  // logged_in_new is NOT a ban: it means a second session took this username,
  // which happens constantly when a daemon reconnects before its old session has
  // timed out. Stopping on it would turn a normal blip into a dead bot.
  if (has('kicked for no reason', 'keepalive', 'timed out', 'timeout',
          'logged_in_new', 'logged in from another location', 'too many logins', 'server closed',
          'disconnect.generic', 'outdated_client', 'outdated_server',
          'protocol_mismatch', 'invalid_host', 'redesigned', 'reconnect')) {
    return { kind: 'transient', stop: false, holdMs: 0, action: 'retry on the normal backoff' };
  }
  return { kind: 'unknown', stop: false, holdMs: 0, action: 'retry on the normal backoff' };
}

function resolvePath(p) {
  if (!p) return p;
  return path.resolve(PROJECT_ROOT, p);
}

function roundPos(p) {
  if (!p) return null;
  return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) };
}

function horizontalDist(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function connect(core) {
  if (core.shuttingDown) return;
  if (core.reconnectTimer) core.reconnectTimer = clearTimer(core.reconnectTimer);
  const cfg = core.cfg;
  if (core.demo) {
    core.logger.info('starting in demo mode — offline generated world, no network', {
      username: cfg.username
    });
  } else {
    core.logger.info('connecting', {
      host: cfg.host, port: cfg.port, username: cfg.username,
      version: cfg.version, auth: cfg.auth
    });
  }
  core.stats.state = 'connecting';
  core.status();

  // Pre-flight: learn the server's protocol version before we attempt a join.
  // This is the SOLE arbiter of "unsupported version" — the bot 'error' handler
  // defers to it, so there is only one path that decides this. It runs on every
  // connect attempt (one cheap status ping), not just the first, so a server
  // upgrade between two connections is still caught up-front instead of at
  // handshake time.
  if (!core.demo) {
    probeServer(cfg.host, cfg.port).then((version) => {
      core._probeAt = Date.now();
      if (!version) {
        // ping failed/unsupported by us — fall through and let the handshake
        // report the real reason. Do NOT guess; the error handler will handle it.
        core.logger.debug('server ping produced no version, proceeding to connect', {
          host: cfg.host, port: cfg.port
        });
        doConnect(core);
        return;
      }
      const decision = decideProbeAction(version, serverVersionKnown);
      core._probeDecision = decision.probeDecision;
      if (decision.kind === 'stopped') {
        // Log-and-wait, never fatal: see decideProbeAction for why.
        core.logger.warn('server ping returned a non-version protocol (server likely stopped)', {
          version: decision.versionName, protocol: decision.protocol,
          hint: decision.hint
        });
        core.stats.state = 'waiting_for_server';
        core.status({ willReconnect: true });
        // Do NOT connect (the handshake would fail) and do NOT mark it fatal.
        // scheduleReconnect owns the wait, with the same backoff as any blip.
        core.scheduleReconnect('server is stopped (ping protocol ' + decision.protocol + ')',
          { waitIndefinitely: true });
        return;
      }
      if (decision.kind === 'unsupported') {
        core.logger.info('server ping', decision.log);
        core.logger.error(
          'server runs a Minecraft version the installed minecraft-data cannot serve', {
            serverVersion: decision.versionName,
            protocol: decision.protocol,
            minecraftDataVersion: require('minecraft-data/package.json').version,
            hint: decision.hint
          });
        core.stats.state = 'unsupported_version';
        core.stats.lastError = decision.lastError;
        core.versionFatal = true;
        core.status({ fatal: true });
        return;
      }
      core.logger.info('server ping', decision.log);
      doConnect(core);
    }).catch((err) => {
      // A ping failure is not a verdict — the server may just be starting. Let
      // the normal connect path surface the real problem.
      core.logger.debug('server ping failed, proceeding to connect', {
        error: String(err && err.message || err)
      });
      doConnect(core);
    });
    return;
  }
  doConnect(core);
}

/** True when the installed minecraft-data has block/protocol data for a protocol number. */
function serverVersionKnown(protocol) {
  const mc = require('minecraft-data');
  const fs = require('fs');
  const path = require('path');
  const dataDir = path.join(
    __dirname, '..', 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc');

  // Every version name that shares this protocol number. minecraft-data groups
  // protocol-compatible releases (e.g. 1.21.2/1.21.3 are both 768) and only one
  // of them carries the actual data directory — the others alias to it. Trying
  // only the first name would wrongly reject the alias's data.
  const protoNum = Number(protocol);
  const names = [];
  for (const [name, info] of Object.entries(mc.versionsByMinecraftVersion.pc)) {
    if (info.version === protoNum || info.version === parseInt(protocol, 10)) names.push(name);
  }
  if (!names.length) return { ok: false };
  for (const name of names) {
    if (fs.existsSync(path.join(dataDir, name))) return { ok: true, as: name };
  }
  return { ok: false, as: names[0] };
}

function doConnect(core) {
  if (core.shuttingDown) return;
  if (core.reconnectTimer) core.reconnectTimer = clearTimer(core.reconnectTimer);
  const cfg = core.cfg;
  if (!core.demo) {
    core.logger.info('connecting', {
      host: cfg.host, port: cfg.port, username: cfg.username,
      version: cfg.version, auth: cfg.auth
    });
  }
  core.stats.state = 'connecting';
  core.status();

  const botOpts = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    auth: cfg.auth,
    version: cfg.version === 'auto' ? undefined : cfg.version,
    hideErrors: false,
    checkTimeoutInterval: cfg.checkTimeoutMs || 60000,
    skipValidation: true,
    respawn: !!(cfg.behaviors && cfg.behaviors.survive && cfg.behaviors.survive.autoRespawn !== false)
  };

  let created;
  try {
    created = core._createBot ? core._createBot(botOpts) : mineflayer.createBot(botOpts);
  } catch (e) {
    core.logger.error('failed to create bot', { error: e.message });
    core.stats.errors++;
    if (core.isVersionUnsupported(e)) {
      // The installed minecraft-data cannot speak the server's protocol.
      // Retrying changes nothing, and hammering an empty server gets it
      // hibernated — so stop and tell the operator exactly what to fix.
      const mcVer = require('minecraft-data/package.json').version;
      core.logger.error(
        'server version is not supported by the installed minecraft-data', {
          error: e.message,
          minecraftDataVersion: mcVer,
          hint: 'update minecraft-data, or set "version" in config to a version this server also accepts'
        });
      core.stats.state = 'unsupported_version';
      core.stats.lastError = `unsupported server version: ${e.message}`;
      core.status({ fatal: true });
      return;
    }
    core.scheduleReconnect('createBot threw: ' + e.message);
    return;
  }
  try {
    if (!created._isMock && typeof created.loadPlugin === 'function') created.loadPlugin(pathfinderPlugin);
  } catch (e) {
    core.logger.warn('pathfinder plugin failed to load', { error: e.message });
  }
  core.bot = created;
  core.onConnected(created);
}

/**
 * Pre-flight: ping the server (the same status/handshake src/probe.py does) so
 * the daemon can report the server's real Minecraft version up front, and refuse
 * to reconnect-loop against a version the installed minecraft-data cannot speak.
 * Returns null if the ping fails.
 *
 * THE BUG THAT MADE THIS PROBE ALWAYS RETURN NULL
 * -----------------------------------------------
 * The JSON payload's length was read as a SINGLE BYTE:
 *
 *     const jsonLen = payload[1];        // 0x00 id, then varint string length
 *
 * but it is a **varint**, which the server encodes in two bytes as soon as the
 * status JSON exceeds 127 bytes - which every real server's does. On the captured
 * response from 4of5.aternos.me the length is 1675, encoded `8b 0d`; the single
 * byte read `0x8b` = 139, so the slice was truncated mid-string, JSON.parse threw,
 * and probeServer resolved null. The consequence is not a cosmetic log gap: this
 * function is documented as "the SOLE arbiter of unsupported version", so when it
 * fails the daemon falls through to the raw handshake, and the version gate that
 * exists to prevent reconnect-looping never runs. That is precisely how a previous
 * daemon managed 694 connects against a dead address in 24 hours.
 *
 * The fix reads every length as a real varint and parses the JSON on a byte
 * boundary, with a regression test pinned to the captured bytes
 * (tests/fixtures/status_response_4of5.bin) so a future refactor cannot silently
 * reintroduce the single-byte read.
 */
function probeServer(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const net = require('net');
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => { socket.destroy(); done(null); }, timeoutMs);
      socket.on('error', () => { clearTimeout(timer); socket.destroy(); done(null); });
      socket.on('connect', () => {
        // handshake: protocol -1 (status), then status request
        const hostBuf = Buffer.from(host, 'utf8');
        const handshake = Buffer.concat([
          varint(0x00),                       // packet id
          varint(-1),                        // protocol version: ping
          varint(hostBuf.length), hostBuf,
          Buffer.from([ (port >> 8) & 0xFF, port & 0xFF ]),
          varint(1)                           // next state: status
        ]);
        socket.write(Buffer.concat([ varint(handshake.length), handshake ]));
        socket.write(Buffer.from([ 0x01, 0x00 ]));   // status request
      });
      let buf = Buffer.alloc(0);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        // Never buffer an unbounded response from a hostile or confused endpoint.
        if (buf.length > MAX_STATUS_BYTES + 16) {
          clearTimeout(timer); socket.destroy(); done(null); return;
        }
        const parsed = parseStatusPacket(buf);
        // A short MOTD can fit in one TCP segment; a full status JSON often does
        // not, so keep waiting until the declared length has arrived.
        if (parsed === 'need-more') return;
        clearTimeout(timer);
        socket.destroy();
        done(parsed && parsed.version ? parsed.version : null);
      });
    } catch (_) { done(null); }
  });
}

/**
 * Read one protocol varint from buf at `offset`.
 * @returns {{value:number, next:number}|null} null when more bytes are needed.
 */
const MAX_STATUS_BYTES = 1024 * 1024;   // a status JSON is a few KB; 1 MB is generous

/**
 * Read one protocol varint (up to 5 bytes / 32 bits, per the Java edition spec).
 * @returns {{value:number, next:number}|null} null when more bytes are needed.
 *
 * Two things this gets right that are easy to get wrong, both found by testing
 * the boundaries rather than a happy path:
 *
 *   1. ORDER. The terminating-byte check must come BEFORE the shift overflow
 *      guard, or a legitimate 5-byte varint (`80 80 80 80 01` = 268,435,456) is
 *      rejected: by the time the last byte is read the shift counter is already
 *      past the limit, even though that byte ends the number.
 *   2. RANGE. Accumulating in float64 (not int32 ops) means a value that
 *      overflows 32 bits is detected as out of range and reported NaN instead of
 *      being silently masked down. `80*4 + 7f` is 34,091,302,912 - not a legal
 *      protocol varint - and masking it to 4,026,531,840 would hand a hostile
 *      length back to the caller looking legitimate. (The caller's size bound
 *      would catch it either way; that is defence in depth, not the fix.)
 */
function readVarint(buf, offset) {
  let value = 0, shift = 0, i = offset;
  for (; i < buf.length; i++) {
    const b = buf[i];
    value += (b & 0x7F) * Math.pow(2, shift);
    if (!(b & 0x80)) {
      if (value > 0xFFFFFFFF) return { value: NaN, next: i + 1 };   // out of protocol range
      return { value: value >>> 0, next: i + 1 };
    }
    shift += 7;
    if (shift > 28) return { value: NaN, next: i + 1 };             // past 5 bytes
  }
  return null;                                            // need more bytes
}

/**
 * Decode a status-response packet: [packet length varint][packet id varint]
 * [JSON length varint][JSON]. Returns the parsed object, the string 'need-more'
 * while the buffer is incomplete, or null when the bytes are not a status packet.
 *
 * Exported for tests, because the bug this function exists to prevent was only
 * visible against a real server's bytes, and CI must not need a live server.
 */
function parseStatusPacket(buf) {
  if (buf.length < 2) return 'need-more';
  const pkt = readVarint(buf, 0);
  if (!pkt) return 'need-more';
  if (!Number.isFinite(pkt.value) || pkt.value <= 0) return null;
  // A status payload is a few KB; anything claiming megabytes is garbage or a
  // deliberately huge varint, and waiting for it would hang the probe open.
  if (pkt.value > MAX_STATUS_BYTES) return null;
  if (buf.length < pkt.next + pkt.value) return 'need-more';
  const body = buf.slice(pkt.next, pkt.next + pkt.value);
  const id = readVarint(body, 0);
  if (!id) return null;
  const len = readVarint(body, id.next);
  if (!len || !Number.isFinite(len.value)) return null;
  if (len.value > MAX_STATUS_BYTES) return null;
  if (len.value === 0) return null;
  const json = body.slice(len.next, len.next + len.value);
  if (json.length < len.value) return null;
  try { return JSON.parse(json.toString('utf8')); } catch (_) { return null; }
}


function varint(n) {
  const bytes = [];
  let v = n >>> 0;
  while (true) {
    const b = v & 0x7F;
    v >>>= 7;
    if (v === 0) { bytes.push(b); break; }
    bytes.push(b | 0x80);
  }
  return Buffer.from(bytes);
}

function startTimers(core) {
  core.heartbeatTimer = setInterval(() => {
    core.stats.uptimeSeconds = Math.round((Date.now() - core.startedAt) / 1000);
    core.logger.info('heartbeat', {
      state: core.stats.state, uptimeS: core.stats.uptimeSeconds,
      spawns: core.stats.spawns, disconnects: core.stats.disconnects,
      reconnectAttempts: core.reconnectAttempts
    });
    core.status();
  }, 60000);
  core.metricsTimer = setInterval(() => {
    core.logger.info('metrics', Object.assign({ state: core.stats.state }, core.metrics()));
  }, 60000);
  // behaviour engine tick: anti-stuck watchdog + survival layer
  core.tickTimer = setInterval(() => {
    if (core.actor && !core.shuttingDown) {
      try { core.actor.tick(); } catch (e) { core.logger.debug('actor tick error', { error: e.message }); }
    }
  }, 500);
  core.killTimers.add(core.heartbeatTimer);
  core.killTimers.add(core.metricsTimer);
  core.killTimers.add(core.tickTimer);
}

module.exports = { BotCore, probeServer, serverVersionKnown, parseStatusPacket, readVarint, classifyKick, decideProbeAction, MAX_STATUS_BYTES };
