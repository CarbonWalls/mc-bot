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
 * THE HEALTH PROBLEM
 * ------------------
 * The server never sends another player's health to a vanilla client —
 * verified empirically: `entity.health`, `metadata.health` and the attribute
 * snapshot are all undefined for other players. (Some modded servers broadcast
 * it; this one does not.) So "stop when the opponent is at 3 hearts" cannot be
 * read. It is *accounted* instead: every hit the bot lands subtracts the
 * weapon's damage, reduced by the opponent's visible armour. When the estimate
 * reaches the retreat threshold the bot disengages and runs. This is exactly
 * what a human does — count hits, not read a bar. The estimate is exposed in
 * the log and status so it can be corrected mid-fight (`pvp hp <n>`).
 *
 * DIFFICULTY
 * ----------
 * Tiers tune the human-ness rather than raw damage. A "hard" bot is not one
 * that hits harder (that would be cheating — the damage is identical); it is
 * one that spaces better, strafes, resets its cooldown, and does not stand in
 * your reach. Each tier is a knob set, not a behaviour fork, so the spectrum is
 * continuous: `pvp ENC_7376484R 0.7` is between medium and hard.
 *
 *   0.0 rookie   walks in a straight line, only swings when you are already
 *                touching it, slow reactions, sometimes swings at nothing
 *   0.5 medium   keeps a loose spacing, strafes occasionally, mostly respects
 *                its attack cooldown
 *   1.0 hard     holds exactly the edge of its own reach, strafes continuously
 *                with direction changes, jumps to reset sprint knockback,
 *                pressures you while you are swinging and disengages the
 *                instant its own spacing breaks
 */

const Vec3 = require('vec3').Vec3 || require('vec3');

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
    jitter: 0.4           // extra aim noise
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
    jitter: 0.08
  }
};

// Vanilla per-hit damage by tool class, at full attack cooldown. Used only for
// the opponent's *health estimate*; the real damage is whatever the server
// applies. Bare fist is 1.
const WEAPON_DAMAGE = {
  'diamond_sword': 7, 'netherite_sword': 8, 'iron_sword': 6, 'stone_sword': 5,
  'golden_sword': 4, 'wooden_sword': 4,
  'diamond_axe': 9, 'netherite_axe': 10, 'iron_axe': 7, 'stone_axe': 6,
  'golden_axe': 4, 'wooden_axe': 3
};

// Vanilla armour damage reduction per piece (chest/legs/helmet/boots). This is
// an approximation of the reduction formula — close enough for a health
// estimate, and the error is bounded and corrected by `pvp hp`.
const ARMOR_REDUCTION = {
  'diamond_helmet': 0.08, 'diamond_chestplate': 0.24, 'diamond_leggings': 0.18, 'diamond_boots': 0.08,
  'netherite_helmet': 0.09, 'netherite_chestplate': 0.28, 'netherite_leggings': 0.22, 'netherite_boots': 0.09,
  'iron_helmet': 0.06, 'iron_chestplate': 0.18, 'iron_leggings': 0.13, 'iron_boots': 0.05,
  'golden_helmet': 0.05, 'golden_chestplate': 0.15, 'golden_leggings': 0.11, 'golden_boots': 0.04,
  'chainmail_helmet': 0.05, 'chainmail_chestplate': 0.15, 'chainmail_leggings': 0.11, 'chainmail_boots': 0.04,
  'leather_helmet': 0.04, 'leather_chestplate': 0.11, 'leather_leggings': 0.08, 'leather_boots': 0.03,
  'turtle_helmet': 0.05
};

function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

function tierFor(t) {
  const tt = Math.max(0, Math.min(1, t));
  const out = {};
  for (const k of Object.keys(TIERS.rookie)) out[k] = lerp(TIERS.rookie[k], TIERS.hard[k], tt);
  return out;
}

class PvpController {
  /**
   * @param {object} bot   mineflayer bot
   * @param {object} deps  { logger, actor, cfg } — actor is used only to
   *                       stash/restore mode around a retreat, and to read home
   */
  constructor(bot, deps) {
    this.bot = bot;
    this.log = deps.logger;
    this.actor = deps.actor;
    this.cfg = (deps.cfg && deps.cfg.pvp) || {};

    this.running = false;
    this.targetName = null;
    this.tier = 0.5;

    // Damage bookkeeping
    this.estimate = 20;     // opponent's presumed health, starts full
    this.maxHealth = 20;
    this.hitsLanded = 0;
    this.lastHitAt = 0;

    // Timing
    this.lastSwingAt = 0;
    this.lastStrafeAt = 0;
    this.strafeDir = 1;
    this.lastReactAt = 0;
    this.targetLastPos = null;

    // Retreat state
    this.retreating = false;
    this.retreatUntil = 0;

    // Tunables (overridable via cfg.pvp)
    this.retreatHp = this.cfg.retreatHp != null ? this.cfg.retreatHp : 6;   // 3 hearts
    this.safeHp = this.cfg.safeHp != null ? this.cfg.safeHp : 12;          // re-engage above this
    this.giveUpDist = this.cfg.giveUpDist != null ? this.cfg.giveUpDist : 40;
    this.engageRange = this.cfg.engageRange != null ? this.cfg.engageRange : 20;
    this.reach = this.cfg.reach != null ? this.cfg.reach : 3.0;            // server melee reach
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
    this.estimate = 20;
    this.hitsLanded = 0;
    bot.clearControlStates();
    this.log.info('pvp: engaging', { target: targetName, tier: +this.tier.toFixed(2), retreatHp: this.retreatHp });
    this.loop().catch(e => this.log.warn('pvp loop ended', { error: e.message }));
    return { ok: true, msg: `PvP vs ${targetName} (tier ${this.tier})` };
  }

  stop(reason) {
    if (!this.running) return { ok: true, msg: 'pvp already stopped' };
    this.running = false;
    this.retreating = false;
    try { this.bot.clearControlStates(); } catch (_) {}
    this.log.info('pvp: stopped', { reason: reason || 'manual', hits: this.hitsLanded, estHealth: +this.estimate.toFixed(1) });
    return { ok: true, msg: `PvP stopped (${reason || 'manual'})` };
  }

  /** Live correction of the health estimate, e.g. after eating. */
  setHealth(n) {
    this.estimate = Math.max(0, Math.min(this.maxHealth, parseFloat(n) || 20));
    this.log.info('pvp: health estimate corrected', { estimate: this.estimate });
    return { ok: true, msg: `Opponent health estimate set to ${this.estimate}` };
  }

  /* ---------------------------------------------------------------- *
   * targeting
   * ---------------------------------------------------------------- */

  target() {
    const bot = this.bot;
    if (!bot || !bot.players) return null;
    const p = bot.players[this.targetName];
    if (!p || !p.entity || !p.entity.position) return null;
    if (p.entity.position.distanceTo(bot.entity.position) > this.giveUpDist) return null;
    return p.entity;
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
    return Math.max(0.1, 1 - reduction);
  }

  /** The bot's own weapon damage, for the accounting math. */
  ownWeaponDamage() {
    const held = this.bot.heldItem;
    if (!held || !held.name) return 1;
    return WEAPON_DAMAGE[held.name] || 1;
  }

  /* ---------------------------------------------------------------- *
   * main loop
   * ---------------------------------------------------------------- */

  async loop() {
    const bot = this.bot;
    while (this.running && !this.destroyed) {
      try {
        const t = this.target();
        if (!t) {
          this.log.info('pvp: target lost or too far, stopping', { target: this.targetName });
          this.stop('target lost');
          return;
        }
        const dist = bot.entity.position.distanceTo(t.position);
        const hp = this.estimate;

        // --- RETREAT: opponent is at/under the heart threshold -------------
        // The bot stops attacking entirely and kites away. If the opponent
        // chases, it keeps running and re-plans the escape vector from the
        // opponent's *current* position each cycle, so following it does not
        // work — it curves away rather than beelining, and never lets the
        // gap close.
        if (hp <= this.retreatHp) {
          if (!this.retreating) {
            this.retreating = true;
            this.log.warn('pvp: opponent low, disengaging', { estHealth: +hp.toFixed(1), threshold: this.retreatHp });
          }
          await this.retreat(t);
          await sleep(200);
          continue;
        }
        if (this.retreating && hp >= this.safeHp) {
          this.retreating = false;
          this.log.info('pvp: opponent recovered, re-engaging', { estHealth: +hp.toFixed(1) });
          bot.clearControlStates();
        }

        // --- REACTION GATE ------------------------------------------------
        // A human does not snap to your new position instantly. The tier sets
        // how long it takes the bot to "notice" you moved.
        const moved = !this.targetLastPos || t.position.distanceTo(this.targetLastPos) > 0.5;
        if (moved) this.targetLastPos = t.position.clone();
        const tier = tierFor(this.tier);
        const now = Date.now();

        // --- MOVEMENT: hold spacing + strafe -------------------------------
        if (now - this.lastReactAt > tier.reactionMs) {
          this.lastReactAt = now;
          this.faceAndSpace(t, dist, tier);
        }
        if (now - this.lastStrafeAt > tier.strafeChangeMs) {
          this.lastStrafeAt = now;
          if (Math.random() < tier.strafeChance) {
            this.strafeDir = Math.random() < 0.5 ? -1 : 1;
            bot.setControlState('left', this.strafeDir < 0);
            bot.setControlState('right', this.strafeDir > 0);
          } else {
            bot.setControlState('left', false);
            bot.setControlState('right', false);
          }
        }

        // --- ATTACK: only in reach, off cooldown, and not while retreating --
        if (!this.retreating && dist <= this.reach) {
          if (now - this.lastSwingAt > tier.swingCdMs) {
            this.lastSwingAt = now;
            await this.swing(t, tier);
          }
        } else if (dist > this.reach + 0.6) {
          // Not in reach: a hard bot holds just outside and waits; a rookie
          // walks straight in. pressure decides how eagerly it closes.
          const close = Math.random() < tier.pressure;
          bot.setControlState('forward', close);
          bot.setControlState('sprint', close && this.tier > 0.6);
        }
      } catch (e) {
        this.log.debug('pvp: tick error', { error: e.message });
      }
      await sleep(120);
    }
    try { bot.clearControlStates(); } catch (_) {}
  }

  /* ---------------------------------------------------------------- *
   * actions
   * ---------------------------------------------------------------- */

  async faceAndSpace(t, dist, tier) {
    const bot = this.bot;
    try {
      // Aim at the opponent with deliberate error: a rookie's look is noisy,
      // a hard bot's is nearly true. Aim error also causes genuine misses
      // (the server validates that you are actually facing the target).
      const err = tier.aimError + (Math.random() * 2 - 1) * tier.jitter;
      const to = t.position.offset(0, 1.1, 0);
      const dx = to.x - bot.entity.position.x;
      const dz = to.z - bot.entity.position.z;
      const yaw = Math.atan2(-dx, -dz) + err;
      const dy = to.y - (bot.entity.position.y + 1.1);
      const horiz = Math.sqrt(dx * dx + dz * dz);
      const pitch = Math.atan2(dy, horiz) + (Math.random() * 2 - 1) * tier.jitter;
      const p = bot.look(yaw, pitch, true);
      if (p && typeof p.catch === 'function') await p.catch(() => {});
    } catch (_) {}

    // Spacing: back off when you are inside our reach and we are not
    // committing to a swing, so the bot is not a free hit.
    const want = tier.holdRange;
    if (dist < want - 0.4) {
      bot.setControlState('forward', false);
      bot.setControlState('back', true);
    } else if (dist > want + 0.4) {
      bot.setControlState('back', false);
      bot.setControlState('forward', true);
    } else {
      bot.setControlState('forward', false);
      bot.setControlState('back', false);
    }
  }

  async swing(t, tier) {
    const bot = this.bot;
    // Intentional misses: a rookie sometimes swings where you are not.
    if (Math.random() < tier.missChance) {
      try {
        const y = bot.entity.yaw + (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6);
        const p = bot.look(y, bot.entity.pitch, true);
        if (p && typeof p.catch === 'function') await p.catch(() => {});
      } catch (_) {}
    }
    const before = this.estimate;
    try { await bot.attack(t, true); } catch (_) { return; }

    // Account for the hit. The server does not tell us how much damage we
    // actually did, so subtract the expected amount reduced by visible armour.
    // Over time this drifts (enchantments, regen, absorption); `pvp hp <n>`
    // is the correction valve and the estimate is logged on every hit.
    const dmg = this.ownWeaponDamage() * this.armorFactor(t);
    this.estimate = Math.max(0, this.estimate - dmg);
    this.hitsLanded++;
    this.lastHitAt = Date.now();
    this.log.info('pvp: hit', {
      hits: this.hitsLanded, dealt: +dmg.toFixed(1),
      estHealth: { before: +before.toFixed(1), after: +this.estimate.toFixed(1) },
      threshold: this.retreatHp
    });
  }

  async retreat(t) {
    const bot = this.bot;
    bot.setControlState('forward', false);
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    // Sprint directly away, kiting if followed: the vector is recomputed from
    // the opponent's current position each call, so chasing the bot just
    // pushes it further — it never runs in a straight line into a wall for
    // long, and it will not turn to fight while under threshold.
    const from = bot.entity.position;
    const away = from.minus(t.position);
    const len = Math.sqrt(away.x * away.x + away.z * away.z) || 1;
    const yaw = Math.atan2(-away.x / len, -away.z / len);
    try {
      const p = bot.look(yaw, 0, true);
      if (p && typeof p.catch === 'function') await p.catch(() => {});
    } catch (_) {}
    bot.setControlState('back', false);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    // Jump to clear terrain while fleeing (and to shed sprint-knockback if a
    // pursuer lands a hit — a jumping target is harder to combo).
    if (Math.random() < 0.25) {
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 300);
    }
  }

  destroy() {
    this.destroyed = true;
    this.stop('destroyed');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { PvpController, tierFor, TIERS };
