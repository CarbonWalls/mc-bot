'use strict';

/**
 * Autonomous behaviour engine ("the algorithm that plays Minecraft").
 *
 * Layered design:
 *
 *   1. Passive core      — the original AFK behaviour. Default mode 'afk'
 *                          never moves, never digs, never chats.
 *   2. Goal driver       — mineflayer-pathfinder goals for goto / follow /
 *                          wander / gather / come, expressed as descriptors so
 *                          any goal can be rebuilt on demand (see unstick()).
 *   3. Anti-stuck watchdog — measures real movement; when the bot stalls it
 *                          jumps, clears whatever is in the way, and re-plans.
 *                          After repeated failure it gives up cleanly instead
 *                          of spinning forever.
 *   4. Survival layer    — opt-in reactive layer that runs on top of any mode:
 *                          auto-eat when hungry, flee when low, hit back when
 *                          hit, auto-respawn on death.
 *
 * Everything is opt-in. With the shipped config the bot behaves exactly like
 * the passive AFK bot it was before.
 */

const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

const {
  GoalNear, GoalBlock, GoalFollow, GoalGetToBlock, GoalXZ, GoalInvert, GoalCompositeAny
} = goals;

const LOG_BLOCKS = new Set([
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'bamboo', 'crimson_stem', 'warped_stem'
]);

/**
 * GoalFollow wrapper that tolerates a target that de-spawns or leaves the
 * bot's entity-tracking range.
 *
 * mineflayer-pathfinder's own GoalFollow dereferences the entity it was given
 * on every pathing tick (`entity.position` in isValid/hasChanged). If the
 * target's entity goes null while a path is live — which happens whenever a
 * player walks far enough away that the server stops sending their entity —
 * the pathfinder throws inside its own timer. That exception is unhandled, so
 * it killed the whole bot process mid-heartbeat, with no stack trace in the
 * log and no error event, just a silent exit. This is what took the bot down
 * when it was asked to follow a player who was already 60+ blocks off.
 *
 * Instead of handing it a raw entity, we hand it a fresh one each tick and
 * report "unreachable" when the target is gone, which the existing path_stop
 * handling turns into a clean fallback to AFK.
 */
class SafeGoalFollow extends GoalFollow {
  constructor(resolve, range, reach) {
    super({ position: new Vec3(0, 0, 0) }, range, reach);
    this._resolve = resolve;
  }

  isValid(x, y, z) {
    const e = this._resolve();
    if (!e || !e.position) return false;
    this.entity = e;
    return super.isValid(x, y, z);
  }

  hasChanged(x, y, z) {
    const e = this._resolve();
    if (!e || !e.position) return false;
    this.entity = e;
    return super.hasChanged(x, y, z);
  }
}

const LEAF_BLOCKS = new Set([
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves',
  'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves'
]);

// Minecraft's night window, per the vanilla day cycle. mineflayer's own bed
// plugin uses this exact range, so anything inside it is dark enough to spawn.
const NIGHT_START = 12541;
const NIGHT_END = 23458;

/** True when the world is dark enough for monsters to spawn. */
function isNight(bot) {
  const tod = bot && bot.time && bot.time.timeOfDay;
  if (typeof tod !== 'number') return false;      // time unknown yet => assume day
  return tod >= NIGHT_START && tod <= NIGHT_END;
}

const HOSTILE_MOBS = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider',
  'cave_spider', 'witch', 'enderman', 'piglin_brute', 'blaze', 'ghast', 'magma_cube',
  'slime', 'silverfish', 'pillager', 'vindicator', 'evoker', 'ravager', 'warden',
  'wither_skeleton', 'wither', 'ender_dragon', 'hoglin', 'zoglin', 'guardian',
  'elder_guardian', 'shulker', 'phantom', 'zombie_villager', 'vex', 'breeze'
]);

const FALLBACK_FOODS = new Set([
  'bread', 'cooked_beef', 'beef', 'cooked_porkchop', 'porkchop', 'cooked_chicken',
  'chicken', 'cooked_mutton', 'mutton', 'cooked_rabbit', 'rabbit', 'cooked_cod',
  'cod', 'cooked_salmon', 'salmon', 'baked_potato', 'potato', 'carrot',
  'beetroot', 'beetroot_soup', 'mushroom_stew', 'rabbit_stew', 'suspicious_stew',
  'dried_kelp', 'apple', 'golden_apple', 'enchanted_golden_apple', 'melon_slice',
  'sweet_berries', 'glow_berries', 'honey_bottle', 'cookie', 'cake', 'pumpkin_pie',
  'spider_eye', 'rotten_flesh', 'tropical_fish', 'pufferfish'
]);

const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toolTier(name) {
  for (let i = 0; i < TOOL_TIERS.length; i++) if (name.startsWith(TOOL_TIERS[i] + '_')) return i;
  return 99;
}

function isLog(block) { return block && LOG_BLOCKS.has(block.name); }
function isLeaf(block) { return block && LEAF_BLOCKS.has(block.name); }

/**
 * @param {object} bot        mineflayer bot (or the mock equivalent)
 * @param {object} opts       { logger, config: cfg.behaviors, homeFile }
 */
class Actor {
  constructor(bot, opts = {}) {
    this.bot = bot;
    this.log = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.cfg = opts.config || {};
    this.homeFile = opts.homeFile || null;
    this.home = this.cfg.home || null;

    this.mode = 'afk';               // never pathfind until told to
    this.goalDesc = null;            // rebuildable description of the live goal
    this.goalStartedAt = 0;
    this.stuckAttempts = 0;
    this.lastPos = null;
    this.lastMoveAt = Date.now();
    this.busy = false;               // an async behaviour loop is running
    this.destroyed = false;

    // survival layer
    this.survive = !!(this.cfg.survive && this.cfg.survive.enabled);
    this.prevHealth = bot.health != null ? bot.health : 20;
    this.lastHurtAt = 0;
    this.eating = false;
    this.prevMode = null;            // mode to restore after flee/fight

    // PvP opponent controller. Created lazily on first use so the passive
    // default never pays for it; it owns its own control loop and clears the
    // control states when it stops.
    this.pvp = null;

    this._wire();
  }

  /* ------------------------------------------------------------------ *
   * wiring
   * ------------------------------------------------------------------ */

  _wire() {
    const bot = this.bot;
    // Remove any listeners we registered on a previous bot (reconnect) so a
    // single death cannot fire the handler several times.
    if (this._unwire) { try { this._unwire(); } catch (_) {} }
    const handlers = [];
    const on = (ev, fn) => { bot.on(ev, fn); handlers.push([ev, fn]); };
    this._unwire = () => { for (const [ev, fn] of handlers) { try { bot.removeListener(ev, fn); } catch (_) {} } };

    // 'spawn' is deliberately NOT wired here: core calls onSpawn() explicitly
    // after (re)attaching, which avoids double-handling on reconnect.
    on('health', () => this.onHealth());
    on('death', () => {
      // Remember where we died so the recovery loop can come back for the
      // dropped items once respawned. Without this the bot respawns at home
      // and its gear is lost — a silent, permanent setback.
      try {
        const p = bot.entity && bot.entity.position;
        if (p) this.deathPos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: Date.now() };
      } catch (_) {}
      this.log.warn('actor: died, clearing goal', { deathPos: this.deathPos });
      this._clearGoal();
      this.deaths = (this.deaths || 0) + 1;
      if (this.survive && this.cfg.survive.autoRespawn !== false) {
        try { bot.respawn(); } catch (e) { this.log.debug('respawn failed', { error: e.message }); }
      }
    });

    // mineflayer injects plugins asynchronously on 'inject_allowed', so
    // bot.pathfinder may not exist yet when we first attach. Wire it as soon as
    // it does — and re-wire on later attaches (reconnects), since the plugin
    // object can be swapped out.
    // NOTE: mineflayer-pathfinder emits on the *bot* object, not on
    //   bot.pathfinder (which is a plain state object, not an EventEmitter).
    const wirePathfinder = () => {
      if (!bot.pathfinder) return;
      if (bot._actorPathfinderWired === bot.pathfinder) return;
      bot._actorPathfinderWired = bot.pathfinder;
      on('goal_reached', (g) => {
        this.log.debug('actor: goal reached', { mode: this.mode });
        this.goalDesc = null;
        // Anti-idle uses goto/come as a one-step shuffle and needs the goal
        // cleared on arrival, otherwise the leftover goalDesc blocks every
        // later anti-idle tick and the server eventually kicks for idling.
        if (this.mode === 'goto' || this.mode === 'come') this.setMode('afk');
      });
      on('path_reset', (reason) => {
        this.log.debug('actor: path reset', { reason });
      });
      // The pathfinder gives up (no route to the goal) by emitting path_stop.
      // Without this the goal was silently dropped and the mode was left set,
      // so the bot stood 10 blocks away still claiming to be "goto" — the
      // exact "stuck halfway" failure the project exists to prevent.
      on('path_stop', () => {
        if (!this.goalDesc) return;
        this.log.warn('actor: pathfinder gave up, no route to goal', {
          mode: this.mode, goal: describeGoal(this.goalDesc)
        });
        this.goalDesc = null;
        // An unreachable waypoint is not a crash: fall back to AFK and let the
        // caller pick a new target. Only a hard timeout retries.
        if (this.mode !== 'afk') {
          this.stuckAttempts = 0;
          this.setMode('afk');
        }
      });
    };
    wirePathfinder();
    if (!bot.pathfinder) {
      bot.once('inject_allowed', wirePathfinder);
      handlers.push(['inject_allowed', wirePathfinder]);
    }
    if (!this.movementsReady) this._setupMovements();
  }

  onSpawn() {
    if (!this.home && this.bot.entity) {
      const p = this.bot.entity.position;
      this.home = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
      this.log.info('actor: home set to first spawn', { home: this.home });
    }
    // If we just respawned after a death, try to recover the dropped items
    // before doing anything else. Best-effort: if the death point is gone or
    // unreachable we log it and move on rather than spinning.
    if (this.deathPos) {
      this.recoverItems().catch(e => this.log.debug('recovery ended', { error: e.message }));
      return;
    }
    // apply the configured startup mode (default 'afk' => nothing happens)
    const startMode = this.cfg.mode || 'afk';
    if (startMode && startMode !== 'afk') {
      this.setMode(startMode, this.cfg.startArgs || []);
    }
  }

  /**
   * Walk back to the last death position to pick up dropped items.
   *
   * On death, Minecraft drops the inventory where the bot fell and respawns it
   * at the world spawn. A bot that never returns has permanently lost its gear
   * — which is how an active goal silently turns into a permanent setback.
   * This is best-effort: items despawn after 5 minutes and the walk may fail,
   * so a failed recovery logs a reason and gives up rather than looping.
   */
  async recoverItems() {
    const target = this.deathPos;
    this.deathPos = null;                 // claim it once, no matter the outcome
    if (!target) return;
    if (!this.bot || !this.bot.entity) return;
    const ageS = (Date.now() - (target.at || 0)) / 1000;
    if (ageS > 300) {
      this.log.warn('actor: skipping item recovery, drops have despawned', { ageS: +ageS.toFixed(0) });
      return;
    }
    this.log.info('actor: recovering dropped items', { at: target, ageS: +ageS.toFixed(0) });
    const prevMode = this.mode;
    try {
      this.goalDesc = { type: 'near', x: target.x, y: target.y, z: target.z, range: 3 };
      this.goalStartedAt = Date.now();
      this._applyGoal(false);
      await this._awaitGoal(90000);
      this.log.info('actor: reached death point', { at: target });
    } catch (e) {
      this.log.warn('actor: could not reach death point', { at: target, error: e.message });
    } finally {
      this._clearGoal();
      // Whatever we were doing before dying is worth resuming.
      if (prevMode && prevMode !== 'afk') {
        try { this.setMode(prevMode, this.cfg.startArgs || []); } catch (_) {}
      }
    }
  }

  /** Re-bind to a fresh bot object after a reconnect. */
  attach(bot) {
    this.bot = bot;
    this.goalDesc = null;
    this.stuckAttempts = 0;
    this.lastPos = null;
    this.lastMoveAt = Date.now();
    this.eating = false;
    this._movements = null;
    this._wire();
  }

  onHealth() {
    const bot = this.bot;
    const h = bot.health != null ? bot.health : 20;
    const hurt = h < this.prevHealth;
    if (hurt) this.lastHurtAt = Date.now();
    this.prevHealth = h;

    // React the instant we take damage — a tick-based poll is too slow when a
    // a zombie can do lethal damage in a couple of seconds. Fighting back or
    // running away here is what keeps an active goal from dying out halfway.
    if (!hurt || this.destroyed) return;
    const s = this.cfg.survive || {};
    const active = this.mode !== 'afk' && this.mode !== 'hold' && this.mode !== 'come';
    if (!(this.survive || active)) return;
    if (this.mode === 'fight' || this.mode === 'flee') return;
    // PvP owns its own spacing and retreats on its own clock; the survival
    // layer would otherwise fight it for the movement controls.
    if (this.mode === 'pvp') return;

    // At night, melee mobs can close from spawning range to hitting range
    // faster than a 20-tick poll notices, so raise the bar for staying: if one
    // is inside `nightFleeRadius` (default 12) even at full health, run now
    // rather than after the first hit. A zombie does ~3-4 damage per hit, so
    // waiting to be hit at all is the expensive choice.
    const fleeHealth = s.fleeHealth != null ? s.fleeHealth : 10;
    const night = isNight(bot);
    const nightRadius = s.nightFleeRadius != null ? s.nightFleeRadius : 12;
    if (night && h < fleeHealth + 4) {
      const close = nearestHostile(bot, nightRadius);
      if (close) {
        this.log.warn('actor: hostile close at night, fleeing before it hits', {
          mob: close.name || close.username, distance: +bot.entity.position.distanceTo(close.position).toFixed(1)
        });
        this.prevMode = (this.mode === 'afk' || this.mode === 'hold') ? 'afk' : this.mode;
        this._preGoalMode = this.prevMode;
        this.mode = 'flee';
        this.stuckAttempts = 0;
        this.fleeCount = (this.fleeCount || 0) + 1;
        if (this.home) {
          this.goalDesc = { type: 'near', x: this.home.x, y: this.home.y, z: this.home.z, range: 4 };
          this._applyGoal(false);
        }
        this.fleeLoop().catch(e => this.log.debug('flee loop ended', { error: e.message }));
        return;
      }
    }

    // Low health => run first, ask questions later.
    if (h < fleeHealth) {
      this.log.warn('actor: taking damage, fleeing', { health: +h.toFixed(1) });
      this.prevMode = (this.mode === 'afk' || this.mode === 'hold') ? 'afk' : this.mode;
      this._preGoalMode = this.prevMode;
      this.mode = 'flee';
      this.stuckAttempts = 0;
      this.fleeCount = (this.fleeCount || 0) + 1;
      const threat = nearestHostile(bot, 18);
      if (threat && bot.entity) {
        const away = bot.entity.position.scale(2).minus(threat.position);
        const y = topSolidY(bot, Math.floor(away.x), Math.floor(away.z), Math.floor(bot.entity.position.y)) || Math.floor(bot.entity.position.y);
        this.goalDesc = { type: 'near', x: Math.floor(away.x), y, z: Math.floor(away.z), range: 4 };
        this._applyGoal(false);
      }
      this.fleeLoop().catch(e => this.log.debug('flee loop ended', { error: e.message }));
      return;
    }

    // Otherwise hit the thing that is hitting us.
    if (s.attack !== false) {
      const threat = nearestHostile(bot, 6);
      if (threat) {
        this.log.warn('actor: hit back', { mob: threat.name || threat.username, health: +h.toFixed(1) });
        this.prevMode = this.mode;
        this.mode = 'fight';
        this._fightTarget = threat;
        this.hitCount = (this.hitCount || 0) + 1;
        this.fightLoop().catch(e => this.log.debug('fight loop ended', { error: e.message }));
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * goals
   * ------------------------------------------------------------------ */

  _setupMovements() {
    const bot = this.bot;
    if (!bot.pathfinder || !bot.registry) return;
    if (this._movements) return;
    if (bot._isMock) return;   // the mock has its own fake pathfinder; Movements needs a real registry
    try {
      const movements = new Movements(bot, bot.registry);
      movements.canDig = this.cfg.canDig !== false;
      movements.allowSprinting = this.cfg.allowSprinting !== false;
      bot.pathfinder.setMovements(movements);
      this._movements = movements;
    } catch (e) {
      this.log.warn('actor: movements setup failed', { error: e.message });
    }
  }

  _buildGoal(desc) {
    const g = goals;
    switch (desc.type) {
      case 'near': return new GoalNear(desc.x, desc.y, desc.z, desc.range);
      case 'block': return new GoalBlock(desc.x, desc.y, desc.z);
      case 'xz': return new GoalXZ(desc.x, desc.z);
      case 'follow': {
        // SafeGoalFollow re-resolves the target each pathing tick and returns
        // "unreachable" instead of throwing when it has de-spawned.
        if (!desc.resolve) return null;
        const e0 = desc.resolve();
        if (!e0 || !e0.position) return null;
        return new SafeGoalFollow(desc.resolve, desc.range, desc.reach);
      }
      case 'getto': return new GoalGetToBlock(desc.resolve());
      case 'invert': return new GoalInvert(this._buildGoal(desc.inner));
      default: return null;
    }
  }

  _applyGoal(dynamic = true) {
    const bot = this.bot;
    if (!this.goalDesc || !bot.pathfinder) return false;
    this._setupMovements();
    const goal = this._buildGoal(this.goalDesc);
    if (!goal) return false;
    try {
      bot.pathfinder.setGoal(goal, dynamic);
      this.goalStartedAt = Date.now();
      return true;
    } catch (e) {
      this.log.warn('actor: setGoal failed', { error: e.message });
      return false;
    }
  }

  _clearGoal() {
    const bot = this.bot;
    try { if (isPathingNow(bot)) bot.pathfinder.setGoal(null); } catch (_) {}
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null, true); } catch (_) {}
    this.goalDesc = null;
  }

  /* ------------------------------------------------------------------ *
   * modes
   * ------------------------------------------------------------------ */

  get info() {
    const p = this.bot.entity ? this.bot.entity.position : null;
    return {
      mode: this.mode,
      goal: this.goalDesc ? describeGoal(this.goalDesc) : null,
      goalStartedAt: this.goalStartedAt || null,
      stuckAttempts: this.stuckAttempts,
      survive: this.survive,
      home: this.home,
      pos: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null,
      queue: this.queue ? this.queue.info : null,
      deathPos: this.deathPos || null
    };
  }

  setMode(mode, args = []) {
    if (this.destroyed) return { ok: false, msg: 'actor destroyed' };
    if (!VALID_MODES.has(mode)) return { ok: false, msg: `unknown mode: ${mode}` };
    const bot = this.bot;
    if (!bot || !bot.entity) return { ok: false, msg: 'bot not spawned yet' };

    // stop whatever async loop is running
    if (this.pvp && this.pvp.running && mode !== 'pvp') this.pvp.stop(`mode->${mode}`);
    this.mode = mode;                 // loops re-check this each step
    this.stuckAttempts = 0;
    this.prevMode = null;
    this._clearGoal();

    switch (mode) {
      case 'afk':
        this.log.info('actor: AFK (passive, no movement)');
        return { ok: true, msg: 'AFK — passive, no movement' };
      case 'hold':
        this.log.info('actor: holding position');
        return { ok: true, msg: 'Holding position' };
      case 'goto': {
        const p = parseCoords(args, bot);
        if (!p.ok) return { ok: false, msg: p.msg };
        this.goalDesc = { type: p.exact ? 'block' : 'near', x: p.x, y: p.y, z: p.z, range: this.cfg.gotoRange || 3 };
        if (!this._applyGoal(false)) return { ok: false, msg: 'pathfinder unavailable' };
        this.log.info('actor: going to', { target: { x: p.x, y: p.y, z: p.z } });
        return { ok: true, msg: `Going to ${p.x} ${p.y} ${p.z}` };
      }
      case 'come': {
        if (!this.home) return { ok: false, msg: 'no home known yet' };
        this.goalDesc = { type: 'near', x: this.home.x, y: this.home.y, z: this.home.z, range: 3 };
        if (!this._applyGoal(false)) return { ok: false, msg: 'pathfinder unavailable' };
        this.log.info('actor: coming home', { home: this.home });
        return { ok: true, msg: `Coming home (${this.home.x} ${this.home.y} ${this.home.z})` };
      }
      case 'follow': {
        const name = args[0];
        if (!name) return { ok: false, msg: 'usage: follow <player> [range]' };
        const pl = bot.players && bot.players[name];
        if (!pl || !pl.entity) return { ok: false, msg: `cannot see player ${name}` };
        const range = Math.max(1, parseInt(args[1], 10) || (this.cfg.follow && this.cfg.follow.range) || 3);
        const reach = (this.cfg.follow && this.cfg.follow.reach) || Math.max(range + 3, 6);
        this.goalDesc = {
          type: 'follow', range, reach,
          resolve: () => (bot.players[name] && bot.players[name].entity) || null
        };
        if (!this._applyGoal(true)) return { ok: false, msg: 'pathfinder unavailable' };
        this.log.info('actor: following', { player: name, range });
        return { ok: true, msg: `Following ${name} (range ${range})` };
      }
      case 'wander': {
        const radius = Math.max(8, parseInt(args[0], 10) || (this.cfg.wander && this.cfg.wander.radius) || 64);
        this._wanderRadius = radius;
        this.wanderLoop().catch(e => this.log.debug('wander loop ended', { error: e.message }));
        return { ok: true, msg: `Wandering within ${radius} blocks of home` };
      }
      case 'gather': {
        const radius = Math.max(16, parseInt(args[0], 10) || (this.cfg.gather && this.cfg.gather.radius) || 96);
        this.gatherLoop(radius).catch(e => this.log.debug('gather loop ended', { error: e.message }));
        return { ok: true, msg: `Gathering wood within ${radius} blocks` };
      }
      case 'attack': {
        const name = args[0];
        const target = findEntityNamed(bot, name);
        if (!target) return { ok: false, msg: `cannot find entity ${name}` };
        this._fightTarget = target;
        this.mode = 'fight';
        this.fightLoop().catch(e => this.log.debug('fight loop ended', { error: e.message }));
        return { ok: true, msg: `Attacking ${name}` };
      }
      case 'pvp': {
        // pvp <player> [tier 0..1]  — tier names map to numbers
        const name = args[0];
        if (!name) return { ok: false, msg: 'usage: pvp <player> [rookie|medium|hard|0..1] [stop|hp <n>]' };
        const sub = String(args[1] || '').toLowerCase();
        if (sub === 'stop' || sub === 'off') {
          return this.pvp && this.pvp.running ? this.pvp.stop('command') : { ok: false, msg: 'pvp not running' };
        }
        if (sub === 'hp') {
          if (!this.pvp || !this.pvp.running) return { ok: false, msg: 'pvp not running' };
          const n = parseFloat(args[2]);
          if (!Number.isFinite(n)) return { ok: false, msg: 'usage: pvp <player> hp <n>' };
          return this.pvp.setHealth(n);
        }
        const tier = TIERNAMES[sub] != null ? TIERNAMES[sub] : (parseFloat(sub) || 0.5);
        const pl = bot.players && bot.players[name];
        if (!pl || !pl.entity) return { ok: false, msg: `cannot see player ${name}` };
        if (!this.pvp) this.pvp = new PvpController(bot, { logger: this.log, actor: this, config: this.cfg });
        // take the bot out of any pathing goal so the two never fight
        this._clearGoal();
        this.mode = 'pvp';
        return this.pvp.start(name, tier);
      }
      default:
        return { ok: false, msg: `mode ${mode} not implemented` };
    }
  }

  /* ------------------------------------------------------------------ *
   * async behaviour loops
   * ------------------------------------------------------------------ */

  async wanderLoop() {
    const bot = this.bot;
    const radius = this._wanderRadius || 64;
    while (this.mode === 'wander' && !this.destroyed) {
      const target = this._randomReachable(radius);
      if (!target) {
        this.log.debug('actor: no wander target found, waiting');
        await sleep(5000); continue;
      }
      this.goalDesc = { type: 'near', x: target.x, y: target.y, z: target.z, range: 2 };
      this._applyGoal(false);
      const deadline = Date.now() + (this.cfg.goalTimeoutMs || 300000);
      while (this.mode === 'wander' && this.goalDesc && Date.now() < deadline) {
        await sleep(1000);
      }
      const delay = (this.cfg.wander && this.cfg.wander.minDelayMs) || 2500;
      await sleep(delay);
    }
  }

  async gatherLoop(radius) {
    const bot = this.bot;
    const maxLogs = (this.cfg.gather && this.cfg.gather.maxLogs) || 128;
    const s = this.cfg.survive || {};
    // Monsters only spawn in darkness, so gathering at night on a hostile
    // server is a coin flip between progress and a death loop. Unless the
    // survival layer is explicitly off, wait out the night near home instead
    // of feeding logs to zombies. This is what makes gather reliable.
    const nightSafe = s.enabled !== false;
    let chopped = 0;
    let nightWaitSince = 0;
    while (this.mode === 'gather' && !this.destroyed) {
      // ---- night gate: the explicit-reason exit the user asked for ----
      if (nightSafe && isNight(bot)) {
        const hostiles = countHostiles(bot, 32);
        if (hostiles > 0) {
          if (!nightWaitSince) {
            nightWaitSince = Date.now();
            this.log.warn('actor: night + hostiles nearby, waiting out the dark near home', {
              hostiles, timeOfDay: bot.time && bot.time.timeOfDay
            });
            this.goalDesc = this.home
              ? { type: 'near', x: this.home.x, y: this.home.y, z: this.home.z, range: 4 }
              : null;
            this._applyGoal(false);
          }
          // Do NOT give up on the goal: dawn is at most ~7 min away. Wait, and
          // let the survival layer defend if something finds us.
          await sleep(5000);
          continue;
        }
        nightWaitSince = 0;
      } else {
        nightWaitSince = 0;
      }

      let logs = [];
      try {
        logs = bot.findBlocks({
          matching: isLog,
          maxDistance: radius,
          count: 48,
          minDistance: 2
        });
      } catch (e) {
        this.log.warn('actor: findBlocks failed', { error: e.message });
        await sleep(5000); continue;
      }
      if (!logs.length) {
        // Widen before giving up: the caller's radius may just be smaller than
        // the nearest stand of trees. Only go AFK if the doubled sweep fails.
        try {
          logs = bot.findBlocks({ matching: isLog, maxDistance: radius * 2, count: 48, minDistance: 2 });
        } catch (_) {}
        if (!logs.length) {
          this.log.info('actor: no wood in range (even doubled), switching to AFK', { radius, doubled: radius * 2 });
          this.setMode('afk');
          return;
        }
        this.log.debug('actor: wood found on the wider sweep', { radius, found: logs.length });
      }
      // nearest first
      const eye = bot.entity.position;
      logs.sort((a, b) => a.distanceTo(eye) - b.distanceTo(eye));

      for (const base of logs) {
        if (this.mode !== 'gather' || this.destroyed) return;
        if (chopped >= maxLogs) {
          this.log.info('actor: log budget reached, coming home', { chopped });
          this.setMode('come');
          return;
        }
        if (inventoryFullOfLogs(bot)) {
          this.log.info('actor: inventory full of logs, coming home');
          this.setMode('come');
          return;
        }
        try {
          await this.chopTree(base);
          chopped += this._lastChopCount || 1;
          // Exposed via snapshot() so the TUI and live tests can see progress
          // instead of guessing from the log stream.
          this.logsChopped = (this.logsChopped || 0) + (this._lastChopCount || 1);
        } catch (e) {
          this.log.debug('actor: chop failed', { error: e.message });
        }
        await sleep(400);
      }
    }
  }

  /** Chop a whole tree: BFS over connected logs from `base`, dig each. */
  async chopTree(base) {
    const bot = this.bot;
    const queue = [bot.blockAt(base)];
    const seen = new Set();
    let count = 0;
    const maxBlocks = 64;
    while (queue.length && count < maxBlocks && this.mode === 'gather' && !this.destroyed) {
      const block = queue.shift();
      if (!block || !isLog(block)) continue;
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // walk to the tree first (pathfinder handles the whole route).
      // A short budget keeps one unreachable tree from stalling the loop.
      // GoalGetToBlock demands a voxel directly adjacent to the log, which is
      // often inside the trunk; GoalNear on a *standing spot beside* the log
      // reliably stops the bot within dig reach instead. Targeting the trunk
      // itself makes pathfinder route into pits/branches it cannot escape.
      const stand = standableSpotNear(bot, block.position);
      this.goalDesc = {
        type: 'near',
        x: stand ? stand.x : block.position.x,
        y: stand ? stand.y : block.position.y,
        z: stand ? stand.z : block.position.z,
        range: 2
      };
      this._applyGoal(false);
      await this._awaitGoal((this.cfg.gather && this.cfg.gather.approachMs) || 15000);
      if (this.goalDesc) {
        // never got there — skip this tree rather than hang on it
        this.log.debug('actor: could not reach tree, skipping', { at: key });
        this._clearGoal();
        continue;
      }

      await this.equipToolFor(block.name);
      try {
        await bot.dig(block, true);
        count++;
      } catch (e) {
        this.log.debug('actor: dig failed', { error: e.message, block: block.name });
        break;
      }
      // expand to neighbours (logs and leaves are climbable/choppable context)
      for (const d of NEIGHBOURS) {
        const np = block.position.offset(d[0], d[1], d[2]);
        const nb = bot.blockAt(np);
        if (nb && (isLog(nb) || isLeaf(nb))) queue.push(nb);
      }
      if (count % 8 === 0) await sleep(200);   // be gentle on slow CPUs
    }
    this._lastChopCount = count;
    if (count > 0) this.log.info('actor: chopped tree', { logs: count });
    else this.log.debug('actor: tree yielded nothing reachable');
  }

  /* Keep moving away from the threat until we are safe. Without this the
   * bot flees once, then stands still and gets finished off. */
  async fleeLoop() {
    const bot = this.bot;
    let recomputeAt = 0;
    while (this.mode === 'flee' && !this.destroyed) {
      const threat = nearestHostile(bot, 24);
      const s = this.cfg.survive || {};
      const h = bot.health != null ? bot.health : 20;
      if (!threat || h >= (s.fleeHealth != null ? s.fleeHealth : 10) + 6) {
        this.log.info('actor: safe again, resuming', { mode: this.prevMode, health: +h.toFixed(1) });
        this.setMode(this.prevMode || 'afk');
        return;
      }
      // refresh the escape route every few seconds as the threat follows
      if (bot.entity && Date.now() > recomputeAt) {
        recomputeAt = Date.now() + 3000;
        const away = bot.entity.position.scale(2).minus(threat.position);
        const y = topSolidY(bot, Math.floor(away.x), Math.floor(away.z), Math.floor(bot.entity.position.y)) || Math.floor(bot.entity.position.y);
        this.goalDesc = { type: 'near', x: Math.floor(away.x), y, z: Math.floor(away.z), range: 3 };
        this._applyGoal(true);
      }
      await sleep(400);
    }
  }

  async fightLoop() {
    const bot = this.bot;
    const startedAt = Date.now();
    let swaps = 0, lastTarget = null;
    while (this.mode === 'fight' && !this.destroyed) {
      const target = this._fightTarget;
      const e = typeof target === 'function' ? target() : target;
      if (!e || !e.isValid || (e.position && bot.entity.position.distanceTo(e.position) > 48)) {
        this.log.info('actor: target lost, returning to previous mode');
        this.setMode(this.prevMode || 'afk');
        return;
      }
      // If we keep getting bounced to new targets (a swarm), fighting is not
      // going to end. After ~20s give up the offence and run for home, which
      // is how a player behaves at night — otherwise gather is impossible.
      if (lastTarget && lastTarget !== e) swaps++;
      lastTarget = e;
      const tooLong = Date.now() - startedAt > 20000;
      const swarmed = swaps > 4;
      if (tooLong || swarmed) {
        this.log.warn('actor: overwhelmed, retreating home', { swaps, seconds: +((Date.now() - startedAt) / 1000).toFixed(1) });
        // Retreat, then go back to whatever we were doing once it is safe —
        // giving up on the whole goal because of one bad night is the
        // "stuck halfway" failure this bot exists to avoid.
        this.prevMode = this._preGoalMode || this.prevMode || 'afk';
        this.mode = 'flee';
        this.stuckAttempts = 0;
        if (this.home) {
          this.goalDesc = { type: 'near', x: this.home.x, y: this.home.y, z: this.home.z, range: 3 };
          this._applyGoal(false);
        }
        this.fleeLoop().catch(e2 => this.log.debug('flee loop ended', { error: e2.message }));
        return;
      }
      try { bot.lookAt(e.position.offset(0, 1.2, 0), true); } catch (_) {}
      const dist = bot.entity.position.distanceTo(e.position);
      if (dist > 2.6) {
        this.goalDesc = { type: 'follow', range: 1, reach: 2, resolve: () => e };
        if (!bot.pathfinder || !currentGoal(bot)) this._applyGoal(true);
      } else {
        try { if (!this._attackCd || Date.now() - this._attackCd > 600) { await bot.attack(e); this._attackCd = Date.now(); } } catch (_) {}
      }
      await sleep(300);
    }
  }

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */

  _randomReachable(radius) {
    const bot = this.bot;
    const origin = this.home || (bot.entity ? bot.entity.position.floored() : null);
    if (!origin) return null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 12 + Math.random() * radius;
      const x = Math.floor(origin.x + Math.cos(ang) * dist);
      const z = Math.floor(origin.z + Math.sin(ang) * dist);
      const y = topSolidY(bot, x, z, origin.y);
      if (y == null) continue;
      return { x, y, z };
    }
    return null;
  }

  async _awaitGoal(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.goalDesc && Date.now() < deadline && !this.destroyed) {
      await sleep(500);
      if (!this.bot.pathfinder || !isPathingNow(this.bot)) break;
    }
  }

  async equipToolFor(blockName) {
    const bot = this.bot;
    if (typeof bot.equip !== 'function') return;
    const want = /log|wood|plank|stem/.test(blockName) ? '_axe' :
      /stone|cobble|ore|deepslate|granite|diorite|andesite|netherrack|brick|obsidian/.test(blockName) ? '_pickaxe' : null;
    if (!want) return;
    const items = bot.inventory.items().filter(i => i.name.endsWith(want));
    if (!items.length) return;
    items.sort((a, b) => toolTier(a.name) - toolTier(b.name));
    try { await bot.equip(items[0], 'hand'); } catch (_) {}
  }

  /**
   * Craft an item from a known recipe. Best-effort: if the recipe is unknown
   * or the ingredients are missing, it throws with a reason so a task queue
   * can stop rather than pretend it succeeded.
   */
  async craftItem(name, count = 1) {
    const bot = this.bot;
    if (typeof bot.craft !== 'function') throw new Error('crafting is not available on this build');
    // mineflayer exposes recipesFor / recipesAll on the BOT (not the registry),
    // and the item lookup goes through registry.itemsByName.
    if (typeof bot.recipesFor !== 'function') throw new Error('no recipe lookup available on this build');
    const reg = bot.registry;
    if (!reg || !reg.itemsByName) throw new Error('no item registry available');
    const item = reg.itemsByName[name];
    if (!item) throw new Error(`unknown item: ${name}`);
    const recipes = bot.recipesFor(item, null, count, null);
    if (!recipes || !recipes.length) throw new Error(`no recipe for ${name} with what is in the inventory`);
    await bot.craft(recipes[0], count, null);
    this.log.info('actor: crafted', { item: name, count });
    return true;
  }

  /**
   * The headline multi-step task: turn trees into pickaxes.
   *
   * One wooden pickaxe needs 3 planks + 2 sticks = 5 planks, and each log
   * yields 4 planks, so 2 logs per pickaxe. The queue makes each step's
   * completion a precondition of the next — gather first, then planks, then
   * sticks, then the pickaxe — and stops with a reason if any step fails.
   */
  async makePickaxes(n = 1) {
    const { TaskQueue } = require('./tasks');
    const logsNeeded = Math.ceil((5 * n) / 4);
    const have = (want) => {
      const items = this.bot.inventory.items();
      return items.filter(i => i.name === want).reduce((s, i) => s + i.count, 0);
    };
    if (this.queue) this.queue.clear();
    const q = new TaskQueue(this);
    this.queue = q;
    q.add(`gather ${logsNeeded} logs`, async (actor) => {
      // gather runs until the budget is hit or there is no wood left.
      const radius = (actor.cfg.gather && actor.cfg.gather.radius) || 96;
      const max = (actor.cfg.gather && actor.cfg.gather.maxLogs) || 128;
      actor.cfg.gather = { ...(actor.cfg.gather || {}), maxLogs: Math.min(max, logsNeeded) };
      actor.setMode('gather', [radius]);
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline && !actor.destroyed) {
        if (have('oak_log') >= logsNeeded) { actor.setMode('afk'); return; }
        if (actor.mode !== 'gather') { actor.setMode('afk'); return; }
        await sleep(1000);
      }
      if (have('oak_log') < logsNeeded) throw new Error(`only ${have('oak_log')}/${logsNeeded} logs gathered`);
    });
    q.add(`craft ${4 * logsNeeded} oak_planks`, async (actor) => {
      const haveNow = have('oak_planks');
      if (haveNow >= 4 * logsNeeded) return;
      await actor.craftItem('oak_planks', 4 * logsNeeded - haveNow);
    });
    q.add(`craft ${2 * n} sticks`, async (actor) => {
      const haveNow = have('stick');
      if (haveNow >= 2 * n) return;
      await actor.craftItem('stick', 2 * n - haveNow);
    });
    q.add(`craft ${n} wooden_pickaxe`, async (actor) => {
      if (have('wooden_pickaxe') >= n) return;
      await actor.craftItem('wooden_pickaxe', n);
    });
    await q.start();
    return q.info;
  }

  async eat() {
    const bot = this.bot;
    if (this.eating || typeof bot.equip !== 'function') return false;
    const food = findFood(bot);
    if (!food) { this.log.debug('actor: nothing to eat'); return false; }
    this.eating = true;
    try {
      await bot.equip(food, 'hand');
      if (typeof bot.consume === 'function') await bot.consume();
      else if (typeof bot.activateItem === 'function') { bot.activateItem(); await sleep(1700); bot.deactivateItem(); }
      this.log.info('actor: ate', { item: food.name, food: bot.food });
      return true;
    } catch (e) {
      this.log.debug('actor: eat failed', { error: e.message });
      return false;
    } finally {
      this.eating = false;
    }
  }

  setHome(x, y, z) {
    this.home = { x, y, z };
    if (this.homeFile) {
      try { fs.writeFileSync(this.homeFile, JSON.stringify({ home: this.home }, null, 2)); } catch (_) {}
    }
    this.log.info('actor: home updated', { home: this.home });
    return { ok: true, msg: `Home set to ${x} ${y} ${z}` };
  }

  /* ------------------------------------------------------------------ *
   * tick: anti-stuck watchdog + survival layer
   * ------------------------------------------------------------------ */

  tick() {
    if (this.destroyed || !this.bot || !this.bot.entity) return;
    const now = Date.now();
    const bot = this.bot;
    const pos = bot.entity.position;

    const pathing = !!(this.goalDesc && isPathingNow(bot));
    const moved = this.lastPos ? pos.distanceTo(this.lastPos) > 0.2 : true;
    if (moved) { this.lastPos = pos.clone(); this.lastMoveAt = now; }
    this.lastPos = this.lastPos || pos.clone();
    // Treat "no movement yet" as movement when a goal was just issued, so the
    // path-computation window below is not mistaken for a stall.
    this.lastMoveAt = Math.max(this.lastMoveAt, this.goalStartedAt || 0);

    // A freshly set goal spends its first moments *computing* a path, not
    // walking. Counting that as a stall made the watchdog fire instantly and
    // burn every recovery attempt before the bot took a step — the bot then
    // gave up on goals it could trivially reach. Give the pathfinder a grace
    // period after each goal change before judging movement at all.
    const settled = this.goalStartedAt ? (now - this.goalStartedAt) > 2500 : true;

    if (pathing && settled && !moved && now - this.lastMoveAt > (this.cfg.stuckTimeoutMs || 6000)) {
      this.unstick();
    } else if (pathing && moved && now - this.lastMoveAt < 1000 && this.stuckAttempts > 0) {
      this.stuckAttempts = 0;     // moving again: forgive past stalls
    }

    // hard goal timeout
    if (pathing && this.goalStartedAt && now - this.goalStartedAt > (this.cfg.goalTimeoutMs || 300000)) {
      this.log.warn('actor: goal timed out, giving up', { timeoutMs: this.cfg.goalTimeoutMs || 300000 });
      this.setMode('afk');
    }

    // Run the survival layer whenever it is explicitly enabled OR the bot is
    // pursuing an active goal (see survivalTick): an undefended bot dies and
    // never completes its task.
    if (this.survive || this.mode !== 'afk') this.survivalTick(now);
  }

  unstick() {
    const bot = this.bot;
    this.stuckAttempts++;
    const attempt = this.stuckAttempts;
    const cap = this.cfg.maxStuckAttempts || 4;
    this.log.warn('actor: stuck, recovering', { attempt, mode: this.mode });

    if (attempt >= cap) {
      this.log.warn('actor: giving up after repeated stalls', { attempts: attempt });
      this.setMode('afk');
      return;
    }

    // 1) jump
    try {
      if (typeof bot.setControlState === 'function') {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 500);
      }
    } catch (_) {}

    // 2) clear whatever is directly in the way, if we are allowed to dig
    if (this.cfg.canDig !== false && typeof bot.dig === 'function') {
      try {
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.6, 0);
        const yaw = bot.entity.yaw || 0;
        const fwd = { x: eye.x - Math.sin(yaw), y: eye.y, z: eye.z + Math.cos(yaw) };
        const ahead = bot.blockAt(probe(Math.floor(fwd.x), Math.floor(eye.y), Math.floor(fwd.z)));
        const feet = bot.blockAt(probe(Math.floor(fwd.x), Math.floor(bot.entity.position.y), Math.floor(fwd.z)));
        const block = (ahead && ahead.name !== 'air') ? ahead : feet;
        if (block && block.name !== 'air' && block.name !== 'bedrock') {
          this.equipToolFor(block.name).then(() => bot.dig(block, true).catch(() => {}));
        }
      } catch (e) { this.log.debug('actor: unstick dig failed', { error: e.message }); }
    }

    // 3) re-plan from scratch, and if that keeps failing, invert the goal so
    //    the bot at least moves away from whatever corner it is in
    const desc = this.goalDesc;
    if (desc) {
      if (attempt === cap - 1) {
        this.goalDesc = { type: 'invert', inner: desc };
      }
      this._applyGoal(false);
    }
  }

  survivalTick(now) {
    const bot = this.bot;
    const s = this.cfg.survive || {};
    const health = bot.health != null ? bot.health : 20;
    const food = bot.food != null ? bot.food : 20;

    // Active goals (goto/wander/gather/...) need a baseline of self-defence:
    // a bot that dies mid-task never finishes, which is exactly the
    // "gets stuck halfway" failure this project exists to prevent. The
    // passive default (afk/hold) stays untouched unless survive is on.
    const active = this.mode !== 'afk' && this.mode !== 'hold' && this.mode !== 'come';
    const defend = active || this.survive;

    // flee when low — only when survival is enabled, or we are on an active goal
    if (defend && health < (s.fleeHealth != null ? s.fleeHealth : 10) && this.mode !== 'flee' && this.mode !== 'fight') {
      this.log.warn('actor: low health, fleeing', { health });
      this.prevMode = (this.mode === 'afk' || this.mode === 'hold') ? 'afk' : this.mode;
      this._preGoalMode = this.prevMode;
      this.mode = 'flee';
      this.stuckAttempts = 0;
      const threat = nearestHostile(bot, 16);
      if (threat && bot.entity) {
        const away = bot.entity.position.scale(2).minus(threat.position);
        const y = topSolidY(bot, Math.floor(away.x), Math.floor(away.z), Math.floor(bot.entity.position.y)) || Math.floor(bot.entity.position.y);
        this.goalDesc = { type: 'near', x: Math.floor(away.x), y, z: Math.floor(away.z), range: 4 };
        this._applyGoal(false);
      }
      this.fleeLoop().catch(e => this.log.debug('flee loop ended', { error: e.message }));
      if (food < 18) this.eat().catch(() => {});
    } else if (this.mode === 'flee' && health >= (s.fleeHealth != null ? s.fleeHealth : 10) + 6) {
      this.log.info('actor: recovered, resuming', { mode: this.prevMode });
      this.setMode(this.prevMode || 'afk');
    }

    // eat when hungry. Eating is not aggressive — a passive bot still needs
    // to not starve — so this runs whenever the survival layer is armed OR the
    // bot is on an active goal. (The default afk bot has survive off and
    // nothing to do, so it simply never gets hungry enough to matter.)
    const shouldEat = defend || this.survive;
    if (shouldEat && food < (s.eatAt != null ? s.eatAt : 16) && !this.eating && now - (this._lastEatAt || 0) > 8000) {
      this._lastEatAt = now;
      this.eat().catch(() => {});
    }

    // hit back
    if (defend && s.attack !== false && now - this.lastHurtAt < 4000 && this.mode !== 'fight' && this.mode !== 'flee') {
      const threat = nearestHostile(bot, 6);
      if (threat) {
        this.log.warn('actor: hit back', { mob: threat.name || threat.username });
        this.prevMode = this.mode;
        this.mode = 'fight';
        this._fightTarget = threat;
        this.fightLoop().catch(e => this.log.debug('fight loop ended', { error: e.message }));
      }
    }
  }

  destroy() {
    this.destroyed = true;
    try { this._clearGoal(); } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * text command parser (shared by the TUI input line and IPC)
   * ------------------------------------------------------------------ */

  exec(line) {
    const parts = String(line).trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const args = parts.slice(1);
    switch (cmd) {
      case '': return { ok: false, msg: 'empty command' };
      case 'afk': case 'stop': {
        if (this.pvp && this.pvp.running) this.pvp.stop('afk');
        return this.setMode('afk');
      }
      case 'hold': return this.setMode('hold');
      case 'goto': return this.setMode('goto', args);
      case 'come': return this.setMode('come');
      case 'follow': return this.setMode('follow', args);
      case 'wander': return this.setMode('wander', args);
      case 'gather': return this.setMode('gather', args);
      case 'craft': {
        // craft <item> [count] — best-effort; logs a reason if it can't.
        const name = args[0];
        const count = Math.max(1, parseInt(args[1], 10) || 1);
        if (!name) return { ok: false, msg: 'usage: craft <item> [count]' };
        this.craftItem(name, count).catch(e => this.log.warn('craft failed', { item: name, error: e.message }));
        return { ok: true, msg: `Crafting ${count}x ${name}` };
      }
      case 'pickaxe': {
        // The full chain the task queue exists for.
        const n = parseInt(args[0], 10) || 1;
        this.makePickaxes(n).catch(e => this.log.warn('pickaxe task failed', { error: e.message }));
        return { ok: true, msg: `Task queue: wood -> planks -> sticks -> ${n}x pickaxe` };
      }
      case 'attack': case 'kill': return this.setMode('attack', args);
      case 'pvp': return this.setMode('pvp', args);
      case 'eat': {
        this.eat().catch(() => {});
        return { ok: true, msg: 'eating' };
      }
      case 'home': {
        if (!args.length) {
          if (!this.home) return { ok: false, msg: 'no home known yet' };
          return { ok: true, msg: `home is ${this.home.x} ${this.home.y} ${this.home.z}` };
        }
        const p = parseCoords(args, this.bot);
        if (!p.ok) return { ok: false, msg: p.msg };
        return this.setHome(p.x, p.y, p.z);
      }
      case 'survive': {
        const on = ['on', 'true', '1', 'yes'].includes(String(args[0]).toLowerCase());
        this.survive = on;
        this.log.info('actor: survival layer toggled', { survive: on });
        return { ok: true, msg: `survival layer ${on ? 'on' : 'off'}` };
      }
      case 'help':
        return {
          ok: true,
          msg: 'commands: afk | hold | goto <x> [y] <z> | come | home [x y z] | ' +
               'follow <player> [range] | wander [radius] | gather [radius] | ' +
               'attack <name> | pvp <player> [rookie|medium|hard|0..1] [stop|hp <n>] | ' +
               'eat | survive on|off'
        };
      default:
        return { ok: false, msg: `unknown command: ${cmd} (try 'help')` };
    }
  }
}

const { PvpController } = require('./pvp');

const TIERNAMES = { rookie: 0, easy: 0.25, medium: 0.5, veteran: 0.75, hard: 1 };

const VALID_MODES = new Set(['afk', 'hold', 'goto', 'come', 'follow', 'wander', 'gather', 'attack', 'pvp']);

const NEIGHBOURS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
];

// Reusable scratch vectors: mineflayer's world accessor requires a real Vec3
// (it calls pos.floored()), and allocating one per probe would churn the GC
// badly inside the renderers and the wood-gathering loop.
const _scratch = new Vec3(0, 0, 0);
function probe(x, y, z) { _scratch.x = x; _scratch.y = y; _scratch.z = z; return _scratch; }

function describeGoal(desc) {
  if (!desc) return null;
  switch (desc.type) {
    case 'near': return `near ${desc.x} ${desc.y} ${desc.z} (±${desc.range})`;
    case 'block': return `block ${desc.x} ${desc.y} ${desc.z}`;
    case 'xz': return `xz ${desc.x} ${desc.z}`;
    case 'follow': return `follow (range ${desc.range})`;
    case 'getto': return 'get to block';
    case 'invert': return `invert(${describeGoal(desc.inner)})`;
    default: return desc.type;
  }
}

function parseCoords(args, bot) {
  const n = args.map(a => Number(a));
  const here = bot.entity ? bot.entity.position.floored() : { x: 0, y: 64, z: 0 };
  if (n.length >= 3 && n.every(Number.isFinite)) {
    return { ok: true, exact: true, x: n[0], y: n[1], z: n[2] };
  }
  if (n.length >= 2 && Number.isFinite(n[0]) && Number.isFinite(n[1])) {
    // x z — find the surface at that column
    const y = topSolidY(bot, n[0], n[1], here.y);
    if (y == null) return { ok: false, msg: `column ${n[0]} ${n[1]} is not loaded` };
    return { ok: true, exact: false, x: n[0], y: y + 1, z: n[1] };
  }
  return { ok: false, msg: 'usage: goto <x> <z>  or  goto <x> <y> <z>' };
}

/** True when the pathfinder is actively driving the bot toward a goal.
 * The real mineflayer-pathfinder exposes isMoving/isMining/isBuilding but has
 * no `isPathing` and no public `goal` property, so piece them together here. */
function isPathingNow(bot) {
  const pf = bot && bot.pathfinder;
  if (!pf) return false;
  // The real mineflayer-pathfinder exposes isMoving/isMining/isBuilding but no
  // isPathing() and no public .goal; it stores goal state in a closure. Compose
  // the real indicators. (Older code that called pf.isPathing() / pf.goal was
  // silently a no-op against a live server — see src/api_contract.json.)
  return (typeof pf.isMoving === 'function' && pf.isMoving()) ||
         (typeof pf.isMining === 'function' && pf.isMining()) ||
         (typeof pf.isBuilding === 'function' && pf.isBuilding());
}

function currentGoal(bot) {
  const pf = bot && bot.pathfinder;
  if (!pf) return null;
  return pf.goal != null ? pf.goal : null;
}

/** A safe place to stand while digging the block at `pos`: the nearest
 * adjacent column whose top is solid and two tall (head room). Prefers spots
 * at a similar height to the block so the bot does not have to climb. */
function standableSpotNear(bot, pos) {
  const x = pos.x, y = pos.y, z = pos.z;
  let best = null, bestScore = Infinity;
  for (const d of NEIGHBOURS) {
    if (!d[1]) continue;                       // only horizontal neighbours
    const nx = x + d[0], nz = z + d[2];
    const top = topSolidY(bot, nx, nz, y);
    if (top == null) continue;
    // need head room above the standing surface
    const head = safeBlockAt(bot, nx, top + 2, nz);
    if (head && head.name !== 'air' && head.boundingBox !== 'empty') continue;
    const score = Math.abs(top - y);
    if (score < bestScore) { bestScore = score; best = { x: nx, y: top + 1, z: nz }; }
  }
  return best;
}

function safeBlockAt(bot, x, y, z) {
  try { return bot.blockAt(probe(x, y, z)); } catch (_) { return null; }
}

function topSolidY(bot, x, z, refY) {
  // Highest non-empty block near reference height. Null if the column is
  // unloaded (mineflayer returns null for unloaded chunks).
  x = Math.floor(x); z = Math.floor(z);
  const world = bot.world;
  if (!world) return null;
  const base = Math.floor(refY == null ? 64 : refY);
  let loaded = true;
  try {
    if (world.getColumnAt) loaded = !!world.getColumnAt(probe(x, 0, z));
    else if (world.getBlock) loaded = world.getBlock(probe(x, 0, z)) != null;
  } catch (_) { loaded = false; }
  if (!loaded) return null;
  for (let y = Math.min(320, base + 24); y >= Math.max(-64, base - 24); y--) {
    let b = null;
    try { b = bot.blockAt(probe(x, y, z)); } catch (_) { return null; }
    if (b && b.name !== 'air' && b.boundingBox !== 'empty') return y;
  }
  return base;
}

function findEntityNamed(bot, name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  if (bot.players && bot.players[name] && bot.players[name].entity) return bot.players[name].entity;
  if (bot.entities) {
    for (const id in bot.entities) {
      const e = bot.entities[id];
      const nm = (e.username || e.name || '').toLowerCase();
      if (nm && nm === lower) return e;
    }
    // prefix match for mob types ("zombie", "creeper", ...)
    for (const id in bot.entities) {
      const e = bot.entities[id];
      const nm = (e.username || e.name || '').toLowerCase();
      if (nm && nm.includes(lower)) return e;
    }
  }
  return null;
}

function nearestHostile(bot, range) {
  if (!bot.entities || !bot.entity) return null;
  let best = null, bestD = range;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    // mineflayer sets e.kind to a human-readable string like "Hostile mobs"
    // and e.displayName to the entity name (e.g. "Zombie"), so match both
    // case-insensitively against the hostile set. (e.mobType is deprecated.)
    const mobType = String(e.displayName || e.name || '').toLowerCase();
    const hostile = e.kind === 'hostile' || /hostile/.test(String(e.kind || '')) || HOSTILE_MOBS.has(mobType);
    if (!hostile) continue;
    const d = bot.entity.position.distanceTo(e.position);
    if (d <= bestD) { bestD = d; best = e; }
  }
  return best;
}

/** Count hostiles within `range`. Used by the gather night gate to decide
 *  whether the dark is actually dangerous right now (it can be night with
 *  nothing nearby, in which case chopping is fine). */
function countHostiles(bot, range) {
  if (!bot.entities || !bot.entity) return 0;
  let n = 0;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    const mobType = String(e.displayName || e.name || '').toLowerCase();
    const hostile = /hostile/.test(String(e.kind || '')) || HOSTILE_MOBS.has(mobType);
    if (!hostile) continue;
    if (bot.entity.position.distanceTo(e.position) <= range) n++;
  }
  return n;
}

function findFood(bot) {
  const items = bot.inventory.items();
  const reg = bot.registry;
  if (reg && reg.foodsByName) {
    const f = items.find(i => !!reg.foodsByName[i.name]);
    if (f) return f;
  }
  return items.find(i => FALLBACK_FOODS.has(i.name)) || null;
}

function inventoryFullOfLogs(bot) {
  const items = bot.inventory.items();
  const logs = items.filter(i => LOG_BLOCKS.has(i.name) || /_log$/.test(i.name));
  const slots = items.reduce((n, i) => n + (i.stackSize >= 64 ? 1 : 0), 0);
  return logs.length > 0 && slots >= 35;
}

module.exports = {
  Actor, VALID_MODES, describeGoal, isPathingNow, currentGoal,
  isNight, nearestHostile, countHostiles
};
