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

  scheduleReconnect(reason) {
    if (this.shuttingDown) return;
    if (this.versionFatal) return;   // unsupported protocol: retrying cannot help
    const cfg = this.cfg;
    if (!cfg.reconnect.enabled) {
      this.logger.warn('reconnect disabled, exiting', { reason });
      this.status({ willReconnect: false });
      return;
    }
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const base = cfg.reconnect.initialDelayMs * Math.pow(cfg.reconnect.multiplier, this.reconnectAttempts - 1);
    const delay = Math.min(cfg.reconnect.maxDelayMs, Math.round(base)) +
      Math.round(Math.random() * cfg.reconnect.jitterMs);
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
    this.antiIdleTimer = setInterval(() => {
      const bot = this.bot;
      if (!bot || !bot.entity) return;
      // never fight the actor: anti-idle only nudges when nothing is pathing
      if (this.actor && this.actor.goalDesc) return;
      try {
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
   */
  isVersionUnsupported(err) {
    const msg = err && err.message ? err.message : String(err);
    return /No data available for version|not supported|is not supported/i.test(msg);
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
      this.logger.warn('kicked by server', { reason: this.stats.lastKickReason });
      this.status();
      this.broadcast('kicked', { reason: this.stats.lastKickReason });
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
      lastError: this.stats.lastError,
      reconnectAttempts: this.reconnectAttempts,
      health: bot && bot.health != null ? bot.health : null,
      food: bot && bot.food != null ? bot.food : null,
      dimension: bot && bot.game ? bot.game.dimension : null,
      mode: this.actor ? this.actor.mode : (this.cfg.behaviors && this.cfg.behaviors.mode) || 'afk',
      survive: this.actor ? !!this.actor.survive : !!(this.cfg.survive && this.cfg.survive.enabled),
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
    uptimeSeconds: 0
  };
}

function clearTimer(t) { if (t) clearTimeout(t); return null; }

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
      const proto = version.protocol;
      const known = serverVersionKnown(String(proto));
      core.logger.info('server ping', {
        version: version.name, protocol: proto,
        supported: known.ok, knownAs: known.as
      });
      core._probeDecision = { name: version.name, protocol: proto, ok: known.ok };
      if (!known.ok) {
        core.logger.error(
          'server runs a Minecraft version the installed minecraft-data cannot serve', {
            serverVersion: version.name,
            protocol: proto,
            minecraftDataVersion: require('minecraft-data/package.json').version,
            hint: 'update minecraft-data to a release that includes this protocol, then restart'
          });
        core.stats.state = 'unsupported_version';
        core.stats.lastError = `server version ${version.name} (protocol ${proto}) not supported`;
        core.versionFatal = true;
        core.status({ fatal: true });
        return;
      }
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
 * Pre-flight: ping the server (as the Java status handshake already does in
 * src/probe.py) so the daemon can report the server's real Minecraft version
 * up front. Returns null if the ping fails.
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
        // read until we have the full JSON response
        if (buf.length < 4) return;
        // packet length is a varint; assume it fits in 3 bytes for status
        let vi = 0, vl = 0;
        for (let i = 0; i < 3; i++) {
          const b = buf[i]; vl += (b & 0x7F) << (7 * i);
          if (!(b & 0x80)) { vi = i + 1; break; }
        }
        if (!vi) return;
        const payload = buf.slice(vi);
        if (payload.length < 2) return;
        const jsonLen = payload[1];        // 0x00 id, then varint string length
        if (payload.length < 2 + jsonLen) return;
        try {
          const json = JSON.parse(payload.slice(2, 2 + jsonLen).toString('utf8'));
          clearTimeout(timer); socket.destroy();
          done(json && json.version ? json.version : null);
        } catch (_) {
          clearTimeout(timer); socket.destroy(); done(null);
        }
      });
    } catch (_) { done(null); }
  });
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

module.exports = { BotCore, probeServer, serverVersionKnown };
