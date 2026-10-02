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
 *                          JUMPS (forward + jump held together, which is the
 *                          only combination that clears a step), clears whatever
 *                          is in the way, climbs out of holes, and re-plans.
 *                          After repeated failure it gives up cleanly instead
 *                          of spinning forever.
 *   4. Survival layer    — opt-in reactive layer that runs on top of any mode:
 *                          auto-eat when hungry, flee when low, hit back when
 *                          hit, auto-respawn on death. Escape routes are scored
 *                          against the actual terrain (see src/terrain.js)
 *                          instead of assumed flat.
 *
 * Everything is opt-in. With the shipped config the bot behaves exactly like
 * the passive AFK bot it was before.
 */

const fs = require('fs');
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const T = require('./terrain');
const M = require('./movement');
const { DamageTracker, ownGameMode, isUnkillable, gameModeOf, findByUsername, hearts } = require('./perceive');
const { JevClient } = require('./jev');

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

    // Perception: real damage/health/gamemode signals from the server, so no
    // behaviour has to decide "did I win?" from arithmetic alone.
    this.tracker = null;

    // External structured-decision advisor (src/jev.js). Constructed only when
    // the config asks for it, so the default configuration makes no network
    // calls and no behaviour depends on a third-party endpoint being up.
    this.jev = null;
    if (this._jevEnabled()) {
      const a = this.cfg.ai || {};
      this.jev = new JevClient({
        logger: this.log,
        enabled: true,
        url: a.url,
        ttlMs: a.ttlMs,
        cooldownMs: a.cooldownMs
      });
    }

    this._wire();
  }

  /**
   * AI is opt-in: only when cfg.ai.pvp (or cfg.ai.mode) names a mode. Off by
   * default so a fresh install never reaches the network.
   */
  _jevEnabled() {
    const a = this.cfg.ai;
    if (!a) return false;
    const mode = typeof a === 'string' ? a : (a.pvp || a.mode);
    return !!mode && mode !== 'off';
  }

  /** AI mode string for the current config ('off' | 'assist' | 'force'). */
  get aiMode() {
    const a = this.cfg.ai;
    if (!a) return 'off';
    const mode = typeof a === 'string' ? a : (a.pvp || a.mode);
    return mode && mode !== 'off' ? mode : 'off';
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
    // One tracker per connection. It subscribes to entity events, so a tracker
    // left attached to a dead bot would keep scoring a fight that ended and
    // report health signals for entities the server has already forgotten.
    if (this.tracker) { try { this.tracker.destroy(); } catch (_) {} }
    this.tracker = new DamageTracker(bot, {
      logger: this.log,
      reach: (this.cfg.pvp && this.cfg.pvp.reach) || 3
    });

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
      // Optional-chained: a config with no `survive` block at all used to throw
      // here while handling a death, which is the worst possible moment to throw.
      const sv = this.cfg.survive || {};
      if (this.survive && sv.autoRespawn !== false) {
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
      // Re-resolve the standing height: a drop lies on the floor, and the
      // approach from world spawn can start at a completely different level.
      const y = topSolidY(this.bot, target.x, target.z, target.y);
      this.goalDesc = { type: 'near', x: target.x, y: y == null ? target.y : y + 1, z: target.z, range: 3 };
      this.goalStartedAt = Date.now();
      this._applyGoal(false);
      await this._awaitGoal(90000);
      this.log.info('actor: reached death point', { at: target });
      this._pickupAround(5);
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

  /**
   * Build a flee goal that the bot can actually reach.
   *
   * The old escape vector was `position*2 - threat`: pure x/z arithmetic that
   * never looked at the world. On any map with relief it lands in a gully, on a
   * ledge, or beyond a cliff the pathfinder will not descend — and when the
   * pathfinder answers `path_stop`, the mode stayed set and the bot stood still
   * while being eaten. `T.escapeSpot` scores a ring of candidate cells against
   * the real terrain (distance from the threat, climbability, and whether the
   * cell has any exit that is not the way we came), so the bot runs somewhere it
   * can be.
   *
   * Home is preferred when it is a plausible escape, because a base is usually
   * lit and walled for exactly this reason.
   */
  _fleeGoal(threat, opts = {}) {
    const bot = this.bot;
    if (!bot.entity) return null;
    const s = this.cfg.survive || {};
    if (this.home) {
      const hd = Math.hypot(this.home.x - bot.entity.position.x, this.home.z - bot.entity.position.z);
      const gap = threat ? Math.hypot(this.home.x - threat.position.x, this.home.z - threat.position.z) : 99;
      if (hd <= (s.homeFleeMaxDist != null ? s.homeFleeMaxDist : 40) && gap > hd) {
        return { type: 'near', x: this.home.x, y: this.home.y, z: this.home.z, range: 3 };
      }
    }
    if (!threat) return null;
    const spot = T.escapeSpot(bot, bot.entity.position, threat.position, {
      radius: opts.radius || 12,
      minGap: opts.minGap || 5
    });
    if (!spot) return null;
    return { type: 'near', x: spot.x, y: spot.y, z: spot.z, range: 2 };
  }

  /** Start a flee: set the mode, aim at reachable ground, and run the loop. */
  _beginFlee(threat, why) {
    const bot = this.bot;
    this.prevMode = (this.mode === 'afk' || this.mode === 'hold') ? 'afk' : this.mode;
    this._preGoalMode = this.prevMode;
    this.mode = 'flee';
    this.stuckAttempts = 0;
    this._recoverMark = bot.entity ? bot.entity.position.clone() : null;
    this.fleeCount = (this.fleeCount || 0) + 1;
    const goal = this._fleeGoal(threat);
    if (goal) {
      this.goalDesc = goal;
      this._applyGoal(false);
    }
    this.log.warn('actor: fleeing', Object.assign({
      why: why || 'damage',
      health: +(bot.health != null ? bot.health : 20).toFixed(1),
      hearts: hearts(bot.health),
      threat: threat ? (threat.username || threat.name || threat.displayName) : null,
      to: goal ? `${goal.x} ${goal.y} ${goal.z}` : 'no reachable escape found (holding)' 
    }, {}));
    this.fleeLoop().catch(e => this.log.debug('flee loop ended', { error: e.message }));
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

    const fleeHealth = s.fleeHealth != null ? s.fleeHealth : 10;
    const night = isNight(bot);
    const nightRadius = s.nightFleeRadius != null ? s.nightFleeRadius : 12;

    // At night a melee mob closes from spawning range to hitting range faster
    // than a 20-tick poll notices, so the bar for running is lower — but only
    // when it is actually worth running. The previous condition was
    // `night && h < fleeHealth + 4` while the comment claimed it fled "even at
    // full health", and the effect people reported was the opposite of the
    // intent: the bot bolted from fights it had already won. So: at night, flee
    // a close hostile only when we are hurt OR outnumbered OR unarmed; otherwise
    // stand and swing.
    if (night) {
      const close = nearestHostile(bot, nightRadius);
      if (close) {
        const crowd = countHostiles(bot, nightRadius) >= 2;
        const armed = !!(bot.heldItem && /sword|axe/.test(bot.heldItem.name || ''));
        const shouldRun = h < fleeHealth + 4 || crowd || !armed && h < 20;
        if (shouldRun) {
          this.log.warn('actor: hostile close at night', {
            mob: close.name || close.username,
            crowd,
            armed,
            distance: +bot.entity.position.distanceTo(close.position).toFixed(1)
          });
          this._beginFlee(close, 'night hostile');
          return;
        }
      }
    }

    // Low health => run first, ask questions later.
    if (h < fleeHealth) {
      const threat = nearestHostile(bot, 18);
      this._beginFlee(threat, `health ${+h.toFixed(1)}`);
      return;
    }

    // Otherwise hit the thing that is hitting us.
    if (s.attack !== false && Date.now() - (this._lastFightArm || 0) > 1500) {
      const threat = nearestHostile(bot, 6);
      if (threat) {
        this.log.warn('actor: hit back', {
          mob: threat.name || threat.username,
          health: +h.toFixed(1),
          hearts: hearts(h),
          distance: bot.entity ? +bot.entity.position.distanceTo(threat.position).toFixed(1) : null
        });
        this._beginFight(threat, 'hit back');
      }
    }
  }

  /**
   * Start (or retarget) a fight. Kept in one place so `onHealth`, the tick
   * watchdog and a cornered flee all arm the same loop rather than each
   * inventing their own copy of the state machine.
   */
  _beginFight(target, why) {
    const bot = this.bot;
    this.prevMode = (this.mode === 'afk' || this.mode === 'hold') ? (this.prevMode || 'afk') : this.mode;
    this._preGoalMode = this.prevMode;
    this.mode = 'fight';
    this.stuckAttempts = 0;
    this._lastFightArm = Date.now();
    this._fightTarget = target;
    this._fightStartedAt = Date.now();
    this._lastFightStep = 0;
    this.hitCount = (this.hitCount || 0) + 1;
    if (this.tracker && target && target.id != null) this.tracker.setTarget(target);
    this.log.info('actor: engaging', { why: why || 'order', mob: target && (target.username || target.name || target.displayName) });
    this.fightLoop().catch(e => this.log.debug('fight loop ended', { error: e.message }));
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

      /* Terrain budget.
       *
       * What is actually adjustable, verified against the installed sources
       * rather than assumed:
       *   - mineflayer-pathfinder/lib/movements.js hard-codes
       *       if (blockC.height - block0.height > 1.2) return
       *     in two places, so a route may *plan* a 1-block climb and never a
       *     2-block one, with no knob to change that. prismarine-physics has no
       *     maxJumpHeight; `bot.physics.gravity` is a plain number (0.08).
       *   - `movements.maxDropDown` is a real knob (default 4), and it is the
       *     source of the asymmetry the user reported: the pathfinder happily
       *     plans a 4-block drop, then cannot plan the 2-block climb back out.
       *     That is precisely "gets stuck as soon as it falls by one or more
       *     blocks": it falls, and the only route is a wall it will not scale.
       *
       * So: cap the descent at what does not cost health (a 3-block drop is the
       * start of fall damage, so 2), and let anything taller than a single step
       * be handled by the direct controller's jump-sneak block-hop
       * (movement.climbOut), which is the only way to actually leave a 2-deep
       * hole. Scaffolding (`allow1by1towers`) can also solve it, but only with
       * dirt or cobble in the inventory, so it is a bonus, not a plan. */
      const mcfg = this.cfg.movements || {};
      const dropCap = mcfg.maxDropDown != null ? mcfg.maxDropDown : 2;
      try { movements.maxDropDown = dropCap; } catch (_) {}
      // Never path through lava/fire; keep digging on, but make it cost something
      // so the pathfinder prefers a route around a wall to tunneling through it.
      if (mcfg.digCost != null) { try { movements.digCost = mcfg.digCost; } catch (_) {} }
      if (mcfg.liquidCost != null) { try { movements.liquidCost = mcfg.liquidCost; } catch (_) {} }
      if (mcfg.scaffold !== false) { try { movements.allow1by1towers = true; } catch (_) {} }
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

  /**
   * Ground-level destination for an anti-idle shuffle step. Returns null when
   * there is no solid footing at that column, so the caller skips the step
   * instead of pathing into a wall or off a cliff.
   */
  antiIdleTarget(x, z) {
    const bot = this.bot;
    if (!bot || !bot.entity) return null;
    const y = topSolidY(bot, x, z, Math.floor(bot.entity.position.y));
    if (y == null) return null;
    // GoalBlock/GoalNear nodes are *foot* positions, so the standing cell is one
    // above the surface block. Handing back the surface itself asks the bot to
    // stand inside the ground: the pathfinder finds no route, emits path_stop,
    // and the anti-idle shuffle freezes the bot in place.
    const stand = y + 1;
    // A shuffle step must be trivially walkable. Anything that would be a 2-block
    // climb, a drop, or a head-bump is refused, because an anti-idle nudge that
    // wanders off a cliff is worse than being kicked for idling.
    const rise = Math.abs(stand - Math.floor(bot.entity.position.y));
    if (rise > 1) return null;
    const there = T.columnInfo(bot, x, z, bot.entity.position.y);
    if (!there || there.headBlocked) return null;
    if (there.dropBeyond > 2) return null;
    return { x, y: stand, z };
  }

  /** Hostile count near the bot, exposed for the PvP controller's world facts. */
  countHostilesNear(range) { return countHostiles(this.bot, range || 16); }

  /**
   * How the last (or current) duel ended, with the evidence. Both `result` and
   * `pvp <name> result` reach this, so a CLI caller never has to guess which
   * spelling exists.
   */
  pvpSummary() {
    if (!this.pvp) return { ok: false, msg: 'no pvp fight recorded yet' };
    const s = this.pvp.summary();
    return {
      ok: true,
      msg: `${s.result || 'running'} — ${s.resultReason || ''} ` +
           `(swings ${s.counts.swings}, confirmed ${s.counts.confirmedHits}, no-effect ${s.counts.swingsWithNoEffect}, ` +
           `they hit us ${s.counts.hitsTakenByUs}; opponent ${s.opponent.healthEstimate} hp est = ${s.opponent.estimateHearts} hearts, ${s.opponent.gamemode})`,
      data: s
    };
  }

  /* ------------------------------------------------------------------ *
   * modes
   * ------------------------------------------------------------------ */

  get info() {
    const p = this.bot.entity ? this.bot.entity.position : null;
    const s = this.bot;
    return {
      mode: this.mode,
      goal: this.goalDesc ? describeGoal(this.goalDesc) : null,
      goalStartedAt: this.goalStartedAt || null,
      stuckAttempts: this.stuckAttempts,
      survive: this.survive,
      home: this.home,
      pos: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null,
      queue: this.queue ? this.queue.info : null,
      deathPos: this.deathPos || null,
      // Health in the unit players actually use, with the source of the number.
      health: s.health != null ? +s.health.toFixed(1) : null,
      hearts: hearts(s.health),
      food: s.food != null ? s.food : null,
      gamemode: ownGameMode(s) || null,
      // What the bot is actually holding: the CLI's `--explain` and the duel
      // panel need it to state weapon damage truthfully, and a missing field here
      // showed up as "my weapon fist does ~1 damage" for a bot holding a diamond
      // sword — a confidently wrong line in a debug tool is worse than no line.
      heldItem: s.heldItem ? { name: s.heldItem.name, durability: s.heldItem.maxDurability
        ? (s.heldItem.maxDurability - (s.heldItem.durabilityUsed || 0)) : null } : null,
      ground: p ? this._groundFacts() : null,
      ai: this.aiMode,
      pvp: this.pvp ? this.pvp.summary() : null
    };
  }

  /** What the terrain immediately around the bot looks like — for the TUI/CLI. */
  _groundFacts() {
    const bot = this.bot;
    try {
      const p = bot.entity.position;
      const here = T.columnInfo(bot, Math.floor(p.x), Math.floor(p.z), p.y);
      const ahead = M.probeAlong(bot, M.basis(bot).fx, M.basis(bot).fz);
      const exit = M.bestExitDirection(bot, { hop: true });
      return {
        surface: here ? here.surface : null,
        standY: here ? here.y : null,
        feetAboveSurface: here ? +(p.y - (here.surface + 1)).toFixed(2) : null,
        aheadRise: ahead ? ahead.rise : null,
        aheadDrop: ahead ? ahead.drop : null,
        onGround: M.onGround(bot),
        inWater: M.inWater(bot),
        climbing: !!(exit && exit.rise >= 1),
        exitRise: exit ? exit.rise : null
      };
    } catch (_) { return null; }
  }

  /**
   * Observed facts about another player: their game mode and any real health
   * signal. This is what answers "can I even hit them?" without guessing, and
   * what the CLI exposes as `mc hearts <name>`.
   */
  observePlayer(name) {
    const bot = this.bot;
    const pl = bot.players && (bot.players[name] || findByUsername(bot.players, name));
    if (!pl) return { ok: false, msg: `no such player: ${name}` };
    const gm = gameModeOf(bot, name);
    const v = pl.entity && this.tracker ? this.tracker.of(pl.entity) : null;
    return {
      ok: true,
      msg: `${name}: gamemode ${gm || 'unknown'}, health ${v ? v.health + ' (' + (v.source === 'server' ? 'observed' : 'estimated') + ')' : 'unknown'}, hearts ${v ? v.hearts : '?'}`,
      data: {
        name,
        gamemode: gm,
        visible: !!pl.entity,
        distance: pl.entity && bot.entity ? +bot.entity.position.distanceTo(pl.entity.position).toFixed(1) : null,
        vitals: v ? v.snapshot() : null,
        killable: gm ? !isUnkillable(gm) : null
      }
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
        // p.exact means the operator typed all three coordinates. Those are
        // honoured literally (GoalBlock), NOT snapped: a live run printed
        // "Going to -40 159 22" after the user asked for `-40 60 22`, because
        // _snapToStandable moved an explicit Y to the surface under the column.
        // Moving a coordinate the user chose is a silent override, and "the goal
        // is unreachable" is the honest answer when it is. Two-coordinate goals
        // (x z) ARE derived from the surface, so they still get snapped.
        this.goalDesc = p.exact
          ? { type: 'block', x: p.x, y: p.y, z: p.z }
          : this._snapToStandable({ type: 'near', x: p.x, y: p.y, z: p.z, range: this.cfg.gotoRange || 3 });
        if (!this._applyGoal(false)) return { ok: false, msg: 'pathfinder unavailable' };
        this.log.info('actor: going to', {
          target: { x: this.goalDesc.x, y: this.goalDesc.y, z: this.goalDesc.z },
          exact: !!p.exact,
          adjusted: this.goalDesc.x !== p.x || this.goalDesc.y !== p.y || this.goalDesc.z !== p.z
        });
        return {
          ok: true,
          msg: `Going to ${this.goalDesc.x} ${this.goalDesc.y} ${this.goalDesc.z}` +
            (this.goalDesc.y !== p.y ? ` ${'(asked for y ' + p.y + ', surface is ' + this.goalDesc.y + ')'}` : '')
        };
      }
      case 'come': {
        if (!this.home) return { ok: false, msg: 'no home known yet' };
        this.goalDesc = this._snapToStandable({ type: 'near', x: this.home.x, y: this.home.y, z: this.home.z, range: 3 });
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
        if (!name) return { ok: false, msg: 'usage: pvp <player> [rookie|medium|hard|0..1] [stop|hp <n>|result|ai <mode>] [ai off|assist|force]' };
        const sub = String(args[1] || '').toLowerCase();
        if (sub === 'stop' || sub === 'off') {
          return this.pvp && this.pvp.running ? this.pvp.stop('command') : { ok: false, msg: 'pvp not running' };
        }
        if (sub === 'result' || sub === 'summary') return this.pvpSummary();
        if (sub === 'hp') {
          if (!this.pvp || !this.pvp.running) return { ok: false, msg: 'pvp not running' };
          const n = parseFloat(args[2]);
          if (!Number.isFinite(n)) return { ok: false, msg: 'usage: pvp <player> hp <n>' };
          return this.pvp.setHealth(n);
        }
        // `pvp <name> ai assist|force|off` — change the advisor mid-fight
        if (sub === 'ai') {
          const mode = String(args[2] || 'assist').toLowerCase();
          this.cfg.ai = mode === 'off' ? 'off' : { ...(this.cfg.ai || {}), pvp: mode };
          if (mode !== 'off' && !this.jev) this.jev = new JevClient({ logger: this.log, enabled: true, url: (this.cfg.ai || {}).url });
          if (this.pvp) { this.pvp.ai = this.aiMode; this.pvp.jev = this.jev; }
          return { ok: true, msg: `ai advisor: ${this.aiMode}` };
        }
        const tier = TIERNAMES[sub] != null ? TIERNAMES[sub] : (parseFloat(sub) || 0.5);
        const pl = bot.players && bot.players[name];
        if (!pl || !pl.entity) return { ok: false, msg: `cannot see player ${name}` };
        if (!this.pvp) {
          this.pvp = new PvpController(bot, {
            logger: this.log,
            actor: this,
            config: this.cfg,
            tracker: this.tracker,
            jev: this.jev
          });
        }
        // A reconnect replaces the bot, and with it the tracker: re-inject so the
        // controller is never reading a Vitals object that belongs to a dead
        // connection. Without this the controller falls back to its own private
        // estimate and the observed-signals fix silently stops applying — which
        // is exactly the "fled a fight it had won" bug.
        if (this.pvp.tracker !== this.tracker) {
          this.pvp.tracker = this.tracker;
          this.pvp.vitals = this.tracker && this.tracker.of(pl.entity) || this.pvp.vitals;
        }
        if (!this.pvp.jev) this.pvp.jev = this.jev;
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
      const stand = T.standableSpotNear(bot, block.position);
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

  /* Keep moving away from the threat until we are safe. Without this the bot
   * flees once, then stands still and gets finished off.
   *
   * Terrain-aware: it re-picks a *reachable* escape cell every few seconds
   * rather than refreshing one arithmetic vector, and when nothing reachable
   * exists (a box, a ledge with one way out) it stops pretending to flee and
   * defends instead. A bot that walks into a wall while holding 'forward' is
   * not fleeing, it is dying with extra steps. */
  async fleeLoop() {
    const bot = this.bot;
    let recomputeAt = 0;
    let corneredAt = 0;
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
        recomputeAt = Date.now() + 2200;
        const goal = this._fleeGoal(threat, { radius: 14 });
        if (goal) {
          corneredAt = 0;
          this.goalDesc = goal;
          // dynamic: the route must be recomputed as the pursuer moves
          if (!this._applyGoal(true)) this._directFleeStep(threat);
        } else {
          // No reachable escape. Drive directly with the terrain-aware walker,
          // which is strictly better at a one-block step than standing still.
          if (!corneredAt) corneredAt = Date.now();
          this._directFleeStep(threat);
          if (Date.now() - corneredAt > 6000) {
            this.log.warn('actor: nowhere to run, turning to fight', { health: +h.toFixed(1) });
            this._beginFight(threat, 'cornered');
            return;
          }
        }
      }
      await sleep(350);
    }
  }

  /** Flee with the direct controller, for when the pathfinder has no route. */
  _directFleeStep(threat) {
    const bot = this.bot;
    try {
      const away = bot.entity.position.minus(threat.position);
      const len = Math.hypot(away.x, away.z) || 1;
      const target = { x: bot.entity.position.x + away.x / len * 3, z: bot.entity.position.z + away.z / len * 3 };
      M.walkToward(bot, target, { allowFall: true, maxDrop: 2, hop: true, sprint: true });
    } catch (_) {}
  }

  /**
   * Chase-and-swing loop.
   *
   * Two changes that matter for real terrain:
   *   1. Closing uses the direct terrain-aware walker when the pathfinder has no
   *      route, so a one-block step between us and a mob is jumped rather than
   *      stood against. A follow-goal alone is not enough: the pathfinder can
   *      legitimately return "no route" for a target standing on a ledge above
   *      us, and a mob does not care that our router gave up.
   *   2. The overwhelmed retreat now picks *reachable* ground (see _fleeGoal),
   *      which is the difference between running home and running into a wall.
   */
  async fightLoop() {
    const bot = this.bot;
    const startedAt = Date.now();
    const maxMs = this.cfg.fight && this.cfg.fight.maxMs ? this.cfg.fight.maxMs : 20000;
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
      // going to end. After the budget give up the offence and run for home,
      // which is how a player behaves at night — otherwise gather is impossible.
      if (lastTarget && lastTarget !== e) swaps++;
      lastTarget = e;
      const tooLong = Date.now() - startedAt > maxMs;
      const swarmed = swaps > 4;
      if (tooLong || swarmed) {
        this.log.warn('actor: overwhelmed, retreating home', {
          swaps, seconds: +((Date.now() - startedAt) / 1000).toFixed(1)
        });
        // Retreat, then go back to whatever we were doing once it is safe —
        // giving up on the whole goal because of one bad night is the
        // "stuck halfway" failure this bot exists to avoid.
        this.prevMode = this._preGoalMode || this.prevMode || 'afk';
        this._beginFlee(e, swarmed ? 'swarmed' : 'fight budget exceeded');
        return;
      }
      try { bot.lookAt(e.position.offset(0, 1.2, 0), true); } catch (_) {}
      const dist = bot.entity.position.distanceTo(e.position);
      if (dist > 2.4) {
        // Prefer the pathfinder (it routes around things), but do not depend on
        // it: if it is not moving us, walk toward the mob directly and jump.
        this.goalDesc = { type: 'follow', range: 1, reach: 2, resolve: () => e };
        if (!bot.pathfinder || !isPathingNow(bot)) this._applyGoal(true);
        if (isPathingNow(bot)) {
          M.clearAll(bot);
        } else if (Date.now() - this._lastFightStep > 120) {
          this._lastFightStep = Date.now();
          M.walkToward(bot, { x: e.position.x, z: e.position.z }, {
            allowFall: true, maxDrop: 2, hop: true, sprint: dist > 6
          });
        }
      } else {
        M.clearAll(bot);
        // Cooldown discipline: 1.9+ damage scales with swing charge, so spamming
        // at 100 ms does ~1 damage per hit and leaves you open. Swing when charged.
        const cd = this.cfg.fight && this.cfg.fight.swingCdMs ? this.cfg.fight.swingCdMs : 600;
        if (!this._attackCd || Date.now() - this._attackCd > cd) {
          this._attackCd = Date.now();
          try { await bot.attack(e); } catch (_) {}
        }
      }
      await sleep(200);
    }
    M.clearAll(bot);
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
      // Pick only columns the bot can actually stand in: the surface block is
      // under the feet, so the goal is y+1, and that cell plus headroom must be
      // free. Without this, wander asked the pathfinder to occupy solid ground
      // and it answered path_stop.
      const col = T.columnInfo(bot, x, z, origin.y);
      if (!col || col.headBlocked) continue;
      if (col.dropBeyond > 3) continue;           // do not wander onto a ledge
      return { x, y: col.y, z };
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

    /* Proactive assistance. The watchdog above only fires after 6 s of nothing,
     * and by then the pathfinder has usually already decided the route is dead.
     * Halfway to that threshold — 2.5 s with a live goal and no progress — drive
     * toward the goal ourselves for a moment, jumping what is in front of us.
     * This is the cheap fix for "stalled on a one-block step": the bot hops over
     * it instead of escalating to dig / invert / give up. It never fights the
     * pathfinder for long, because a single successful hop resets lastMoveAt. */
    if (pathing && settled && now - this.lastMoveAt > Math.min(2500, (this.cfg.stuckTimeoutMs || 6000) / 2) &&
      now - (this._assistAt || 0) > 1500 && !this._recovering) {
      this._assistAt = now;
      this._assist();
    }

    // hard goal timeout
    if (pathing && this.goalStartedAt && now - this.goalStartedAt > (this.cfg.goalTimeoutMs || 300000)) {
      this.log.warn('actor: goal timed out, giving up', { timeoutMs: this.cfg.goalTimeoutMs || 300000 });
      this.setMode('afk');
    }

    // Run the survival layer whenever it is explicitly enabled OR the bot is
    // pursuing an active goal (see survivalTick): an undefended bot dies and
    // never completes its task. `hold` is deliberately included: standing ground
    // means defending it, and the one mode that must be excluded is `pvp`, whose
    // own controller owns the movement controls. Leaving pvp out is not cosmetic:
    // survivalTick's flee branch and the PvP loop both drive `forward`/`back`, so
    // when both were armed they cancelled each other out and the bot froze in
    // place mid-duel while taking hits.
    if (this.survive || (this.mode !== 'afk' && this.mode !== 'pvp')) this.survivalTick(now);
  }

  /**
   * Fix a goal's Y so it names a cell the bot can stand in, keeping X/Z.
   *
   * A goal whose destination column is not standable — a ledge, the rim of a
   * hole, a coordinate in mid-air — has no route, and the pathfinder answers
   * with `path_stop`, which the old code treated as "give up". Snapping the
   * target to the actual surface converts a permanent failure into a short walk,
   * and it is the same reason `antiIdleTarget` refuses a bad column.
   */
  _snapToStandable(desc) {
    const bot = this.bot;
    if (!bot.entity || !desc) return desc;
    // GoalBlock is only ever produced for coordinates the operator typed in
    // full, so its y is a request, not a guess - adjusting it would be the
    // silent override that made `goto -40 60 22` announce y=159 on a live server.
    if (desc.type === 'block') return desc;
    if (desc.type !== 'near' && desc.type !== 'xz') return desc;
    const here = bot.entity.position;
    const top = topSolidY(bot, desc.x, desc.z, here.y);
    if (top == null) return desc;                     // unloaded: leave it alone
    const stand = top + 1;
    const range = desc.range != null ? desc.range : (this.cfg.gotoRange || 3);
    if (Math.abs(stand - desc.y) <= Math.max(1, range - 1)) return desc;   // already sane
    if (!T.isStandable(bot, desc.x, stand, desc.z)) {
      // The standing cell itself is unusable (filled at feet or head, or no
      // floor): aim one above and widen slightly so the pathfinder may stop on
      // any neighbouring column of the same surface instead of reporting no route.
      return Object.assign({}, desc, { type: 'near', y: stand + 1, range: Math.max(range, 2) });
    }
    this.log.debug('actor: snapped goal to standable height', { x: desc.x, z: desc.z, from: desc.y, to: stand });
    return Object.assign({}, desc, { type: 'near', y: stand, range });
  }

  /**
   * Collect nearby item entities.
   *
   * Walking back to where we died is only half of a recovery: the drops are
   * entities floating above the floor, and a bot that arrives, looks around, and
   * leaves has walked two hundred blocks for nothing. This build of mineflayer
   * has no `collectItem`; `useOn(entity)` is the supported way to interact with
   * an item entity, so that is what is used, guarded by a feature check so an
   * older or newer build cannot throw here. A failed pickup is counted and
   * logged, never thrown: one unreachable drop is not a reason to abandon the
   * task that follows.
   */
  _pickupAround(radius) {
    const bot = this.bot;
    if (!bot.entity || !bot.entities) return 0;
    let found = 0, done = 0;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || !e.position || e === bot.entity) continue;
      if (e.isValid === false) continue;
      const kind = String(e.kind || e.type || '').toLowerCase();
      const name = String(e.displayName || e.name || e.type || '').toLowerCase();
      if (!/item|drop|object/.test(kind) && !/item/.test(name)) continue;
      if (bot.entity.position.distanceTo(e.position) > radius) continue;
      found++;
      try {
        if (typeof bot.useOn === 'function') { bot.useOn(e); done++; }
      } catch (_) { /* unreachable drop: not worth a stack trace */ }
    }
    if (found) this.log.info('actor: drops nearby', { found, attempted: done, radius });
    return found;
  }

  /**
   * Recover from a stall.
   *
   * WHY THE OLD VERSION DID NOT WORK
   * --------------------------------
   * It pulsed `jump` for 500 ms and nothing else. In Minecraft a jump only
   * clears an obstruction if `forward` is ALSO held on the tick of the
   * collision — pressing jump against a one-block step moves you exactly zero
   * blocks, which is why the bot appeared completely unable to jump and "only
   * worked on flat ground". Four of those pulses later it declared the goal
   * unreachable and went AFK, still standing in the hole it had fallen into.
   *
   * WHAT IT DOES NOW, in order of how cheap the fix is
   * ---------------------------------------------------
   *   1. Walk toward the goal *while jumping* (movement.walkToward, which also
   *      does a jump-sneak hop onto a 2-block step). This alone clears most stalls.
   *   2. If we are in a depression, find the best exit direction and climb out
   *      before re-planning — the "stuck after falling one block" case, solved
   *      directly instead of hoping the pathfinder reroutes around it.
   *   3. Dig the block actually blocking us: the cell toward the goal, not the
   *      one we happen to be facing (a stalled pathfinder has stopped turning).
   *   4. Re-plan with a terrain-checked goal: a target that is not standable from
   *      here has no route, so snap it to the nearest reachable surface first.
   *   5. Only then invert the goal, and only then give up.
   *
   * The recovery is an async sequence because the controls have to be ours for
   * the duration; handing the goal back to the pathfinder mid-jump just restarts
   * the argument between the two drivers.
   */
  /**
   * A short, self-limiting burst of direct control while a path is nominally
   * live. Skipped entirely for PvP (the controller owns the controls there) and
   * while an async recovery is already running.
   */
  _assist() {
    const bot = this.bot;
    if (this.mode === 'pvp' || !bot.entity || !this.goalDesc) return;
    const heading = this._goalHeading(this.goalDesc);
    if (!heading) return;
    M.walkToward(bot, heading, { allowFall: true, maxDrop: 2, hop: true, jumpAlways: false, sprint: false });
    // release quickly: the pathfinder resumes on its own next tick
    const t = setTimeout(() => {
      if (this.mode !== 'pvp' && !this._recovering) M.clearAll(bot);
    }, 500);
    if (t.unref) t.unref();
  }

  unstick() {
    const bot = this.bot;
    /* A recovery is an async sequence — walk+jump for ~1.7 s, then climbOut for
     * up to 2.6 s, then a dig. While it is running the tick still sees "no
     * movement", so it re-entered unstick() every 500 ms and burned all four
     * attempts in 1.5 seconds: observed live, the watchdog logged
     *     attempt=1 ... attempt=4, "giving up after repeated stalls"
     * and only *after* that did "climb result res=climbed" arrive — the climb
     * worked, and the bot had already quit and gone AFK in the hole. That is the
     * user's original "gets stuck as soon as it falls" bug, still reproducible.
     *
     * So: one recovery at a time, and each start re-arms the stall clock so the
     * watchdog waits for the in-flight attempt instead of stacking new ones.
     */
    if (this._recovering) return;
    this.stuckAttempts++;
    const attempt = this.stuckAttempts;
    const cap = this.cfg.maxStuckAttempts || 4;
    const p = bot.entity ? bot.entity.position : null;
    this.log.warn('actor: stuck, recovering', {
      attempt, mode: this.mode,
      pos: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null
    });

    if (attempt >= cap) {
      this.log.warn('actor: giving up after repeated stalls', { attempts: attempt });
      this._clearGoal();
      M.clearAll(bot);
      this.setMode('afk');
      return;
    }
    // Re-arm the timer the watchdog measures, so the next attempt can only happen
    // once this one has finished and still produced nothing.
    this.lastMoveAt = Date.now();
    this._recover(attempt, cap).catch(e => this.log.debug('actor: recovery failed', { error: e.message }));
  }

  async _recover(attempt, cap) {
    const bot = this.bot;
    const desc = this.goalDesc;
    if (!desc) return;
    this._recovering = true;
    try {
      await this._recoverInner(attempt, cap, desc, bot);
    } finally {
      this._recovering = false;
    }
  }

  async _recoverInner(attempt, cap, desc, bot) {
    this._recoverMark = bot.entity ? bot.entity.position.clone() : null;
    // Re-arm at every phase boundary: a long dig or a slow climb must not be
    // mistaken for a fresh stall the moment it completes.
    const reArm = () => { this.lastMoveAt = Date.now(); };

    // 1) walk toward the goal *with* jumping
    const heading = this._goalHeading(desc);
    if (heading) {
      for (let i = 0; i < 12 && this.goalDesc === desc && !this.destroyed && this.mode !== 'pvp'; i++) {
        // alternate a forced hop with a terrain-decided step, so a bot stuck on
        // a slab/fence edge still gets lift
        const way = M.walkToward(bot, heading, {
          allowFall: true, maxDrop: 2, hop: true, sprint: false, jumpAlways: i % 2 === 0
        });
        if (way === 'blocked' && i > 3) break;
        await sleep(140);
      }
      M.clearAll(bot);
      reArm();
      if (this._progressSince()) {
        this.log.info('actor: recovered by jumping the obstacle', { attempt });
        this.stuckAttempts = Math.max(0, attempt - 2);   // a real recovery buys back budget
        this._replan(desc, attempt, cap);
        return;
      }
    }

    // 2) are we in a hole? One block is enough to strand a bot whose only route
    //    was straight up, and the pathfinder will not plan a 2-block climb.
    const exit = M.bestExitDirection(bot, { hop: true });
    if (exit && exit.rise >= 1) {
      this.log.info('actor: climbing out', { rise: exit.rise, dx: exit.dx, dz: exit.dz });
      const res = await M.climbOut(bot, { timeoutMs: 2600, hop: true });
      M.clearAll(bot);
      reArm();
      this.log.info('actor: climb result', { res });
      if (res === 'climbed') {
        this.stuckAttempts = Math.max(0, attempt - 1);
        this._replan(desc, attempt, cap);
        return;
      }
    }

    // 3) dig what is actually in the way, toward the goal
    if (this.cfg.canDig !== false && typeof bot.dig === 'function' && heading) {
      try {
        const pos = bot.entity.position;
        const dx = Math.sign(heading.x - pos.x), dz = Math.sign(heading.z - pos.z);
        const cells = [
          [Math.floor(pos.x + dx), Math.floor(pos.y), Math.floor(pos.z + dz)],
          [Math.floor(pos.x + dx), Math.floor(pos.y + 1), Math.floor(pos.z + dz)],
          [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)],
          [Math.floor(pos.x + dx), Math.floor(pos.y - 1), Math.floor(pos.z + dz)]
        ];
        for (const [x, y, z] of cells) {
          const b = bot.blockAt(probe(x, y, z));
          if (!b || b.name === 'air' || b.name === 'bedrock') continue;
          if (!T.isSolidBlock(b)) continue;
          this.log.info('actor: digging the obstruction', { block: b.name, at: [x, y, z] });
          await this.equipToolFor(b.name);
          bot.dig(b, true).catch(() => {});
          await sleep(900);
          reArm();
          break;
        }
      } catch (e) { this.log.debug('actor: unstick dig failed', { error: e.message }); }
    }

    this._replan(desc, attempt, cap);
  }

  /** Where the current goal is, in x/z, for direct-controller driving. */
  _goalHeading(desc) {
    const bot = this.bot;
    if (!bot.entity || !desc) return null;
    if (desc.type === 'near' || desc.type === 'block' || desc.type === 'xz') return { x: desc.x, z: desc.z };
    if (desc.type === 'follow' && desc.resolve) {
      const e = desc.resolve();
      return e && e.position ? { x: e.position.x, z: e.position.z } : null;
    }
    if (desc.type === 'invert' && desc.inner) {
      const h = this._goalHeading(desc.inner);
      if (!h) return null;
      // away from the inner goal, at a reachable distance
      const p = bot.entity.position;
      return { x: p.x + (p.x - h.x), z: p.z + (p.z - h.z) };
    }
    return null;
  }

  /** True when the bot has moved meaningfully since the recovery checkpoint. */
  _progressSince() {
    const bot = this.bot;
    if (!bot.entity || !this._recoverMark) return false;
    return bot.entity.position.distanceTo(this._recoverMark) > 0.6;
  }

  /**
   * Re-issue the goal after a recovery, but not necessarily at the same target:
   * a goal that is not standable from here is snapped to reachable ground first,
   * and only the last attempt inverts (so the bot at least leaves the corner).
   */
  _replan(desc, attempt, cap) {
    const bot = this.bot;
    if (!this.goalDesc || this.goalDesc !== desc || this.destroyed) return;
    const next = this._snapToStandable(desc);
    if (attempt >= cap - 1) {
      this.goalDesc = { type: 'invert', inner: next };
    } else {
      this.goalDesc = next;
    }
    this._recoverMark = bot.entity ? bot.entity.position.clone() : null;
    this.goalStartedAt = Date.now();
    this._applyGoal(false);
    this.lastMoveAt = Date.now();
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
      const threat = nearestHostile(bot, 16);
      this._beginFlee(threat, `low health ${+health.toFixed(1)}`);
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

    // hit back. onHealth() already reacts on the damage packet itself, so this
    // is the safety net for a hurt that arrived without a health change (a
    // shield bash, knockback from an untracked mob). It must not re-arm every
    // tick inside the 4 s window: each _beginFight overwrites prevMode, so a
    // repeating trigger corrupts the mode we are supposed to restore.
    if (defend && s.attack !== false && now - this.lastHurtAt < 4000 &&
      this.mode !== 'fight' && this.mode !== 'flee' && now - (this._lastFightArm || 0) > 3000) {
      const threat = nearestHostile(bot, 6);
      if (threat) {
        this._lastFightArm = now;
        this.log.warn('actor: hit back', { mob: threat.name || threat.username, hearts: hearts(bot.health) });
        this._beginFight(threat, 'hit back (tick)');
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
      case 'hearts': case 'hp': case 'vitals': {
        // mc hearts [player]  — our own hearts, or an observed player's
        if (!args.length) {
          const h = this.bot.health;
          return { ok: true, msg: `self: ${h != null ? h.toFixed(1) : '?'} hp = ${hearts(h)} hearts (gamemode ${ownGameMode(this.bot) || '?'})` };
        }
        const r = this.observePlayer(args[0]);
        return r;
      }
      case 'jump': case 'test-jump': {
        // Prove the movement stack works, on demand, without a fight or a goal.
        const exit = M.bestExitDirection(this.bot, { hop: true });
        M.hop(this.bot, 1);
        return { ok: true, msg: `hopped (facing). exit candidate: ${exit ? `rise ${exit.rise} dir ${exit.dx},${exit.dz}` : 'none (flat or boxed in)'}` };
      }
      case 'climb': {
        M.climbOut(this.bot, { timeoutMs: 3000, hop: true })
          .then(res => this.log.info('actor: climb', { res }));
        return { ok: true, msg: 'attempting to climb out' };
      }
      case 'ai': {
        const mode = String(args[0] || 'assist').toLowerCase();
        if (!['off', 'assist', 'force'].includes(mode)) return { ok: false, msg: 'usage: ai off|assist|force' };
        this.cfg.ai = mode === 'off' ? 'off' : { ...(this.cfg.ai || {}), pvp: mode };
        if (mode !== 'off' && !this.jev) this.jev = new JevClient({ logger: this.log, enabled: true, url: (this.cfg.ai || {}).url });
        if (this.pvp) this.pvp.jev = this.jev;
        if (this.pvp) this.pvp.ai = mode;
        return { ok: true, msg: `ai advisor: ${mode}` };
      }
      case 'result': return this.pvpSummary();
      case 'players': {
        const bot = this.bot;
        const list = Object.keys(bot.players || {}).filter(n => n !== bot.username);
        return { ok: true, msg: list.length ? list.join('\n') : 'no other players visible', data: list };
      }
      case 'help':
        return {
          ok: true,
          msg: 'commands: afk | hold | goto <x> [y] <z> | come | home [x y z] | ' +
               'follow <player> [range] | wander [radius] | gather [radius] | ' +
               'attack <name> | pvp <player> [tier] [stop|hp <n>|result|ai <mode>] | ' +
               'hearts [player] | players | jump | climb | ai off|assist|force | eat | survive on|off'
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
const probe = T.probe;

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

// Terrain queries live in src/terrain.js so the actor and the PvP controller
// cannot disagree about what "the ground" means. This alias is kept because the
// module's own code reaches for topSolidY constantly; everything else goes
// through T.* directly.
const topSolidY = T.topSolidY;

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
  Actor, VALID_MODES, describeGoal, isPathingNow,
  isNight, nearestHostile, countHostiles
};
