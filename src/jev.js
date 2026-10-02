'use strict';

/**
 * Adapter for the JEVPilot `jev-1.x` structured-decision endpoint.
 *
 * WHAT THIS IS
 * ------------
 * The endpoint takes a free-text `state` plus a set of `questions`, each either
 * a `choice` (pick one label, with per-label weights) or a `score` (place the
 * state on a 0..N scale, with a legend), and returns for every question a
 * winner, a calibrated-looking `confidence`, and the full probability vector.
 * It is a general-purpose classifier, and a PvP bot is a classifier with extra
 * steps: given everything observable about a fight, choose the next action.
 *
 * So the state is rendered as a short factual sentence and the option set is
 * the eight actions a duel actually has. What that buys us, measured against the
 * live service rather than assumed (full transcripts in docs/jev-api.md):
 *
 *   - The STATE TEXT is the lever. With a neutral weight on all eight options,
 *     "health 20/20, opponent 20/20, distance 2" answered attack 0.71 at
 *     confidence 0.67; the identical question with "1 heart, on fire, lava behind
 *     me, opponent above me" answered attack 0.31 / retreat 0.19 / space 0.25 at
 *     confidence 0.20. So the prose is what does the work, which is why
 *     buildFightPrompt spends its character budget on observed facts.
 *   - One 400 discards the WHOLE request. Measured: a `choice` with fewer than 2
 *     options and a `score` with fewer than 2 levels are both rejected with a
 *     400, and 26 labels are rejected as "too many" (16 are fine). That is why
 *     sanitizeQuestions enforces a floor of 2 rather than 1, and why the pruning
 *     below restores the full menu instead of sending a request that would fail.
 *   - The per-label WEIGHTS are a SOFT PRIOR, weaker than this file's first
 *     draft claimed. Weighting the losing label 100x could not make it win (the
 *     same healthy-bot state with retreat x100 still answered attack 0.92).
 *     Weighting the leading label 100x DID lift it (the dire 1-heart state:
 *     attack 0.31 -> 0.48, confidence 0.20 -> 0.42). So weights can amplify a
 *     conclusion the state already supports, but cannot overrule the state.
 *     They are still computed and sent, because they cost nothing, they document
 *     the bot's own reasoning for a human reader, and a future model may honour
 *     them more -- but nothing in this bot's behaviour may depend on them having
 *     an effect. An earlier revision of this file asserted the weights were what
 *     made the integration useful rather than decorative. Measurement corrected
 *     that: the prose is the mechanism, and the option KEYS are the control.
 *   - The KEYS of the criteria map are the option space and the one control that
 *     verifiably works: pass three labels, get exactly those three back. So hard
 *     impossibilities are pruned from the menu rather than down-weighted in it.
 *
 * It returns a distribution, which is used two ways: the top choice we act on,
 * and the ranked alternatives we can fall back to when the top choice is
 * physically impossible (you cannot strafe left into a wall).
 *
 * THREE THINGS THIS MODULE GETS WRONG ON PURPOSE, AND WHY
 * -------------------------------------------------------
 * 1. It is allowed to fail. The endpoint is a free demo tier: 403 without the
 *    right Origin/Referer, rate limited, ~0.5-3 s latency (measured: 0.51,
 *    0.75, 0.76, 2.11 s), and it can return
 *    garbage. Every caller must work with `null`. So decisions are advisory:
 *    the local tier system still flies the plane, and Jev steers.
 *    `unavailable` latches after repeated failures so a dead endpoint costs
 *    nothing after the first few calls.
 * 2. It never blocks a tick. Decisions are requested asynchronously and cached
 *    with a TTL; the loop reads the last completed answer. A 2 s round trip in
 *    a 120 ms control loop would be a stall, and a stall in PvP is a death.
 * 3. It never overrides a *safety* rule. The local layer keeps a veto list
 *    (jumps, cliff avoidance, not attacking while retreating, not fleeing a
 *    fight the server says is already won). Jev can choose *how* to pressure an
 *    opponent, not *whether* to walk off a ledge.
 *
 * The API notes, including the twelve live probes this summary is drawn from,
 * are in docs/jev-api.md.
 */

const https = require('https');
const { URL } = require('url');

const DEFAULTS = {
  url: 'https://jevtypesafeai.com/api/jev',
  origin: 'https://jevtypesafeai.com',
  timeoutMs: 6000,
  ttlMs: 900,              // a fresh answer is reused until this expires
  staleGraceMs: 6000,      // ...and a slightly old one is still usable
  maxFailures: 3,          // then stop calling for cooldownMs
  cooldownMs: 60000,
  cacheBytes: 64 * 1024,
  maxInflight: 1,
  // The endpoint accepts up to ~12 options and 400s past that (measured: 12=200,
  // 14=400). 8 is chosen well below the hard limit because wider menus
  // demonstrably flatten the distribution, not because 9 would fail.
  maxOptions: 8,
  stateChars: 700
};

class JevClient {
  /**
   * @param {object} opts  merged over DEFAULTS; `logger` is optional
   */
  constructor(opts = {}) {
    this.cfg = Object.assign({}, DEFAULTS, opts);
    this.log = opts.logger || { debug() {}, warn() {}, info() {} };
    // tests (and offline demos) can substitute the network layer entirely:
    // async ({body, headers, timeoutMs}) => {status, body}
    this._transport = opts.transport || null;
    this.enabled = opts.enabled !== false;
    this.cache = new Map();        // key -> { value, at }
    this.pending = new Map();      // key -> promise
    this.failures = 0;
    this.unavailableUntil = 0;
    this.stats = { calls: 0, ok: 0, failed: 0, cached: 0, refused: 0, bytesIn: 0, tokensOut: 0 };
  }

  /**
   * Ask one or more questions about one state.
   * @param {string} state
   * @param {object} questions  { name: {type:'choice'|'score', instructions, criteria|legend} }
   * @param {object} o { force, ttlMs, staleMs, timeoutMs }
   * @returns {Promise<object|null>} answers map, or null on any failure/stale
   */
  async ask(state, questions, o = {}) {
    if (!this.enabled || !this.cfg.url) return null;
    const now = Date.now();
    if (now < this.unavailableUntil) { this.stats.refused++; return null; }
    const key = this._key(state, questions, o.key);
    const ttl = o.ttlMs != null ? o.ttlMs : this.cfg.ttlMs;
    const hit = this.cache.get(key);
    if (hit && !o.force && now - hit.at < ttl) { this.stats.cached++; return hit.value; }
    // A stale answer is better than none, and it means the loop never waits.
    if (hit && this.pending.has(key)) {
      const grace = o.staleMs != null ? o.staleMs : this.cfg.staleGraceMs;
      if (now - hit.at < grace) return hit.value;
      return null;
    }
    if (this.pending.size >= this.cfg.maxInflight) {
      if (hit) {
        const grace = o.staleMs != null ? o.staleMs : this.cfg.staleGraceMs;
        if (now - hit.at < grace) return hit.value;
      }
      this.stats.refused++;
      return null;
    }

    const p = this._call(state, questions, o.timeoutMs || this.cfg.timeoutMs)
      .then((value) => {
        this.stats.ok++;
        this.failures = 0;
        this._put(key, { value, at: Date.now() });
        return value;
      })
      .catch((err) => {
        this.stats.failed++;
        this.failures++;
        if (this.failures >= this.cfg.maxFailures) {
          this.unavailableUntil = Date.now() + this.cfg.cooldownMs;
          this.log.warn('jev: endpoint unavailable, backing off', {
            error: err.message, cooldownMs: this.cfg.cooldownMs
          });
        } else {
          this.log.debug('jev: call failed', { error: err.message });
        }
        // Keep serving the last good answer within its grace window.
        if (hit) {
          const grace = o.staleMs != null ? o.staleMs : this.cfg.staleGraceMs;
          if (Date.now() - hit.at < grace) return hit.value;
        }
        return null;
      })
      .finally(() => { this.pending.delete(key); });
    this.pending.set(key, p);
    this.stats.calls++;
    return p;
  }

  /** Synchronous read of the most recent usable answer for a key. */
  peek(state, questions, o = {}) {
    const key = this._key(state, questions, o.key);
    const hit = this.cache.get(key);
    if (!hit) return null;
    const grace = o.staleMs != null ? o.staleMs : this.cfg.staleGraceMs;
    if (Date.now() - hit.at > grace) return null;
    return hit.value;
  }

  /** Fire-and-forget refresh; the loop reads with `peek`. */
  prefetch(state, questions, o = {}) {
    // Note: look the slot up by the *computed* key, but hand `ask` the original
    // options. Passing the computed key back in as `o.key` double-prefixes it and
    // the refresh writes to a different slot than the peek reads — which shows up
    // as "the advisor never answers", the exact failure this cache exists to avoid.
    const slot = this._key(state, questions, o.key);
    const hit = this.cache.get(slot);
    const ttl = o.ttlMs != null ? o.ttlMs : this.cfg.ttlMs;
    if (hit && Date.now() - hit.at < ttl) return;      // fresh enough
    this.ask(state, questions, o).catch(() => {});
  }

  /**
   * Cache key.
   *
   * Hashing the raw state is wrong for a live fight, and the bug it causes is
   * the kind that only shows up as "the advisor never seems to do anything": the
   * state text contains numbers that change every cycle (attack charge, distance,
   * the health estimate), so each cycle produced a brand-new key, `peek` found
   * nothing cached, and the loop — which by design never waits on the network —
   * acted on null forever.
   *
   * So a call site passes a stable identity (`pvp:<target>`), and the question set
   * is hashed alongside it. Without an explicit key, volatile numbers are
   * collapsed to `#` first, which makes near-identical situations share a slot
   * instead of missing it.
   */
  _key(state, questions, key) {
    const qs = simpleHash(Object.keys(questions).sort().join(',') +
      Object.entries(questions).map(([k, v]) => k + ':' + (v && v.type)).join(','));
    if (key) return `${qs}|${key}`;
    const normalized = String(state).replace(/-?\d+(?:\.\d+)?/g, '#');
    return `${qs}|~${simpleHash(normalized)}`;
  }

  _put(key, entry) {
    this.cache.set(key, entry);
    // Bound the cache by insertion order: Map keeps it, and 64 KB of small
    // answers is ~200 entries, so this only matters after a long session.
    let bytes = 0;
    for (const [k, v] of this.cache) {
      bytes += JSON.stringify(v.value || {}).length + 64;
      if (bytes > this.cfg.cacheBytes) this.cache.delete(k);
    }
  }

  async _call(state, questions, timeoutMs) {
    const body = JSON.stringify({
      state: String(state).slice(0, this.cfg.stateChars),
      questions: sanitizeQuestions(questions, this.cfg.maxOptions)
    });
    const u = new URL(this.cfg.url);
    const payload = Buffer.from(body, 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      // The free tier checks these two. Without them it answers
      // "This free demo can only be called from jevtypesafeai.com." with a 403,
      // which is indistinguishable from a network failure unless the body is
      // read — so the body is logged on non-2xx.
      'Origin': this.cfg.origin,
      'Referer': this.cfg.origin + '/'
    };
    if (this._transport) {
      const r = await this._transport({ url: this.cfg.url, body, headers, timeoutMs });
      return this._ingest(r, u);
    }
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        headers,
        timeout: timeoutMs
      }, (r) => {
        let buf = Buffer.alloc(0);
        r.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          if (buf.length > 256 * 1024) { req.destroy(); reject(new Error('response too large')); }
        });
        r.on('end', () => resolve({ status: r.statusCode, body: buf.toString('utf8') }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
    return this._ingest(res, u);
  }

  /** Parse/validate one HTTP result. Split out so tests can call it directly. */
  _ingest(res) {
    this.stats.bytesIn += res.body.length;
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`HTTP ${res.status}: ${res.body.slice(0, 160)}`);
      // 401/403/429 are not our bug; a long backoff is the right response.
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        this.unavailableUntil = Date.now() + Math.max(this.cfg.cooldownMs, 120000);
      }
      throw err;
    }
    let json;
    try { json = JSON.parse(res.body); } catch (_) { throw new Error('non-JSON response'); }
    if (!json || !json.answers || typeof json.answers !== 'object') throw new Error('no answers in response');
    // An empty answers map is a well-formed non-answer: it tells us nothing, and
    // caching it would let a degenerate response silently suppress the advisor.
    if (!Object.keys(json.answers).length) throw new Error('empty answers in response');
    if (json.model) this.model = json.model;
    if (json.usage) this.stats.tokensOut += json.usage.output_tokens || 0;
    return json.answers;
  }

  snapshot() {
    return Object.assign({
      enabled: this.enabled,
      model: this.model || null,
      unavailable: Date.now() < this.unavailableUntil,
      pending: this.pending.size,
      cacheSize: this.cache.size
    }, this.stats);
  }
}

/**
 * Trim/repair the question set before sending. The endpoint is unforgiving of
 * empty criteria maps and of scores without a legend, and a malformed question
 * fails the whole request.
 */
function sanitizeQuestions(qs, maxOptions) {
  const out = {};
  for (const [name, q] of Object.entries(qs || {})) {
    if (!q || typeof q !== 'object') continue;
    if (q.type === 'choice') {
      const crit = q.criteria && typeof q.criteria === 'object' ? q.criteria : {};
      const keys = Object.keys(crit).filter(k => {
        const w = Number(crit[k]);
        return Number.isFinite(w) && w > 0;
      }).slice(0, maxOptions);
      // Measured against the live endpoint, not guessed: a choice question with
      // fewer than TWO options returns HTTP 400
      //   {"error":"Choice question \"action\" needs 2+ options."}
      // and one 400 fails the ENTIRE request, including every other question in
      // it. So a single surviving option must be dropped rather than sent, or a
      // pruned-down duel would stop getting answers at all. `>= 2`, not
      // `length > 0` -- the latter was the original bug.
      if (keys.length < 2) continue;
      const criteria = {};
      for (const k of keys) criteria[k] = Number(crit[k]);
      out[name] = {
        type: 'choice',
        instructions: String(q.instructions || '').trim() || 'Choose the best option.',
        criteria
      };
    } else if (q.type === 'score') {
      const legend = (Array.isArray(q.criteria) ? q.criteria
        : Array.isArray(q.legend) ? q.legend : []).slice(0, 8);
      // Same rule for scores, verified live: "Score question \"s\" needs 2+
      // ordered levels." with a 400, for both an empty and a single-item legend.
      if (legend.length < 2) continue;
      out[name] = {
        type: 'score',
        instructions: String(q.instructions || '').trim() || 'Rate the state on the given scale.',
        criteria: legend
      };
    }
  }
  return out;
}

/** FNV-1a: small, fast, and good enough to key a cache on. */
function simpleHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* ------------------------------------------------------------------ *
 * The PvP question set
 * ------------------------------------------------------------------ */

/**
 * The action space. Kept to 8 options: past that the model's top choice gets
 * less reliable, and a fight does not have 20 reasonable next moves.
 */
const PVP_ACTIONS = [
  'attack',      // commit: close into reach and swing
  'press',       // step in aggressively, stay in their face, do not yet swing
  'space',       // hold at the edge of reach and wait for an opening
  'strafe',      // circle sideways to break their aim
  'retreat',     // create distance and heal/bait
  'bait',        // show yourself, then pull back — make them swing at nothing
  'guard',       // sneak/hold position, do not give them a knockback angle
  'disengage'    // leave the fight entirely
];

/**
 * Turn a fight snapshot into (state, questions). Exported for tests and so the
 * exact prompt the bot used can be printed by the CLI (`mc pvp ... --explain`).
 */
function buildFightPrompt(ctx) {
  const t = ctx.target || {};
  const s = ctx.self || {};
  const w = ctx.world || {};
  const rules = ctx.rules || {};
  const parts = [];
  // Each push() is one sentence; fragments inside it are joined with ", " so the
  // state reads as prose rather than a run-on. The endpoint tokenises this text,
  // so grammar that a human would call sloppy is actually noise in the input.
  const push = (...frags) => {
    const text = frags.filter(f => f != null && f !== '').join(', ');
    if (text) parts.push(text.endsWith('.') ? text : text + '.');
  };

  push(`Minecraft Java PvP duel, ${ctx.gameName || 'player'} vs ${ctx.botName || 'bot'}.`);
  push(`My health ${s.hp ?? '?'}/20 (${s.hearts ?? '?'} hearts), food ${s.food ?? '?'}/20`,
    s.gamemode ? `I am in ${s.gamemode} mode` : null,
    s.armor != null ? `armour reduces incoming damage by ${Math.round((1 - s.armor) * 100)}%` : null);
  push(`Opponent health estimate ${t.hpEstimate ?? '?'}/20, source ${t.hpSource || 'estimate'} (the server does not broadcast player health)`,
    t.gamemode ? `opponent is in ${t.gamemode} mode` : null,
    `opponent confirmed damage taken: ${t.hitsTaken || 0}`,
    `opponent attacks that produced no damage: ${t.missed || 0}`);
  push(`Distance ${ctx.distance != null ? ctx.distance.toFixed(1) : '?'} blocks; my weapon ${s.weapon || 'fist'} does ~${s.weaponDamage || 1} damage at full charge`,
    ctx.ourCooldownProgress != null ? `our attack charge is ${Math.round(ctx.ourCooldownProgress * 100)}%` : null,
    `opponent weapon ${t.weapon || 'unknown'}`,
    ctx.tier != null ? `difficulty tier of this opponent: ${ctx.tier.toFixed(2)}` : null);
  if (w.timeOfDay != null) push(w.isNight ? 'It is night.' : 'It is day.');
  push((w.mobCount ? `${w.mobCount} hostile mob(s) within ${w.mobRadius || 16} blocks` : 'No hostiles nearby') + '.');
  if (w.nearCliff) push('A dangerous drop is one step away, so movement must avoid it.');
  if (w.inWater) push('We are in water: no sprinting and reduced knockback.');
  if (w.botInHole) push('The bot is standing below the surrounding ground and may need to climb.');
  if (rules.engagement) push(`Context: ${rules.engagement}.`);

  /* Option space and priors.
   *
   * WHAT ACTUALLY STEERS THIS MODEL, measured rather than assumed. Twelve live
   * probes against jev-1.13.0 (full transcripts in docs/jev-api.md):
   *
   *   - Weights are a SOFT PRIOR. Weighting the losing label 100x could not make
   *     it win (retreat x100 against a healthy bot: attack still 0.92, twice).
   *     Weighting the leading label 100x did lift it (attack 0.31 -> 0.48,
   *     confidence 0.20 -> 0.42). They amplify what the state already supports;
   *     they cannot overrule it. An earlier draft of this file claimed weights were
   *     the mechanism making the integration useful, which measurement disproved.
   *   - Changing the STATE TEXT moved the answer a lot: with neutral weights, a
   *     healthy bot at 2 blocks gave attack 0.71 / confidence 0.67, and the same
   *     question with "1 heart, on fire, lava behind me, opponent above me" gave
   *     attack 0.31 / retreat 0.19 / space 0.25 / confidence 0.20. The prose is
   *     the lever, which is why buildFightPrompt spends its budget on facts.
   *   - The KEYS of the criteria map are the option space: passing 3 labels
   *     returned exactly those 3. That is the control that works, so hard
   *     impossibilities are pruned here instead of being down-weighted.
   *
   * The weights are kept because they cost nothing, they document intent for a
   * human reader, and a future model may honour them. Nothing in this bot's
   * behaviour depends on them having an effect.
   */
  const crit = {};
  const hp = s.hp != null ? s.hp : 20;
  const dist = ctx.distance != null ? ctx.distance : 5;
  const thp = t.hpEstimate != null ? t.hpEstimate : 20;
  const unkillable = t.gamemode === 'creative' || t.gamemode === 'spectator';

  crit.attack = clampN((hp / 20) * (dist <= 3.2 ? 6 : 1.4) * (unkillable ? 0.1 : 1) * (1 + (20 - thp) / 20), 0.1, 9);
  crit.press = clampN((dist > 3.2 && dist < 8 ? 5 : 1.5) * (hp / 20), 0.1, 9);
  crit.space = clampN(dist < 2.5 ? 4 : 2.5, 0.1, 9);
  crit.strafe = clampN(dist > 1.6 && dist < 6 ? 4 : 1.5, 0.1, 9);
  crit.retreat = clampN(hp < 8 ? 6 : (hp < 14 ? 2.2 : 0.6), 0.1, 9);
  crit.bait = clampN(hp > 12 && dist > 3 ? 3 : 1, 0.1, 9);
  crit.guard = clampN(hp < 12 ? 2 : 1, 0.1, 9);
  crit.disengage = clampN(unkillable ? 7 : ((w.mobCount || 0) >= 2 ? 3 : 0.8), 0.1, 9);
  // Never zero: a label with weight 0 cannot be chosen, and "never retreat" is
  // exactly the over-confidence this bot had before.
  for (const k of Object.keys(crit)) if (!(crit[k] > 0)) crit[k] = 0.1;

  // Prune labels that local facts already rule out. This is the one input that
  // verifiably changes the response, so it is used for what it is good at:
  // keeping the model from recommending something impossible.
  const impossible = [];
  if (unkillable) impossible.push('attack', 'press', 'bait', 'guard');
  if (ctx.weapons && ctx.weapons.none) impossible.push('attack');
  if (dist > 8) impossible.push('guard');
  for (const k of impossible) delete crit[k];
  // Pruning must never leave fewer than TWO options. Measured live against the
  // endpoint: a 1-option choice question returns HTTP 400 ("needs 2+ options")
  // and one 400 fails the ENTIRE request, so the advisor would go silent exactly
  // where the most was ruled out (creative + long range is that case). Restore the
  // full menu rather than send a request the endpoint would reject.
  if (Object.keys(crit).length < 2) for (const k of PVP_ACTIONS) crit[k] = 1;

  const questions = {
    action: {
      type: 'choice',
      instructions: 'Given the duel state, what is the single best next action for the bot? ' +
        'Prefer the option that wins the fight while keeping the bot alive.',
      criteria: crit
    },
    aggression: {
      type: 'score',
      instructions: 'How aggressive should the bot be in this moment?',
      criteria: ['timid', 'careful', 'balanced', 'assertive', 'savage']
    },
    risk: {
      type: 'score',
      instructions: 'What is the risk to the bot of pressing the attack right now?',
      criteria: ['negligible', 'low', 'moderate', 'high', 'lethal']
    }
  };
  return { state: parts.join(' ').replace(/\s+/g, ' '), questions };
}

/**
 * Fold an answer back into a usable intent. Tolerates the endpoint returning a
 * label we did not ask for, or a score out of range.
 */
function interpretFight(answers, ctx) {
  if (!answers || !answers.action) return null;
  const a = answers.action;
  const choice = String(a.choice || '').toLowerCase().trim();
  const legal = PVP_ACTIONS.includes(choice);
  const probs = a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : {};
  // Only labels we actually asked about, and only those with a finite weight.
  // (An earlier version did Object.keys() on an array of actions, which returns
  // the *indices* "0","1",... — the alternatives list was then silently empty,
  // so a legal-but-impossible top action had no fallback.)
  const ranked = PVP_ACTIONS
    .filter(o => Number.isFinite(Number(probs[o])))
    .map(o => ({ o, p: Number(probs[o]) }))
    .sort((x, y) => y.p - x.p)
    .map(e => e.o);
  if (!legal && !ranked.length) return null;
  const act = legal ? choice : (ranked[0] || null);
  if (!act) return null;
  const agg = answers.aggression && answers.aggression.score != null
    ? clampN(Number(answers.aggression.score) / 4, 0, 1) : null;
  const risk = answers.risk && answers.risk.score != null
    ? clampN(Number(answers.risk.score) / 4, 0, 1) : null;
  const confidence = Number.isFinite(a.confidence) ? a.confidence : null;
  return {
    action: act,
    alternatives: ranked.filter(o => o !== act).slice(0, 2),
    confidence,
    aggression: agg,
    risk,
    // Below this the distribution is flat enough that the "winner" is noise;
    // acting on it would be random, and randomness at 120 ms is a hazard.
    confident: confidence != null ? confidence >= 0.34 : true,
    at: Date.now()
  };
}

function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v) || lo)); }

module.exports = {
  JevClient,
  sanitizeQuestions,
  simpleHash,
  buildFightPrompt,
  interpretFight,
  PVP_ACTIONS,
  DEFAULTS
};
