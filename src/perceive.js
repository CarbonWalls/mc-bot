'use strict';

/**
 * Perception: what the server actually told us, as opposed to what we guessed.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two reported bugs share one root cause: the bot trusted a *model* of the
 * world where a *measurement* was available, and had no way to tell the other
 * players from the server that it was even allowed to fight them.
 *
 *   1. "It runs away even when it thinks it won, even if I was in creative."
 *      The opponent's health is not sent to a vanilla client, so the old code
 *      accounted for it: subtract weapon damage per hit, reduce by visible
 *      armour, and when the running total crossed a threshold, retreat. On a
 *      creative opponent that subtraction does two things at once: it "wins"
 *      (estimate hits the floor, so the bot claims victory) and it loses (the
 *      estimate falling is the bot's own bookkeeping, not an event, so any
 *      miscount — a swing that missed, a relog, a golden apple — reads as
 *      "opponent at 3 hearts, disengage"). Both halves are the same mistake:
 *      treating arithmetic as observation.
 *      This module separates the two. Every input here is a packet the server
 *      sent: `animation 1` (entity hurt), `animation 0` (arm swing), `death`,
 *      `entityRemove`, the `player_info` gamemode table, and our own
 *      `update_health`. An estimate is still kept, because you genuinely can
 *      count hits like a player does, but it is *labelled* as an estimate, it
 *      is re-anchored by real signals, and it can never on its own produce a
 *      "we won" or "we lost" verdict. Only a real signal can.
 *
 *   2. Everything downstream (PvP decisions, the TUI, the CLI) now reads
 *      health through one place, so "hearts" means the same thing in all of
 *      them: `hearts(h) = ceil(h / 2)`, the vanilla display.
 */

const GAMEMODE_NAMES = ['survival', 'creative', 'adventure', 'spectator'];

/** Vanilla hearts: 2 HP per heart, and a partial heart still shows as a heart. */
function hearts(hp) {
  if (hp == null || !Number.isFinite(hp)) return null;
  return Math.max(0, Math.ceil(hp / 2));
}

/**
 * How the server counts our own incoming damage. Not the weapon's face value:
 * the 1.9+ combat formula is base + (base - 1) * (cooldownProgress^2), so a
 * swing thrown at half charge does roughly 60% of the tooltip. The damage
 * tracker uses the observed drop to calibrate the weapon estimate, which is
 * what lets a single landed hit tell us something real.
 */
function damageFromDrop(before, after) {
  return Math.max(0, before - after);
}

/**
 * The opponent's game mode, from the server's own player_info list.
 * 0 survival, 1 creative, 2 adventure, 3 spectator.
 *
 * `bot.players[name].gamemode` is populated by mineflayer from
 * `player_info`/`player_gamemode` packets, which are broadcast to everyone in
 * the tab-list range. This is a real measurement — it is the difference
 * between "my arithmetic says I beat them" and "the server says they cannot
 * take damage at all".
 */
function gameModeOf(bot, name) {
  if (!bot || !name) return null;
  const table = bot.players || {};
  const p = table[name] || findByUsername(table, name);
  if (!p) return null;
  const gm = p.gamemode != null ? p.gamemode : (p.gameMode != null ? p.gameMode : null);
  if (typeof gm === 'string') return gm.toLowerCase();
  if (typeof gm === 'number' && gm >= 0 && gm < GAMEMODE_NAMES.length) return GAMEMODE_NAMES[gm];
  return null;
}

function findByUsername(table, name) {
  const want = String(name).toLowerCase();
  for (const k in table) if (k.toLowerCase() === want) return table[k];
  return null;
}

/** The bot's own game mode, or null when the server has not told us yet. */
function ownGameMode(bot) {
  const gm = bot && bot.game && bot.game.gameMode;
  if (!gm) return null;
  return typeof gm === 'string' ? gm.toLowerCase() : String(gm).toLowerCase();
}

/** True when the entity cannot take damage or does not care about fighting. */
function isUnkillable(mode) {
  return mode === 'creative' || mode === 'spectator';
}

/* ------------------------------------------------------------------ *
 * Vitals: real damage accounting for one entity
 * ------------------------------------------------------------------ */

/**
 * Tracks the *observable* health story of a single entity.
 *
 * `confirmed` is what we have seen; `estimate` is what we infer. They are never
 * merged, and callers must say which one they are acting on. That discipline is
 * the actual fix: retreat and victory decisions take `confirmed` when it
 * exists and only consult `estimate` as a tie-breaker, so a drifted number can
 * end a fight but can never invent one.
 */
class Vitals {
  /**
   * @param {object} opts  { maxHealth, known } — known=true when the server
   *                       has actually reported this entity's health (mobs,
   *                       and other players on modded servers).
   */
  constructor(opts = {}) {
    this.maxHealth = opts.maxHealth != null ? opts.maxHealth : 20;
    this.known = !!opts.known;
    this.confirmed = null;        // last health the SERVER reported
    this.estimate = this.maxHealth;
    this.damageSeen = 0;          // total damage in confirmed events
    this.damageGuessed = 0;       // total damage from our accounting
    this.lastDamageAt = 0;        // last confirmed hurt signal
    this.lastHealAt = 0;
    this.lastSwingAt = 0;         // they swung
    this.swingsWithoutDamage = 0; // swung at us and we took nothing => dodged/missed
    this.missedAttacks = 0;
    this.dead = false;
    this.deathAt = 0;
    this.eating = false;
    this.eatingAt = 0;
    this.lastSeenAt = Date.now();
    this.gameMode = null;
    // Calibration: the mean damage we have seen them take, once we can see it.
    this._dmgSamples = [];
  }

  /** The best number to display. `confirmed` wins whenever we have it. */
  get health() {
    if (this.known && this.confirmed != null) return this.confirmed;
    return this.estimate;
  }

  get hearts() { return hearts(this.health); }

  /** The source of `health`: 'server' | 'estimate'. */
  get source() { return (this.known && this.confirmed != null) ? 'server' : 'estimate'; }

  get hp() {
    if (this.known && this.confirmed != null) return +this.confirmed.toFixed(1);
    return +this.estimate.toFixed(1);
  }

  markSeen() { this.lastSeenAt = Date.now(); }

  /** A re-spawn / re-log event: the entity is present again. */
  onRevive() {
    this.dead = false;
    this.deathAt = 0;
    this.gone = 0;
    this.estimate = this.maxHealth;
    if (this.known) this.confirmed = this.maxHealth;
  }

  setMaxHealth(hp) {
    if (hp > 0 && hp <= 200) {
      this.maxHealth = hp;
      if (this.estimate > hp) this.estimate = hp;
    }
  }

  /** A confirmed hurt packet: the strongest real signal available. */
  onHurt(amountHint) {
    const now = Date.now();
    // Do NOT treat a damage packet as proof of life. A dead entity can keep
    // receiving swing/hurt packets for a moment (swing animations and
    // in-flight damage events are not synchronised with the death packet), and
    // clearing `dead` here made the bot swing at a corpse, erase its own win,
    // and keep the duel alive forever. Only an explicit signal — a positive
    // health reading, or a fresh spawn — may bring it back, and both are handled
    // in onHealth/onRevive below.
    if (this.dead && this.deathAt && now - this.deathAt < 5000) return;
    this.dead = false;
    this.lastDamageAt = now;
    if (this.known && this.confirmed != null) {
      this.damageSeen += 0;         // recomputed by onHealth()
      return;
    }
    // Without a health field, "they were hurt" is still a fact. Re-anchor the
    // estimate: count one more confirmed damage event than we have guessed, and
    // never let the estimate run ahead of what we have actually seen.
    const unit = Number.isFinite(amountHint) && amountHint > 0 ? amountHint : 1;
    this.damageSeen += unit;
    // Confirmed damage is a floor on the estimate: at most maxHealth - damageSeen
    this.estimate = Math.min(this.estimate, Math.max(0, this.maxHealth - this.damageSeen));
  }

  /** A real health value from the server (mobs, or a modded player). */
  onHealth(hp) {
    if (!Number.isFinite(hp)) return;
    if (this.confirmed != null && hp < this.confirmed) {
      this._dmgSamples.push(this.confirmed - hp);
      if (this._dmgSamples.length > 8) this._dmgSamples.shift();
      this.damageSeen += this.confirmed - hp;
      this.lastDamageAt = Date.now();
    } else if (this.confirmed != null && hp > this.confirmed) {
      this.lastHealAt = Date.now();
    }
    this.confirmed = hp;
    this.estimate = hp;             // a real value replaces the guess
    this.known = true;
    // A positive real health reading is proof of life: a player who died and
    // respawned (or logged back in at full health) legitimately clears `dead`.
    if (hp > 0) { this.dead = false; this.deathAt = 0; this.gone = 0; }
    else this.onDeath();
  }

  onHeal(amount = 1) {
    this.lastHealAt = Date.now();
    if (this.known && this.confirmed != null) return;   // the server will tell us
    this.estimate = Math.min(this.maxHealth, this.estimate + amount);
    this.damageGuessed = Math.max(0, this.damageGuessed - amount);
  }

  onEat(starts) {
    if (starts) { this.eating = true; this.eatingAt = Date.now(); }
    else if (this.eating) {
      this.eating = false;
      // Eating food at 9+ hunger regenerates over time; a golden apple heals
      // immediately. We cannot tell which, so treat it as "not low".
      this.onHeal(1);
    }
  }

  onSwing() { this.lastSwingAt = Date.now(); }

  /** They swung at us and we took no damage: a dodge, not a hit. */
  onSwingWithoutResult() {
    this.swingsWithoutDamage++;
    this.missedAttacks++;
  }

  onDeath() {
    if (!this.dead) {
      this.dead = true;
      this.deathAt = Date.now();
      this.confirmed = 0;
      this.estimate = 0;
    }
  }

  /**
   * How long since we last saw them do anything hostile. Used to decide
   * whether the fight is actually over.
   */
  quietFor(now = Date.now()) { return now - Math.max(this.lastDamageAt, this.lastSwingAt, this.lastSeenAt); }

  snapshot() {
    return {
      health: this.hp,
      hearts: this.hearts,
      max: this.maxHealth,
      source: this.source,
      damageSeen: +this.damageSeen.toFixed(1),
      confirmed: this.confirmed == null ? null : +this.confirmed.toFixed(1),
      estimate: +this.estimate.toFixed(1),
      dead: this.dead,
      eating: this.eating,
      missedAttacks: this.missedAttacks,
      lastDamageAgoMs: this.lastDamageAt ? Date.now() - this.lastDamageAt : null,
      gameMode: this.gameMode
    };
  }
}

/* ------------------------------------------------------------------ *
 * DamageTracker: wires the packet-level events into Vitals objects
 * ------------------------------------------------------------------ */

/**
 * One place that subscribes to everything the server sends about damage, so
 * the behaviour modules can ask questions instead of parsing packets.
 *
 * Events used (all real mineflayer, verified against the installed plugin):
 *   'health'            bot.health changed        -> our own confirmed HP
 *   'death'             we died
 * Verified against the installed mineflayer (recorded in
 * src/api_contract.json -> events), because a subscription to a name that does
 * not exist fails silently: the handler is never called and perception quietly
 * degrades back to arithmetic.
 *
 *   'health'            bot.health changed          -> our own confirmed HP
 *   'death'             we died (health.js)
 *   'respawn'           health.js
 *   'entityHurt'        (entity, source)            animation 1 / status 2 /
 *                                                   damage_event (1.20+ names the
 *                                                   attacker, hence `source`)
 *   'entitySwingArm'    (entity)                    animation 0 — an attack swing
 *   'entityDead'        (entity)                    status 3  (NOT entityDeath)
 *   'entityGone'        (entity)                    entity removed: relog/despawn
 *                                                   (NOT entityRemoved)
 *   'entitySpawn'       (entity)
 *   'entityUpdate'      (entity)                    metadata refresh; the place a
 *                                                   broadcast health can appear
 *                                                   (NOT entityMetadata)
 *   'itemDrop'          (entity)                    an item entity hit the world
 *   'playerJoined' / 'playerLeft' / 'playerUpdated'  player_info, carries gamemode
 *
 * There is no `bot.on('animation')`: the animation packet arrives on
 * bot._client and mineflayer re-emits it under the mapped names above, so
 * listening for 'animation' on the bot would catch nothing at all.
 */
class DamageTracker {
  /**
   * @param {object} bot
   * @param {object} deps { logger, reach } reach = how far a swing can plausibly
   *   be aimed at us, used to decide whether an arm swing was *at* us.
   */
  constructor(bot, deps = {}) {
    this.bot = bot;
    // A complete no-op logger. The previous default had only debug(), so any
    // later this.log.info(...) threw "log.info is not a function" for every
    // tracker built without an explicit logger - a crash that only appears when
    // a real gamemode change happens to arrive, i.e. exactly the case the log
    // line exists to report.
    this.log = deps.logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.reach = deps.reach != null ? deps.reach : 4.5;
    this.entities = new Map();       // entity id -> Vitals
    this.maxTracked = deps.maxTracked != null ? deps.maxTracked : 64;
    this._unwire = null;
    this.myVitals = new Vitals({ maxHealth: 20, known: true });
    this.myVitals.confirmed = bot.health != null ? bot.health : 20;
    this.lastSwingAt = 0;
    this.lastTargetSwingAt = 0;
    this.lastEngagedAt = Date.now();
    this.events = [];
    this._wire();
  }

  _wire() {
    const bot = this.bot;
    if (this._unwire) { try { this._unwire(); } catch (_) {} }
    const handlers = [];
    const on = (ev, fn) => { try { bot.on(ev, fn); handlers.push([ev, fn]); } catch (_) {} };

    on('health', () => {
      const h = bot.health != null ? bot.health : 20;
      const prev = this.myVitals.confirmed;
      this.myVitals.onHealth(h);
      this.myVitals.maxHealth = Math.max(this.myVitals.maxHealth, h);
      if (prev != null && h < prev) {
        this.lastHurtAt = Date.now();
        this.lastIncomingDamage = damageFromDrop(prev, h);
      } else if (prev != null && h > prev) {
        this.lastHealAt = Date.now();
      }
    });
    on('death', () => { this.myVitals.onDeath(); this.lastHurtAt = Date.now(); });
    on('respawn', () => {
      this.myVitals.dead = false;
      this.myVitals.confirmed = bot.health != null ? bot.health : 20;
      this.myVitals.estimate = this.myVitals.confirmed;
    });

    on('entityHurt', (entity, source) => {
      const v = this.of(entity);
      if (v) v.onHurt();
      if (entity && bot.entity && entity === bot.entity) this.lastHurtAt = Date.now();
      if (source && source === bot.entity) {
        // We are confirmed as the attacker of this entity: that is a hit that
        // landed, which is worth far more than our own arithmetic.
        this.lastHitLandedAt = Date.now();
        this.lastEngagedAt = Date.now();
        if (this.targetVitals && v === this.targetVitals) v.confirmedHit = (v.confirmedHit || 0) + 1;
      }
    });
    // mineflayer's status-3 event is named 'entityDead'. 'entityDeath' does not
    // exist; subscribing to it would mean never noticing a kill — the single most
    // important signal in a duel, and exactly the kind of silent failure the
    // contract test now guards.
    on('entityDead', (entity) => {
      const v = this.of(entity);
      if (v) v.onDeath();
      if (entity && entity === this.target) this.lastEngagedAt = Date.now();
    });
    on('entitySwingArm', (entity) => {
      if (!entity || entity === bot.entity) return;
      const v = this.of(entity);
      if (v) v.onSwing();
      if (this.target && entity === this.target) this.lastTargetSwingAt = Date.now();
    });
    on('entityUpdate', (entity) => {
      // mineflayer emits 'entityUpdate' after parsing metadata into a keyed
      // object; there is no 'entityMetadata' event, so listening for that name
      // would never see a broadcast health value.
      const v = this.of(entity);
      if (!v) return;
      const md = entity.metadata;
      let mh = null;
      if (md && typeof md === 'object') {
        if (!Array.isArray(md) && typeof md.health === 'number') mh = md.health;
        else if (Array.isArray(md)) {
          const hit = md.find(m => m && (m.key === 'health' || m.key === 6) && typeof m.value === 'number');
          if (hit) mh = hit.value;
        }
      }
      // A live server reports 0 for a corpse and never 0 for a healthy entity, so
      // accept any finite number: rejecting 0 here would drop the death reading.
      if (mh != null && Number.isFinite(mh) && mh >= 0) {
        if (mh > 0) v.setMaxHealth(Math.max(v.maxHealth, mh));
        v.known = true;
        v.onHealth(mh);
      }
    });
    on('entityGone', (entity) => {
      // 'entityRemoved' is not a mineflayer event name; the removal signal is
      // 'entityGone'. Missing it means never noticing that an opponent logged out
      // mid-duel, which is the difference between "won on forfeit" and "still
      // swinging at air".
      const v = this.of(entity);
      if (v) v.onRemoved(Date.now());
      if (entity && entity === this.target) this.targetGoneAt = Date.now();
      if (entity) {
        this.events.push({ at: Date.now(), kind: 'removed', name: entity.username || entity.displayName || String(entity.id) });
        if (this.events.length > 64) this.events.shift();
      }
    });
    on('entitySpawn', (entity) => {
      const v = this.of(entity);
      if (!v) return;
      v.markSeen();
      // A respawn packet after a death is a genuine return: clear the dead flag
      // through the sanctioned path rather than letting a stray damage event do it.
      if (v.dead && v.deathAt && Date.now() - v.deathAt > 250) v.onRevive();
    });
    on('itemDrop', (entity) => {
      // Item entities at a death spot are what recovery walks back for, and a
      // kill in a duel produces them too.
      if (!entity) return;
      this.lastDropAt = Date.now();
      this.drops = (this.drops || 0) + 1;
    });
    on('playerJoined', (player) => { this.noteGameMode(player); });
    on('playerUpdated', (player) => { this.noteGameMode(player); });

    // A player leaving the tab list mid-duel has left the world: a forfeit win.
    // ('playerGone' does not exist in this build; 'playerLeft' does.)
    on('playerLeft', (player) => {
      if (!player) return;
      if (player.username && player.username === this.targetName) this.targetLeftAt = Date.now();
      const v = (player.username && this.entities.get('name:' + player.username)) ||
        (player.uuid && this.byId(player.uuid)) || null;
      if (v) v.onRemoved(Date.now());
    });

    this._unwire = () => { for (const [ev, fn] of handlers) { try { bot.removeListener(ev, fn); } catch (_) {} } };
  }

  /**
   * Refresh the cached game mode for a player from a player_info update.
   *
   * Two bugs lived here, both found by watching a live duel refuse to start:
   *   - the lookup used 'name:'+username, but of() keys real entities by their
   *     numeric id (mineflayer always assigns one), so this NEVER found the
   *     vitals object a duel was actually reading; and
   *   - even when it did, the only other refresh fires when gameMode is still
   *     null, so a mid-session /gamemode flip was invisible: the bot cached
   *     'creative', the opponent switched to 'survival', and the bot kept
   *     declining a fight it had been invited to.
   * So resolve by username through the index of() maintains, and always rewrite
   * the value — a mode change is exactly the event this callback exists for.
   */
  noteGameMode(player) {
    if (!player || !player.username) return;
    const v = this.byUsername(player.username);
    if (!v) return;
    const gm = gameModeOf(this.bot, player.username);
    if (gm !== undefined && gm !== v.gameMode) {
      this.log.info('perception: gamemode changed', { player: player.username, from: v.gameMode, to: gm });
    }
    if (gm != null) v.gameMode = gm;
  }

  /** The Vitals for a username, whichever key of() happened to use. */
  byUsername(username) {
    if (!username) return null;
    const byName = this.entities.get('name:' + username);
    if (byName) return byName;
    for (const [k, v] of this.entities) {
      if (v && v.username === username) return v;
    }
    return null;
  }

  /** A stable key for an entity: the id when there is one, else the username. */
  static keyOf(entity) {
    if (!entity) return null;
    if (entity.id != null) return entity.id;
    if (entity.username) return 'name:' + entity.username;
    if (entity.uuid) return 'uuid:' + entity.uuid;
    return null;
  }

  /** Vitals for a mineflayer entity object (creating on first use). */
  of(entity) {
    if (!entity) return null;
    const k = DamageTracker.keyOf(entity);
    // Entities without an id are not a hard error: key them by identity so
    // perception still works. Returning null here used to disable the whole
    // damage layer silently, which is what made `pvp` crash on a mock entity and
    // would, on a live server, revert the bot to the arithmetic-only behaviour
    // this module exists to replace.
    if (k == null) return null;
    let v = this.entities.get(k);
    if (!v) {
      // Bounded: a long session sees thousands of transient entities (items,
      // XP orbs, mobs that spawn and despawn), and an ever-growing Vitals map
      // would quietly break the memory ceiling this project documents and tests.
      // Eviction is by last-seen time, so whoever we are actually fighting or
      // fleeing is never the thing that gets dropped.
      if (this.entities.size >= (this.maxTracked || 64)) this._evict();
      const isPlayer = !!entity.username || entity.type === 'player' || entity.kind === 'player';
      // Mobs report health through entity metadata on most servers; players
      // never do on a vanilla one. Start optimistic and let a real packet flip
      // `known`.
      v = new Vitals({
        maxHealth: isPlayer ? 20 : (entity.health != null ? entity.health : 20),
        known: !isPlayer && entity.health != null
      });
      if (entity.health != null) { v.confirmed = entity.health; v.estimate = entity.health; }
      if (isPlayer) {
        v.username = entity.username;
        v.gameMode = gameModeOf(this.bot, entity.username);
      }
      // Index by username as well, so a player_info update (which carries no
      // entity id) can find the same object. Both keys point at one Vitals; the
      // eviction pass deletes by value, so keeping two references is not a leak.
      if (isPlayer && entity.username) this.entities.set('name:' + entity.username, v);
      this.entities.set(k, v);
    }
    v.markSeen();
    if (v.gameMode == null && entity.username) v.gameMode = gameModeOf(this.bot, entity.username);
    return v;
  }

  byId(key) { return this.entities.get(key) || null; }

  /**
   * Drop the least-recently-seen half of the vitals map. Half rather than one,
   * so a busy server churning items does not make eviction run on every spawn.
   * The current duel target is explicitly kept: losing its Vitals mid-fight
   * would reset the health estimate to full and re-arm a duel already won.
   */
  _evict() {
    /* Keep is by VALUE, not by key.
     *
     * A player's Vitals object is stored under two keys (its entity id and
     * 'name:'+username) so both lookup paths reach one object. A key-based keep
     * set therefore cannot protect anything: excluding the id key while the name
     * key is kept still lets the id entry be chosen for eviction, and deleting it
     * drops the shared object anyway. Protecting the object is the actual intent.
     */
    const keepValues = new Set();
    if (this.target) {
      const k = DamageTracker.keyOf(this.target);
      const v = this.entities.get(k);
      if (v) keepValues.add(v);
    }
    if (this.bot && this.bot.entity) {
      const mine = this.entities.get(this.bot.entity.id);
      if (mine) keepValues.add(mine);
    }
    for (const name of Object.keys(this.bot.players || {})) {
      const p = this.bot.players[name];
      const v = p && p.entity ? this.entities.get(DamageTracker.keyOf(p.entity)) : null;
      if (v) keepValues.add(v);
      const byName = this.entities.get('name:' + name);
      if (byName) keepValues.add(byName);
    }
    const sorted = [...this.entities.entries()]
      .filter(([, v]) => !keepValues.has(v))
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    const drop = Math.max(1, Math.floor(sorted.length / 2));
    const doomed = new Set(sorted.slice(0, drop).map(([, v]) => v));
    // Remove every alias of an evicted object, or a stale 'name:' entry would
    // keep resurrecting a Vitals the map has already forgotten.
    for (const [k, v] of [...this.entities.entries()]) if (doomed.has(v)) this.entities.delete(k);
  }

  /** Look up vitals for any entity-like value (id, username-bearing object). */
  resolve(entityOrKey) {
    if (entityOrKey == null) return null;
    if (typeof entityOrKey === 'number' || typeof entityOrKey === 'string') {
      return this.entities.get(entityOrKey) || null;
    }
    return this.of(entityOrKey);
  }

  /** Vitals for a named player. */
  forPlayer(name) {
    const p = this.bot.players && (this.bot.players[name] || findByUsername(this.bot.players, name));
    if (!p || !p.entity) return null;
    return this.of(p.entity);
  }

  /**
   * The fight verdict, from signals only.
   *
   * Returns one of:
   *   'loss'  we died — the server's own death packet
   *   'win'   the opponent died, or vanished from the world (relog, or
   *           despawn after being left at half a heart by a real hit)
   *   'draw'  nothing observable has happened for `drawAfterMs`; the fight
   *           simply stopped, which is not a win and must not be reported as
   *           one
   *   null    still fighting
   *
   * Deliberately never reads the health *estimate*: a drifted number may change
   * how the bot fights, but it can never decide that the fight was won or lost.
   */
  verdict(now = Date.now(), drawAfterMs = 25000) {
    if (this.myVitals.dead) return 'loss';
    const t = this.targetVitals;
    if (t) {
      if (t.dead) return 'win';
      if (t.gone && now - t.gone > 3000) return 'win';
      if (this.targetGoneAt && now - this.targetGoneAt > 3000) return 'win';
      if (this.targetLeftAt && now - this.targetLeftAt > 3000) return 'win';
      const lastAction = Math.max(
        t.lastDamageAt || 0, this.lastHitLandedAt || 0, this.lastTargetSwingAt || 0,
        this.myVitals.lastDamageAt || 0, this.lastEngagedAt || 0);
      if (now - lastAction > drawAfterMs) return 'draw';
    }
    return null;
  }

  /** Mark the entity we are fighting, so swings at it are attributed. */
  setTarget(entity) {
    this.targetName = (entity && entity.username) || this.targetName || null;
    this.target = entity || null;
    this.targetVitals = entity ? this.of(entity) : null;
    this.lastEngagedAt = Date.now();
  }

  destroy() { if (this._unwire) { try { this._unwire(); } catch (_) {} } }
}

// Vitals gains a couple of tracker-owned timestamps without bloating the class.
Vitals.prototype.onRemoved = function (now) { this.gone = now; this.dead = this.dead || false; };

module.exports = {
  Vitals,
  DamageTracker,
  hearts,
  damageFromDrop,
  gameModeOf,
  ownGameMode,
  isUnkillable,
  findByUsername,
  GAMEMODE_NAMES
};
