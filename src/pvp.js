'use strict';

/**
 * PvP opponent module.
 *
 * Why this is a separate module rather than another actor.js mode: the existing
 * modes are all goal-shaped (walk to a place, chop a tree, follow a player).
 * PvP is a continuous control problem — the bot must hold a spacing, track a
 * target that is actively trying to hit it, and decide *not* to attack based on
 * a running damage estimate. None of that fits the goal/resolve/fail loop the
 * rest of the actor uses, so it gets its own loop with its own clock.
 *
 * THE HEALTH PROBLEM (and why the old answer was wrong)
 * -----------------------------------------------------
 * The server never sends another player's health to a vanilla client — verified
 * empirically: `entity.health`, `metadata.health` and the attribute snapshot are
 * all undefined for other players. So "stop when the opponent is at 3 hearts"
 * cannot be read. The original code *accounted* for it: every landed hit
 * subtracted weapon damage reduced by visible armour, and when the running
 * total crossed a threshold the bot disengaged.
 *
 * That accounting has two failure modes, and the user hit both:
 *
 *   - It drifts in a way that is invisible from inside. Enchantment bonuses,
 *     absorption hearts, a golden apple, a relog at full health, a swing that
 *     visually missed — any of these move the estimate away from the truth, and
 *     the estimate crossing the threshold *is* the retreat trigger. So the bot
 *     ran away from an opponent it had actually beaten.
 *   - Worse, the estimate is blind to game mode. Against an opponent in creative
 *     the subtraction marches to zero, which simultaneously reads as "we won"
 *     and as "we're at 3 hearts, disengage", and the bot flees a target the
 *     server says cannot take damage at all.
 *
 * THE FIX
 * -------
 * Estimate and observation are now different things and are never conflated:
 *
 *   1. Every real signal the server does send is used. `animation 1` fires when
 *      an entity is hurt — that is an *observed* hit, worth more than any
 *      arithmetic, and on 1.20+ `damage_event` even names the attacker, so
 *      "I hurt them" can be confirmed rather than assumed. `animation 0` marks
 *      their swing; if we took no damage, they missed. `entityDeath`,
 *      `entityRemove`, and the `player_info` game-mode table are all read.
 *      src/perceive.js owns that plumbing.
 *   2. The estimate still exists — counting hits is exactly what a human does —
 *      but it is labelled, bounded by observed events, and *cannot by itself
 *      end a fight or declare one won*. Only a real signal can do that.
 *   3. A game mode of creative/spectator ends the duel on principle: there is no
 *      fight to win. The same is true if the opponent takes no observed damage
 *      after several confirmed hits (a god-mode or invulnerable plugin), which
 *      is the general case of the creative problem.
 *
 * DIFFICULTY
 * ----------
 * Tiers tune the human-ness rather than raw damage. A "hard" bot is not one
 * that hits harder (that would be cheating — the damage is identical); it is one
 * that spaces better, strafes, respects its cooldown, and does not stand in your
 * reach. Each tier is a knob set, not a behaviour fork, so the spectrum is
 * continuous: `pvp ENC_7376484R 0.7` sits between medium and hard.
 *
 *   0.0 rookie   walks in a straight line, only swings when you are already
 *                touching it, slow reactions, sometimes swings at nothing
 *   0.5 medium   keeps a loose spacing, strafes occasionally, mostly respects
 *                its attack cooldown
 *   1.0 hard     holds exactly the edge of its own reach, orbits continuously
 *                with direction changes, jumps steps instead of stopping at
 *                them, pressures you while you are swinging, and disengages the
 *                instant its own spacing breaks
 *
 * TERRAIN
 * -------
 * Movement is delegated to src/movement.js, so the PvP loop inherits the fix for
 * "it only works on flat ground": a one-block step is jumped rather than stood
 * against, and an orbit never walks off a ledge it did not agree to fall.
 *
 * EXTERNAL ADVISOR
 * ----------------
 * With `ai: 'jev'` the loop asks the structured-decision endpoint what a good
 * player would do in this exact state (src/jev.js). It is advisory: the answer
 * chooses *how* to press (attack / press / space / strafe / retreat / bait /
 * guard / disengage) and how aggressive to be, while the local tier system still
 * flies the plane, safety rules keep veto power, and a slow or dead endpoint
 * costs nothing because the loop reads a cache instead of awaiting the network.
 */

const Vec3 = require('vec3').Vec3 || require('vec3');
const M = require('./movement');
const T = require('./terrain');
const { Vitals, gameModeOf, ownGameMode, isUnkillable, hearts } = require('./perceive');
const { buildFightPrompt, interpretFight, PVP_ACTIONS } = require('./jev');

const TIERS = {
  // difficulty t 0..1 interpolates between these two rows
  rookie: {
    reactionMs: 700,      // delay before it responds to your movement
    swingCdMs: 900,       // respects attack cooldown (sword ~600ms at full)
    aimError: 0.55,       // radians of aim noise — a rookie swings wide
    missChance: 0.30,     // chance a swing is deliberately aimed off-target
    strafeChance: 0.15,   // probability per re-plan of strafing at all
    strafeChangeMs: 1400, // how often it commits to a new strafe direction
    holdRange: 2.8,       // preferred distance to keep from you
    pressure: 0.25,       // how aggressively it walks into you while you swing
    jitter: 0.4,          // extra aim noise
    orbit: 0.0,           // fraction of time spent circling instead of closing
    jumpSkill: 0.15       // how reliably it clears a step while pressing
  },
  hard: {
    reactionMs: 150,
    swingCdMs: 620,
    aimError: 0.10,
    missChance: 0.03,
    strafeChance: 0.95,
    strafeChangeMs: 520,
    holdRange: 3.0,       // just outside its own reach until it commits to a hit
    pressure: 0.85,
    jitter: 0.08,
    orbit: 0.85,
    jumpSkill: 1.0
  }
};

// Vanilla per-hit damage by tool class, at full attack cooldown. Used only for
// the opponent's *health estimate*; the real damage is whatever the server
// applies. Bare fist is 1.
const WEAPON_DAMAGE = {
  'diamond_sword': 7, 'netherite_sword': 8, 'iron_sword': 6, 'stone_sword': 5,
  'golden_sword': 4, 'wooden_sword': 4,
  'diamond_axe': 9, 'netherite_axe': 10, 'iron_axe': 7, 'stone_axe': 6,
  'golden_axe': 4, 'wooden_axe': 3,
  'diamond_pickaxe': 5, 'netherite_pickaxe': 6, 'iron_pickaxe': 4, 'stone_pickaxe': 3, 'golden_pickaxe': 3, 'wooden_pickaxe': 3,
  'trident': 9, 'mace': 10
};

// Armour damage reduction per piece (chest/legs/helmet/boots), plus the
// toughness-free approximation vanilla uses. This is an estimate of the
// estimate: close enough to count hits like a player does, and corrected by
// real signals and by `pvp hp <n>`.
const ARMOR_REDUCTION = {
  'netherite_helmet': 0.09, 'netherite_chestplate': 0.28, 'netherite_leggings': 0.22, 'netherite_boots': 0.09,
  'diamond_helmet': 0.08, 'diamond_chestplate': 0.24, 'diamond_leggings': 0.18, 'diamond_boots': 0.08,
  'iron_helmet': 0.06, 'iron_chestplate': 0.18, 'iron_leggings': 0.13, 'iron_boots': 0.05,
  'chainmail_helmet': 0.05, 'chainmail_chestplate': 0.15, 'chainmail_leggings': 0.11, 'chainmail_boots': 0.04,
  'golden_helmet': 0.05, 'golden_chestplate': 0.15, 'golden_leggings': 0.11, 'golden_boots': 0.04,
  'leather_helmet': 0.04, 'leather_chestplate': 0.11, 'leather_leggings': 0.08, 'leather_boots': 0.03,
  'turtle_helmet': 0.05
};

function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

function tierFor(t) {
  const tt = Math.max(0, Math.min(1, t));
  const out = {};
  for (const k of Object.keys(TIERS.rookie)) {
    out[k] = k === 'orbit' || k === 'jumpSkill'
      // these two are deliberately non-linear: an orbiting, jumping bot is a
      // *learned* habit, so a rookie does not do it "15% as often" as a hard
      // bot, it almost never does it, and the habit arrives in the 0.5..0.8 band
      ? Math.pow(tt, k === 'orbit' ? 1.6 : 1.2)
      : lerp(TIERS.rookie[k], TIERS.hard[k], tt);
  }
  return out;
}

class PvpController {
  /**
   * @param {object} bot   mineflayer bot
   * @param {object} deps  { logger, actor, config, tracker, jev }
   *   tracker: a src/perceive.js DamageTracker (real signals)
   *   jev:     a src/jev.js JevClient (optional external advisor)
   */
  constructor(bot, deps = {}) {
    this.bot = bot;
    this.log = deps.logger || { info() {}, warn() {}, debug() {} };
    this.actor = deps.actor;
    this.cfg = (deps.config && deps.config.pvp) || {};
    this.tracker = deps.tracker || null;
    this.jev = deps.jev || null;

    this.running = false;
    this.targetName = null;
    this.tier = 0.5;

    // Damage bookkeeping — estimate (ours) and vitals (theirs, real signals)
    this.estimate = 20;
    this.maxHealth = 20;
    this.vitals = new Vitals({ maxHealth: 20, known: false });
    this.hitsLanded = 0;          // our swings that we believe connected
    this.hitsConfirmed = 0;       // swings the server confirmed as damage
    this.hitsIgnored = 0;         // swings that produced no effect at all
    this.lastHitAt = 0;
    this.enemyHitsOnUs = 0;       // times they hurt us
    this.result = null;           // 'win' | 'loss' | 'draw' | 'forfeit' | 'no-fight'

    // Timing
    this.lastSwingAt = 0;
    this.lastStrafeAt = 0;
    this.strafeDir = 1;
    this.lastReactAt = 0;
    this.targetLastPos = null;
    this.startAt = 0;

    // Retreat / spacing state
    this.retreating = false;
    this.retreatUntil = 0;
    this.disengageReason = null;
    this.lastMove = 'idle';

    // AI advisor state
    this.ai = String(this.cfg.ai || (deps.config && deps.config.ai && deps.config.ai.pvp) || 'off');
    this.intent = null;           // last interpreted advisor intent
    this.intentAppliedAt = 0;

    // Tunables (overridable via cfg.pvp)
    this.retreatHp = num(this.cfg.retreatHp, 6);      // 3 hearts
    this.safeHp = num(this.cfg.safeHp, 12);           // re-engage above this
    this.stopSwingAt = 0;                             // a temporary "do not attack"
    this.giveUpDist = num(this.cfg.giveUpDist, 40);
    this.engageRange = num(this.cfg.engageRange, 20);
    this.reach = num(this.cfg.reach, 3.0);            // server melee reach
    // Descending is a different budget from circling. Refusing every drop keeps a
    // bot off a cliff, and also means it can never fight anyone standing one block
    // below it — which is what happened on the first live duel I drove: it
    // returned "gated" from 6 blocks away and swung zero times. Fall damage starts
    // at 4 blocks, so 3 is the largest harmless step down, and `atEdge` still
    // refuses a real cliff because the ground beyond it drops further than that.
    this.maxDrop = num(this.cfg.maxDrop, 1);          // spacing/orbit: stay conservative
    this.descendMax = num(this.cfg.descendMax, 3);    // closing on a target
    this.hopEnabled = this.cfg.hop !== false;         // jump-sneak onto 2-block steps
    this.maxFightMs = num(this.cfg.maxFightMs, 180000);
    // How long the "estimate says they're low" pause lasts before re-anchoring the
    // arithmetic and resuming. A knob rather than a literal, so it can be tuned per
    // server (a slow-healing opponent deserves a longer look) and asserted in tests.
    this.verifyMs = num(this.cfg.verifyMs, 4000);
    this.idleDrawMs = num(this.cfg.idleDrawMs, 25000);
    this.autoEat = this.cfg.autoEat !== false;
    this.preferObserve = this.cfg.preferObserve !== false;  // trust real signals over the estimate
  }

  /* ---------------------------------------------------------------- *
   * lifecycle
   * ---------------------------------------------------------------- */

  start(targetName, tier) {
    const bot = this.bot;
    this.targetName = targetName;
    this.tier = typeof tier === 'number' ? tier : 0.5;
    this.running = true;
    this.retreating = false;
    this.result = null;
    this.disengageReason = null;
    this.estimate = 20;
    this.hitsLanded = 0;
    this.hitsConfirmed = 0;
    this.hitsIgnored = 0;
    this.enemyHitsOnUs = 0;
    this.startAt = Date.now();
    this.vitals = new Vitals({ maxHealth: 20, known: false });
    bot.clearControlStates();

    const t = this.target();
    if (t && this.tracker) this.tracker.setTarget(t);
    this.log.info('pvp: engaging', {
      target: targetName,
      tier: +this.tier.toFixed(2),
      retreatHp: this.retreatHp,
      ai: this.ai,
      opponentGamemode: this.vitals.gameMode
    });
    this.loop().catch(e => this.log.warn('pvp loop ended', { error: e.message, stack: e.stack }));
    return { ok: true, msg: `PvP vs ${targetName} (tier ${this.tier.toFixed(2)}${this.ai !== 'off' ? ', ai ' + this.ai : ''})` };
  }

  /**
   * Stop fighting. `reason` is logged and kept as the result when the loop
   * itself decided to stop, so `mc pvp result` can say *why* it ended: won,
   * lost, drew, or walked away — with the evidence, not the arithmetic.
   */
  stop(reason, result) {
    if (!this.running) return { ok: true, msg: 'pvp already stopped', data: this.summary() };
    this.running = false;
    this.retreating = false;
    M.clearAll(this.bot);
    if (!this.result) this.result = result || 'forfeit';
    if (!this.resultReason) this.resultReason = reason || 'manual';
    const s = this.summary();
    this.log.info('pvp: stopped', {
      reason: this.resultReason, result: this.result,
      hits: this.hitsLanded, confirmedHits: this.hitsConfirmed,
      estHealth: +this.estimate.toFixed(1), hearts: hearts(this.estimate),
      enemyHpOnUs: this.enemyHitsOnUs
    });
    return { ok: true, msg: `PvP ended: ${this.result} (${this.resultReason})`, data: s };
  }

  /**
   * Live correction of the health estimate, e.g. after watching them eat.
   *
   * Note what this does *not* do: it cannot make the bot think it has won. A
   * manual number is an input to the estimate, and `result` still comes only
   * from observed signals. That is deliberate — the reason the old bot "ran
   * away even when it thought it won" is that one number was doing both jobs.
   */
  setHealth(n) {
    const v = Math.max(0, Math.min(this.maxHealth, parseFloat(n) || 20));
    this.estimate = v;
    this.vitals.estimate = v;
    this.vitals.confirmed = this.vitals.known ? this.vitals.confirmed : null;
    this.log.info('pvp: health estimate corrected', { estimate: v, hearts: hearts(v) });
    return { ok: true, msg: `Opponent health estimate set to ${v} (${hearts(v)} hearts)` };
  }

  /* ---------------------------------------------------------------- *
   * targeting & sensing
   * ---------------------------------------------------------------- */

  target() {
    const bot = this.bot;
    if (!bot || !bot.players) return null;
    const p = bot.players[this.targetName];
    if (!p || !p.entity || !p.entity.position) return null;
    if (!bot.entity) return null;
    if (p.entity.position.distanceTo(bot.entity.position) > this.giveUpDist) return null;
    if (this.tracker) this.tracker.setTarget(p.entity);
    const v = this.tracker ? this.tracker.of(p.entity) : this.vitals;
    if (v !== this.vitals) {
      // keep our own estimate in step with the tracker's view of this entity
      v.estimate = Math.min(v.estimate, this.estimate);
      this.vitals = v;
    }
    if (v.gameMode == null) v.gameMode = gameModeOf(bot, this.targetName);
    else {
      // Re-read every cycle. A game mode is not a property of the entity we may
      // cache once on first sight: the operator flips /gamemode to test the bot,
      // and a stale 'creative' makes it decline a real fight (observed live),
      // while a stale 'survival' makes it swing at an unkillable player forever.
      // The refresh is one table lookup, and it is what makes 'no-fight' a state
      // the bot can leave rather than one it is stuck in.
      const gm = gameModeOf(bot, this.targetName);
      if (gm != null && gm !== v.gameMode) {
        this.log.info('pvp: opponent gamemode changed', { from: v.gameMode, to: gm });
        v.gameMode = gm;
      }
    }
    return p.entity;
  }

  /** The opponent's health as we best understand it, plus where that came from. */
  opponentHealth() {
    const v = this.vitals;
    if (this.preferObserve && v.known && v.confirmed != null) {
      return { hp: v.confirmed, source: 'server' };
    }
    // Re-anchor the arithmetic on observed hits: never let the estimate fall
    // below what the server has already confirmed they lost, and never claim
    // more damage than the hits we actually landed.
    const observedFloor = v.damageSeen;
    const guessed = this.estimate;
    const hp = Math.min(guessed, Math.max(0, this.maxHealth - observedFloor));
    return { hp: Math.max(0, hp), source: 'estimate' };
  }

  /**
   * Estimate the opponent's damage reduction from their visible equipment.
   * mineflayer populates entity.equipment from entity_equipment packets, so
   * this is real data the server sends us (unlike health).
   */
  armorFactor(entity) {
    const eq = entity && entity.equipment;
    if (!eq) return 1;
    let reduction = 0;
    for (const item of eq) {
      if (!item || !item.name) continue;
      reduction += ARMOR_REDUCTION[item.name] || 0;
    }
    return Math.max(0.25, 1 - reduction);
  }

  /** Our own visible armour as a reduction factor, for the advisor's state text. */
  ownArmorFactor() {
    const inv = this.bot.inventory;
    if (!inv || typeof inv.items !== 'function') return 1;
    let red = 0;
    try {
      for (const it of inv.items()) red += ARMOR_REDUCTION[it.name] || 0;
    } catch (_) {}
    return Math.max(0.25, 1 - red);
  }

  /** The bot's own weapon damage, for the accounting math. */
  ownWeaponDamage() {
    const held = this.bot.heldItem || (this.bot.inventory && this.bot.inventory.selectedItem);
    if (!held || !held.name) return 1;
    return WEAPON_DAMAGE[held.name] || 1;
  }

  /** Our attack charge, 0..1 — the 1.9+ cooldown. mineflayer does not model it,
   * so it is derived from the swing interval: a sword needs ~600 ms for full charge. */
  cooldownProgress(now) {
    const ms = now - (this.lastSwingAt || 0);
    return Math.max(0, Math.min(1, ms / 600));
  }

  /* ---------------------------------------------------------------- *
   * main loop
   * ---------------------------------------------------------------- */

  async loop() {
    const bot = this.bot;
    while (this.running && !this.destroyed) {
      try {
        const cycleStart = Date.now();
        const t = this.target();
        if (!t) { this._handleTargetLost(); await sleep(250); continue; }

        // ---- OBSERVED OUTCOMES FIRST -------------------------------------
        // Everything the server told us beats everything we inferred, so the
        // win/loss check happens before any movement decision and cannot be
        // pre-empted by a drifted number.
        const outcome = this._checkOutcome(t);
        if (outcome) { this.stop(outcome.reason, outcome.result); return; }

        const dist = bot.entity.position.distanceTo(t.position);
        const hpInfo = this.opponentHealth();
        const hp = hpInfo.hp;
        const myHp = bot.health != null ? bot.health : 20;
        const tier = tierFor(this.tier);
        const now = cycleStart;

        // ---- ADVISOR (never awaited; reads a cache) ----------------------
        this._updateIntent(t, dist, hpInfo, myHp, tier, now);
        const intentAction = this._effectiveIntent(now);

        // ---- OUR OWN SURVIVAL --------------------------------------------
        // Fleeing our own low health is a *safety* rule, so the advisor cannot
        // veto it: a "savage" recommendation does not make a 2-heart bot able to
        // trade. The tier system would also happily walk forward into a 4-heart
        // opponent, which is how bots lose fights they should win.
        if (myHp <= this.retreatHp && myHp > 0) {
          await this._surviveRetreat(t, tier);
          await sleep(90);
          continue;
        }
        if (this.retreating && (myHp >= this.safeHp)) {
          this.retreating = false;
          this.log.info('pvp: ourselves recovered, re-engaging', { health: +myHp.toFixed(1) });
          M.clearAll(bot);
        }

        // ---- RETREAT ON THE OPPONENT'S HEALTH: estimate can only *pause* ---
        // This is the behavioural difference from the old code. Crossing the
        // threshold no longer ends the duel or declares victory; it makes the
        // bot stop swinging (no free hits, no pointless chip) and re-verify with
        // real signals for a bounded time. If the estimate was wrong, the bot
        // simply resumes — instead of running away from a fight it had won.
        if (hp <= this.retreatHp && hpInfo.source === 'estimate') {
          if (!this.retreating) {
            this.retreating = true;
            this.retreatUntil = now + this.verifyMs;
            this.log.warn('pvp: estimate says opponent is low — pausing attack to verify, not fleeing', {
              estimate: +hp.toFixed(1), hearts: hearts(hp), threshold: this.retreatHp,
              confirmedHitsOnThem: this.hitsConfirmed
            });
          }
          if (now > this.retreatUntil) {
            // Nothing observable happened. Before resuming, work out *why* the
            // estimate is low, because the three causes call for different
            // reactions and the old code answered all three by running away.
            const heal = this.vitals.lastHealAt || 0;
            const dmg = this.vitals.lastDamageAt || 0;
            const healedRecently = heal > dmg && now - heal < 12000;
            const reanchored = this.reanchorEstimate(t);
            if (this.hitsConfirmed === 0) {
              // We have never observed damage on them at all. That is not "we are
              // winning", it is "we cannot hurt them" — the general case of the
              // creative opponent, and the reason this bot used to flee fights it
              // claimed to have won.
              this.log.warn('pvp: estimate is low but no hit was ever observed — fighting a target we may not be able to hurt', {
                swings: this.hitsLanded, ignored: this.hitsIgnored, gamemode: this.vitals.gameMode
              });
              this.aiNoFightProbe = true;
            }
            this.retreating = false;
            // Re-anchor the arithmetic on what we have actually confirmed. A drift
            // is corrected once, and logged, instead of being trusted forever.
            this.estimate = Math.min(this.maxHealth, Math.max(this.estimate, reanchored));
            this.vitals.estimate = this.estimate;
            this.log.info('pvp: no confirmation of a low opponent, resuming', {
              estimate: +this.estimate.toFixed(1), confirmed: this.hitsConfirmed,
              healedRecently, reason: healedRecently ? 'they healed since our last hit'
                : (this.hitsConfirmed ? 'our damage model over-estimated (armour/enchants)' : 'no observable damage at all')
            });
          } else {
            await this._kite(t, tier);
            await sleep(120);
            continue;
          }
        } else if (hp <= this.retreatHp && hpInfo.source === 'server') {
          // A real health reading is an actual fact: disengage and hold spacing.
          if (!this.retreating) {
            this.retreating = true;
            this.log.warn('pvp: opponent confirmed low, disengaging', {
              hp: +hp.toFixed(1), hearts: hearts(hp), source: hpInfo.source
            });
          }
          await this._kite(t, tier);
          await sleep(120);
          continue;
        } else if (this.retreating && hp >= this.safeHp) {
          this.retreating = false;
          this.log.info('pvp: opponent recovered, re-engaging', { hp: +hp.toFixed(1), source: hpInfo.source });
          M.clearAll(bot);
        }

        // ---- MOVEMENT: spacing + orbit + terrain --------------------------
        if (now - this.lastReactAt > tier.reactionMs) {
          this.lastReactAt = now;
          // Awaited on purpose. The retreat/bait/disengage handlers call _kite(),
          // which sleeps and then writes the control states; left floating, the
          // loop raced ahead and overwrote them on the very next line, so the
          // "retreat" intent would have been visually indistinguishable from a
          // stall — the exact class of bug that only shows up as a bot standing
          // still while something is nominally happening.
          await this._position(t, dist, tier, intentAction);
        }

        // ---- ATTACK -------------------------------------------------------
        // Cooldown-aware: swinging at 30% charge does ~30% of the damage and
        // leaves you open. A hard bot waits for full charge; a rookie flails.
        const intentStopsAttack = intentAction === 'disengage' || intentAction === 'retreat' || intentAction === 'guard';
        const canSwing = !this.retreating && !intentStopsAttack &&
          !(this.stopSwingAt && now < this.stopSwingAt);
        if (canSwing && dist <= this.reach) {
          const ready = now - this.lastSwingAt > tier.swingCdMs;
          const charged = this.cooldownProgress(now) >= (this.tier > 0.55 ? 0.9 : 0.6);
          const desperate = myHp < 8;                 // when hurt, hit anyway
          if (ready && (charged || desperate)) {
            this.lastSwingAt = now;
            await this.swing(t, tier);
          }
        } else if (canSwing && dist > tier.holdRange + 0.4) {
          // Out of reach: press only with the tier's probability, and never
          // into a wall — the advisor cannot override that either.
          const press = Math.random() < lerp(0.4, 1, tier.pressure);
          if (press) this.lastMove = this._step(t, dist, tier, 'close');
        }

        // A non-retreating intent clears the disengage timer, so a single
        // "disengage" blip from a fluctuating classifier cannot end a duel.
        if (intentAction !== 'disengage') this._disengageSince = 0;

        if (this.autoEat) this._maybeEat();
      } catch (e) {
        this.log.debug('pvp: tick error', { error: e.message, stack: e.stack });
      }
      await sleep(110);
    }
    try { M.clearAll(bot); } catch (_) {}
  }

  _handleTargetLost() {
    const bot = this.bot;
    const wasFighting = this.hitsLanded > 0 || this.enemyHitsOnUs > 0;
    const p = bot.players && bot.players[this.targetName];
    const entityGone = !p || !p.entity;
    const tooFar = p && p.entity && bot.entity &&
      p.entity.position.distanceTo(bot.entity.position) > this.giveUpDist;
    let result = 'draw', reason = 'target lost';
    if (entityGone && wasFighting) {
      // They left the world mid-fight. If we had hit them and they were running,
      // that is a forfeit win; otherwise it is simply an end to the duel.
      result = 'win'; reason = 'opponent left the world';
    } else if (tooFar) {
      result = 'draw'; reason = 'opponent out of range';
    }
    this.log.info('pvp: target lost', { entityGone, tooFar, result, reason });
    M.clearAll(bot);
    this.stop(reason, result);
  }

  /**
   * Only observed facts can end a fight here.
   * Returns { result, reason } or null.
   */
  _checkOutcome(t) {
    const v = this.vitals;
    if (v.dead) return { result: 'win', reason: 'opponent died' };
    if (this.tracker && this.tracker.myVitals.dead) return { result: 'loss', reason: 'we died' };
    const gm = v.gameMode || gameModeOf(this.bot, this.targetName);
    if (gm && isUnkillable(gm)) {
      return { result: 'no-fight', reason: `opponent is in ${gm} mode and cannot be damaged` };
    }
    // Creative/hacked clients can also show up as simply *unkillable*: we land
    // hits the server confirms, and nothing ever changes.
    if (v.known && v.confirmed != null && this.hitsConfirmed >= 4 && v.confirmed >= this.maxHealth - 0.5) {
      return { result: 'no-fight', reason: 'opponent took no damage over 4 confirmed hits (invulnerable?)' };
    }
    if (!this.hitsConfirmed) {
      // Several swings, zero observed damage, and no gamemode to explain it: the
      // most likely answer is an invulnerable or untrackable target. Say that as
      // the result rather than fighting forever or claiming a win.
      if (this.hitsLanded >= 8 && this.hitsIgnored >= 8 && !this.vitals.gameMode) {
        return { result: 'no-fight', reason: 'no damage ever observed on the opponent' };
      }
      if (Date.now() - this.startAt > this.maxFightMs) {
        return { result: 'draw', reason: 'time limit with no confirmed damage' };
      }
    }
    if (this.tracker) {
      const verd = this.tracker.verdict(Date.now(), this.idleDrawMs);
      if (verd === 'draw') return { result: 'draw', reason: 'no damage or swings for ' + Math.round(this.idleDrawMs / 1000) + 's' };
      if (verd === 'loss') return { result: 'loss', reason: 'we died' };
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * the advisor (Jev)
   * ---------------------------------------------------------------- */

  /** Ask (or refresh) the external decision, without ever blocking this loop. */
  _updateIntent(t, dist, hpInfo, myHp, tier, now) {
    if (this.ai === 'off' || !this.jev) return;
    const bot = this.bot;
    const local = this._localIntent(dist, myHp, tier);
    const ctx = {
      gameName: this.targetName,
      botName: bot.username,
      distance: dist,
      tier: this.tier,
      ourCooldownProgress: this.cooldownProgress(now),
      self: {
        hp: +myHp.toFixed(1),
        hearts: hearts(myHp),
        food: bot.food != null ? bot.food : null,
        weapon: (bot.heldItem && bot.heldItem.name) || 'fist',
        weaponDamage: this.ownWeaponDamage(),
        armor: this.ownArmorFactor(),
        gamemode: ownGameMode(bot)
      },
      target: {
        hpEstimate: +hpInfo.hp.toFixed(1),
        hpSource: hpInfo.source,
        gamemode: this.vitals.gameMode || gameModeOf(bot, this.targetName),
        weapon: (t.equipment && t.equipment[0] && t.equipment[0].name) || 'unknown',
        hitsTaken: Math.round(this.vitals.damageSeen),
        missed: this.vitals.missedAttacks
      },
      world: this._worldFacts(t),
      rules: { engagement: this.retreating ? 'the bot is currently verifying a low-health estimate' : 'live duel' }
    };
    const { state, questions } = buildFightPrompt(ctx);
    // One cache slot per duel: the state text churns every cycle (charge, distance,
    // estimate), so without a stable key every answer would be a cache miss and the
    // advisor would never be seen by the loop it is supposed to steer.
    const key = `pvp:${this.targetName}`;
    // Fire a refresh and use whatever is currently cached — never await it.
    this.jev.prefetch(state, questions, { key, ttlMs: this.cfg.aiTtlMs || 1200 });
    const answers = this.jev.peek(state, questions, { key, staleMs: this.cfg.aiStaleMs || 5000 });
    const intent = interpretFight(answers, ctx);
    if (intent) {
      const changed = !this.intent || this.intent.action !== intent.action;
      this.intent = intent;
      this.intentContext = ctx;
      if (changed) {
        this.log.info('pvp: ai intent', {
          action: intent.action, confidence: intent.confidence != null ? +intent.confidence.toFixed(2) : null,
          aggression: intent.aggression != null ? +intent.aggression.toFixed(2) : null,
          risk: intent.risk != null ? +intent.risk.toFixed(2) : null,
          localWouldChoose: local,
          alternatives: intent.alternatives
        });
      }
    }
  }

  _worldFacts(t) {
    const bot = this.bot;
    const facts = {};
    try {
      facts.timeOfDay = bot.time ? bot.time.timeOfDay : null;
      facts.isNight = bot.time ? (bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458) : false;
      facts.mobCount = this.actor && this.actor.countHostilesNear ? this.actor.countHostilesNear(16) : 0;
      facts.mobRadius = 16;
      const here = T.columnInfo(bot, Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.z), bot.entity.position.y);
      const there = T.columnInfo(bot, Math.floor(t.position.x), Math.floor(t.position.z), t.position.y);
      if (here && there) {
        facts.elevationDiff = here.y - there.y;
        facts.nearCliff = here.dropBeyond > 2 || there.dropBeyond > 2;
      }
      facts.inWater = M.inWater(bot);
      facts.botInHole = here ? here.y - Math.floor(bot.entity.position.y) <= -1 : false;
    } catch (_) { /* facts are optional */ }
    return facts;
  }

  /**
   * The intent to act on: the advisor's, when it is fresh, confident, and legal;
   * otherwise the tier system's own. Safety vetoes always win.
   */
  _effectiveIntent(now) {
    const local = this._localIntent(
      this.bot.entity && this.target() ? this.bot.entity.position.distanceTo(this.target().position) : 5,
      this.bot.health != null ? this.bot.health : 20,
      tierFor(this.tier));
    if (this.ai === 'off' || !this.intent) return local;
    if (now - this.intent.at > (this.cfg.aiStaleMs || 5000)) return local;
    // A model that is not confident is not an authority.
    if (this.intent.confident === false) return local;
    let action = this.intent.action;
    // `force` mode = the AI decides and the bot obeys, which is what an
    // experiment wants; `assist` = the AI only nudges within safe bounds.
    if (this.ai === 'assist') {
      const safe = ['strafe', 'space', 'press', 'bait', 'guard', 'attack'];
      if (!safe.includes(action)) return local;
    }
    if (!PVP_ACTIONS.includes(action)) return local;
    if (now - this.intentAppliedAt > 400) {
      this.appliedIntent = action;
      this.intentAppliedAt = now;
    }
    return this.appliedIntent || action;
  }

  /** What the tier system would do with no outside help. */
  _localIntent(dist, myHp, tier) {
    if (myHp < 8) return 'retreat';
    if (dist > this.reach + 1) return 'press';
    if (dist < this.reach - 0.6) return Math.random() < tier.orbit ? 'strafe' : 'attack';
    return tier.orbit > 0.5 ? 'strafe' : 'space';
  }

  /**
   * Re-anchor the health estimate on *confirmed* hits after a verification pause.
   *
   * The estimate only ever went down before. Every cause of drift — a swing that
   * visually missed, a shield, an enchantment that reduced damage, a golden apple,
   * a relog at full health — pushed it toward zero, and zero read as "we won". So
   * on resume it is rebuilt from the one thing we know: the hits the server
   * confirmed, times the damage our weapon can actually do through their visible
   * armour. That is an upper bound on the damage dealt, which is exactly the
   * correction a counting player applies when they realise they miscounted.
   *
   * Zero confirmed hits therefore re-anchors to FULL health, which is the honest
   * reading of "we have never observed them take damage" and the case that used to
   * end in the bot believing it had beaten a creative player.
   *
   * Extracted as a method so the arithmetic is testable without racing the loop.
   */
  reanchorEstimate(t) {
    const perHit = this.ownWeaponDamage() * this.armorFactor(t || { equipment: [] });
    const floorFromConfirmed = this.maxHealth - this.hitsConfirmed * perHit;
    return Math.max(this.estimate, Math.min(this.maxHealth, floorFromConfirmed));
  }

  /* ---------------------------------------------------------------- *
   * movement: spacing, orbit, and terrain
   * ---------------------------------------------------------------- */

  async _position(t, dist, tier, intentAction) {
    const bot = this.bot;
    const moved = !this.targetLastPos || t.position.distanceTo(this.targetLastPos) > 0.5;
    if (moved) this.targetLastPos = t.position.clone();

    // facing the opponent is not optional in PvP; it happens even while sidestepping
    const err = tier.aimError + (Math.random() * 2 - 1) * tier.jitter;
    M.face(bot, t.position, { yawError: err, pitchError: (Math.random() * 2 - 1) * tier.jitter });

    // The four intents below own the controls entirely; the orbit/step logic
    // must not also run, or two writers fight over `forward` and the bot does
    // neither. Every one of them is terrain-gated through movement.js, because
    // "retreat" that walks off a ledge is not a retreat.
    if (intentAction === 'guard') return this._guard(t, dist, tier);
    if (intentAction === 'retreat') return this._retreatSpacing(t, dist, tier);
    if (intentAction === 'bait') return this._bait(t, dist, tier);
    if (intentAction === 'disengage') return this._disengage(t, dist, tier);

    // Orbit is the single biggest tier-dependent improvement: a bot that only
    // moves on the axis toward you is trivial to lead and to knock back. Circling
    // at the edge of reach makes you move, and movement.js will not let the
    // circle walk off a cliff — which is the whole "flat ground only" complaint.
    const wantRange = tier.holdRange;
    const orbitBias = intentAction === 'strafe' ? 1 : intentAction === 'press' ? 0.35 : 0;
    const useOrbit = orbitBias > 0 || Math.random() < tier.orbit;

    if (useOrbit) {
      if (bot.entity.yaw == null) return;
      // re-pick the circle direction occasionally, so it is not a predictable ring
      if (Date.now() - this.lastStrafeAt > tier.strafeChangeMs) {
        this.lastStrafeAt = Date.now();
        if (Math.random() < tier.strafeChance || orbitBias > 0) {
          this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        }
      }
      // Orbiting holds the line, so this is where the conservative budget belongs:
      // circling along a rim must never step off it.
      this.lastMove = M.orbit(bot, t.position, wantRange, this.strafeDir, {
        want: wantRange,
        allowFall: false,
        maxDrop: this.maxDrop,
        hop: this.hopEnabled,
        // Orbit *with* sprint: a strafing circle is still forward locomotion in
        // prismarine-physics (`sprint` adds the speed modifier regardless of the
        // strafe axis), so holding it makes the bot noticeably harder to lead —
        // the original "feels slow" complaint. Kept off only when the caller is
        // deliberately holding the line at low speed.
        sprint: true,
        strafe: orbitBias || undefined
      });
      return;
    }
    this.lastMove = this._step(t, dist, tier, intentAction === 'attack' ? 'close' : 'hold');
  }

  /**
   * Hold ground without offering a knockback angle: sneak, keep facing, stop
   * moving. Sneaking also prevents falling off the edge of what we stand on, and
   * a stationary crouching target cannot be comboed into a pit.
   */
  _guard(t, dist, tier) {
    const bot = this.bot;
    M.clearAll(bot);
    M.set(bot, 'sneak', true);
    this.lastMove = 'guard';
    void dist; void tier;
  }

  /**
   * Create distance deliberately, as a *decision* rather than a panic. Uses the
   * same escape scoring as the survival layer, so the bot backs off onto ground
   * it can stand on instead of into a wall, and if backing off is blocked it
   * orbits rather than freezing with `forward` held against geometry.
   */
  _retreatSpacing(t, dist, tier) {
    const bot = this.bot;
    const spot = T.escapeSpot(bot, bot.entity.position, t.position, { radius: 8, minGap: Math.max(4, tier.holdRange) });
    if (spot) {
      const way = M.walkToward(bot, spot, { allowFall: true, maxDrop: this.descendMax, hop: this.hopEnabled, sprint: dist < 2 });
      this.lastMove = 'retreat-' + way;
      if (way === 'blocked') M.orbit(bot, t.position, tier.holdRange + 1.5, this.strafeDir, { allowFall: false, maxDrop: this.maxDrop });
      return;
    }
    this._kite(t, tier);
  }

  /**
   * Bait: step into their reach, then pull back out of it, so they swing at
   * nothing. A whiffed swing is a cooldown the opponent is not spending on us and
   * (from perception) a counted miss, which is how the bot learns whether the
   * other player is actually dangerous. The cycle is bounded so it cannot turn
   * into dancing in front of a creeper forever.
   */
  _bait(t, dist, tier) {
    const bot = this.bot;
    const now = Date.now();
    if (!this._baitPhaseAt || now - this._baitPhaseAt > 1100) {
      this._baitPhaseAt = now;
      this._baitIn = !this._baitIn;
    }
    const from = bot.entity.position;
    const dx = t.position.x - from.x, dz = t.position.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    // in: close to just inside their reach; out: back past our own
    const reach = this._baitIn ? Math.max(1.6, this.reach - 0.5) : tier.holdRange + 1.2;
    const goal = { x: from.x + (dx / len) * (dist - reach), z: from.z + (dz / len) * (dist - reach) };
    const way = M.walkToward(bot, goal, { allowFall: false, maxDrop: this.maxDrop, hop: this.hopEnabled });
    this.lastMove = `bait-${this._baitIn ? 'in' : 'out'}:${way}`;
    if (way === 'blocked') M.orbit(bot, t.position, tier.holdRange, this.strafeDir, { allowFall: false });
  }

  /**
   * Leave the fight: stop attacking, put distance behind cover, and if the
   * advisor keeps asking for it, end the duel cleanly rather than orbiting away
   * from an opponent forever. A persistent disengage request is information about
   * the fight (unkillable target, bad odds, a third player joining), and the honest
   * answer is to quit with a stated reason, not to pace around the arena.
   */
  _disengage(t, dist, tier) {
    const bot = this.bot;
    this.stopSwingAt = Date.now() + 4000;
    const spot = T.escapeSpot(bot, bot.entity.position, t.position, { radius: 14, minGap: 8 });
    if (spot) {
      const way = M.walkToward(bot, spot, { allowFall: true, maxDrop: 3, hop: this.hopEnabled, sprint: true });
      this.lastMove = 'disengage-' + way;
    } else {
      this._kite(t, tier);
    }
    // Held this long in a row => honour it as a real withdrawal.
    if (!this._disengageSince) this._disengageSince = Date.now();
    else if (Date.now() - this._disengageSince > (this.cfg.disengageMs != null ? this.cfg.disengageMs : 8000)) {
      this.log.warn('pvp: advisor held disengage, leaving the duel', {
        seconds: ((Date.now() - this._disengageSince) / 1000).toFixed(1), dist: +dist.toFixed(1)
      });
      this.stop('advisor disengage', 'forfeit');
    }
    void tier;
  }

  /**
   * Move along the line to/away from the opponent, *with* terrain handling.
   * This is the fix for "it doesn't jump": a step is jumped as part of the walk,
   * and it is held rather than pulsed.
   */
  _step(t, dist, tier, mode) {
    const bot = this.bot;
    const from = bot.entity.position;
    const dx = t.position.x - from.x, dz = t.position.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const want = tier.holdRange;
    let target;
    if (mode === 'close' || dist > want + 0.4) {
      // aim *past* them slightly so we do not stop exactly at the collision box
      const reach = Math.max(0.6, dist - (mode === 'close' ? 1.4 : 0.6));
      target = { x: from.x + ux * reach, z: from.z + uz * reach };
    } else if (dist < want - 0.5) {
      target = { x: from.x - ux * 1.6, z: from.z - uz * 1.6 };
    } else {
      M.clearAll(bot);
      return 'hold';
    }
    return M.walkToward(bot, target, {
      // Closing must be able to go downhill: a target one or two blocks lower is
      // still a target, and a bot that will not step down simply never fights on
      // real terrain. `descendMax` is bounded by fall damage, and the ledge check
      // still refuses anything deeper than that.
      allowFall: true,
      maxDrop: this.descendMax,
      hop: this.hopEnabled,
      // Sprint whenever we are actually closing ground (reported: "when it is
      // pvping, it doesn't seem capable of sprinting, which makes it feel slow").
      // The old gate was `tier > 0.6 && dist > 6`, so a hard duelist walked the
      // whole approach and only sprinted while still far away — and never in the
      // last, most-visible six blocks. movement.js already refuses sprint on a
      // step/jump/hop and while off the ground, so it is safe to ask for it the
      // moment the target is more than a stride away.
      sprint: dist > 2.2,
      detour: true
    });
  }

  /** Hold spacing without committing to a hit — the "verifying" state. */
  async _kite(t, tier) {
    const bot = this.bot;
    M.face(bot, t.position, { yawError: tier.aimError * 0.5 });
    const from = bot.entity.position;
    const dx = from.x - t.position.x, dz = from.z - t.position.z;
    const len = Math.hypot(dx, dz) || 1;
    // back off along the line, but let movement.js route around a wall rather
    // than grind into it (the old code held 'forward' away and froze on a step)
    const retreatTo = { x: from.x + (dx / len) * 2.2, z: from.z + (dz / len) * 2.2 };
    // Backing off may also be downhill; refusing it pins the bot to a wall while
    // it is being hit. Same bounded descent as closing.
    const way = M.walkToward(bot, retreatTo, { allowFall: true, maxDrop: this.descendMax, hop: this.hopEnabled });
    this.lastMove = 'kite-' + way;
    // if backing off is blocked, strafe instead of stopping — a still target is a free hit
    if (way === 'blocked') {
      M.orbit(bot, t.position, tier.holdRange + 1, this.strafeDir, { allowFall: false, maxDrop: this.maxDrop });
    }
    if (this.autoEat) this._maybeEat();
    await sleep(80);
  }

  /** Fleeing our own low health: keep hitting the retreat until we are safe. */
  async _surviveRetreat(t, tier) {
    const bot = this.bot;
    if (!this.retreating) {
      this.retreating = true;
      this.log.warn('pvp: we are low, retreating', { health: +(bot.health || 0).toFixed(1), hearts: hearts(bot.health) });
    }
    const threat = t.position;
    const spot = T.escapeSpot(bot, bot.entity.position, threat, { radius: 12, minGap: 5 });
    if (spot) {
      M.face(bot, threat, {});                       // never run blind
      this.lastMove = M.walkToward(bot, spot, { allowFall: true, maxDrop: 3, hop: this.hopEnabled, sprint: this.tier > 0.4 });
      if (this.lastMove === 'blocked') M.orbit(bot, threat, tier.holdRange + 2, this.strafeDir, { allowFall: false });
    } else {
      await this._kite(t, tier);
    }
    if (this.autoEat) this._maybeEat();
    await sleep(120);
  }

  _maybeEat() {
    const bot = this.bot;
    if (!this.actor || typeof this.actor.eat !== 'function') return;
    const food = bot.food != null ? bot.food : 20;
    const hp = bot.health != null ? bot.health : 20;
    // 18 is the natural-regeneration floor in 1.9+, so eating below it keeps our
    // own HP recovering during a duel; 17 (the old gate) was under that line, so
    // a duelist at 17 food could neither regen nor be told to eat. A hurt
    // duelist tops up to full food — healing is worth more than the swing it costs.
    const want = hp < 20 ? 20 : 18;
    if (food < want && !this.actor.eating) {
      if (!this._lastEatAt || Date.now() - this._lastEatAt > 9000) {
        this._lastEatAt = Date.now();
        this.actor.eat().catch(() => {});
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * attacking
   * ---------------------------------------------------------------- */

  async swing(t, tier) {
    const bot = this.bot;
    // Intentional misses: a rookie sometimes swings where you are not.
    if (Math.random() < tier.missChance) {
      const y = (bot.entity.yaw || 0) + (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6);
      await M.face(bot, t.position, { yawError: y - (bot.entity.yaw || 0) });
    }
    const before = this.estimate;
    const hurtBefore = this.vitals.lastDamageAt || 0;
    const ourHpBefore = bot.health != null ? bot.health : 20;
    try { await bot.attack(t, true); } catch (_) { return; }

    this.hitsLanded++;
    this.lastHitAt = Date.now();

    // Give the server a moment to answer with `animation`/`damage_event`. If it
    // does, that is a *confirmed* hit and it re-anchors the estimate. If it does
    // not, the swing connected with nothing (out of reach, shield, or the
    // opponent is not taking damage) and we do not get to count it.
    await sleep(140);
    const confirmed = this.vitals.lastDamageAt > hurtBefore ||
      !!(this.tracker && this.tracker.lastHitLandedAt && this.tracker.lastHitLandedAt > this.lastHitAt - 400);
    if (confirmed) {
      this.hitsConfirmed++;
      // Calibrate on real numbers where we can, and on our weapon's face value
      // (scaled by armour) where we cannot.
      const dmg = this.vitals.known && this.vitals.confirmed != null && before > this.vitals.health
        ? before - this.vitals.health
        : this.ownWeaponDamage() * this.armorFactor(t) * Math.max(0.35, this.cooldownProgress(Date.now()));
      this.estimate = Math.max(0, Math.min(this.maxHealth, this.estimate - dmg));
      this.vitals.onHurt(dmg);
      this.log.info('pvp: hit confirmed', {
        hits: this.hitsLanded, confirmed: this.hitsConfirmed, dealt: +dmg.toFixed(1),
        estHealth: { before: +before.toFixed(1), after: +this.estimate.toFixed(1) },
        hearts: hearts(this.estimate), threshold: this.retreatHp,
        source: this.vitals.known ? 'server' : 'estimate'
      });
    } else {
      this.hitsIgnored++;
      this.log.debug('pvp: swing produced no damage signal', {
        hits: this.hitsLanded, ignored: this.hitsIgnored,
        reason: this.vitals.gameMode === 'creative' ? 'creative opponent' : 'no damage packet'
      });
      // Repeatedly landing swings that change nothing is information: it is the
      // signature of an unkillable opponent, and `_checkOutcome` acts on it.
      if (this.hitsIgnored >= 6 && !this.hitsConfirmed) {
        this.log.warn('pvp: 6 swings with no observable effect — opponent may be invulnerable', {
          gamemode: this.vitals.gameMode
        });
      }
    }
    // Counting their hits on us is how a human knows they are losing; it is also
    // the one thing that can legitimately make this bot retreat.
    if (bot.health != null && bot.health < ourHpBefore) this.enemyHitsOnUs++;
  }

  /* ---------------------------------------------------------------- *
   * reporting
   * ---------------------------------------------------------------- */

  summary() {
    const bot = this.bot;
    return {
      running: this.running,
      target: this.targetName,
      tier: +this.tier.toFixed(2),
      result: this.result,
      resultReason: this.resultReason,
      durationMs: this.startAt ? Date.now() - this.startAt : 0,
      opponent: {
        // The distinction the old code never made, and the one the user needed.
        healthEstimate: +this.estimate.toFixed(1),
        estimateHearts: hearts(this.estimate),
        observedHealth: this.vitals.confirmed,
        observedSource: this.vitals.known ? 'server' : 'none',
        gamemode: this.vitals.gameMode || gameModeOf(bot, this.targetName) || 'unknown',
        confirmedHitsTaken: this.vitals.damageSeen ? Math.round(this.vitals.damageSeen) : 0,
        dead: this.vitals.dead
      },
      self: {
        health: bot.health, hearts: hearts(bot.health),
        gamemode: ownGameMode(bot),
        weapon: (bot.heldItem && bot.heldItem.name) || null,
        food: bot.food
      },
      counts: {
        swings: this.hitsLanded,
        confirmedHits: this.hitsConfirmed,
        swingsWithNoEffect: this.hitsIgnored,
        hitsTakenByUs: this.enemyHitsOnUs
      },
      retreating: this.retreating,
      lastMove: this.lastMove,
      ai: this.ai === 'off' ? null : {
        mode: this.ai,
        last: this.intent ? { action: this.intent.action, confidence: this.intent.confidence, aggression: this.intent.aggression, risk: this.intent.risk } : null,
        applied: this.appliedIntent || null,
        client: this.jev ? this.jev.snapshot() : null
      }
    };
  }

  destroy() {
    this.destroyed = true;
    this.stop('destroyed');
  }
}

function num(v, d) { return v != null && Number.isFinite(Number(v)) ? Number(v) : d; }

function sleep(ms) { return new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); }

module.exports = { PvpController, tierFor, TIERS, WEAPON_DAMAGE, ARMOR_REDUCTION };
