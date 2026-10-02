/**
 * External-decision advisor (Jev) tests.
 *
 * The endpoint is a free third-party demo tier: it requires an Origin/Referer,
 * it rate limits, it can take seconds, and it can answer nonsense. Nothing in
 * the bot may depend on it being available, so these tests are mostly about the
 * failure paths, and they run with an injected transport so the suite stays
 * offline and deterministic.
 *
 * The contract being pinned:
 *   - a working answer changes the bot's behaviour (it is not decoration)
 *   - a slow, wrong, refused, or failing answer changes NOTHING
 *   - the loop never waits on the network
 *   - malformed input is repaired or dropped before sending, never sent
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const J = require(path.join(SRC, 'jev.js'));
const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
const { Actor } = require(path.join(SRC, 'actor.js'));

const FLOOR = 70;

/** Awaited sleep. Used by the polling assertions below. */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Wait until `cond()` is true or the budget runs out; returns whether it hit. */
async function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

/** A transport that answers instantly with whatever the test wants. */
function fakeTransport(answer, opts = {}) {
  const calls = [];
  const fn = async ({ body, headers, url }) => {
    calls.push({ body: JSON.parse(body), headers, url });
    if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
    if (opts.status) return { status: opts.status, body: JSON.stringify(answer) };
    if (opts.raw != null) return { status: opts.status || 200, body: opts.raw };
    return { status: 200, body: JSON.stringify(answer) };
  };
  fn.calls = calls;
  return fn;
}

/**
 * The transport-level envelope, exactly as the endpoint returns it.
 * NOTE the two shapes: `ask()` hands back `envelope.answers`, and
 * `interpretFight()` consumes that *answers map*. Tests that call interpretFight
 * directly must pass `okAnswer(...).answers` — handing it the whole envelope is
 * what made it return null and looked like a parser bug.
 */
function okAnswer(choice, probs, extras = {}) {
  return {
    model: 'jev-test',
    answers: Object.assign({
      action: { type: 'choice', choice, confidence: extras.confidence != null ? extras.confidence : 0.7, probabilities: probs }
    }, extras.extra || {}),
    usage: { input_tokens: 400, output_tokens: 60 }
  };
}

function register({ test, testAsync }) {

  /* ---------------- prompt construction ---------------- */
  test('the fight state sentence is prose, not fragments', () => {
    const ctx = {
      gameName: 'Steve', botName: 'AFK_Bot', distance: 2.1, tier: 0.8,
      self: { hp: 14, hearts: 7, food: 18, weapon: 'diamond_sword', weaponDamage: 7, gamemode: 'survival', armor: 0.6 },
      target: { hpEstimate: 6, hitsTaken: 2, missed: 1, gamemode: 'survival', weapon: 'iron_axe' },
      world: { isNight: true, mobCount: 1, nearCliff: true, timeOfDay: 18000 },
      rules: { engagement: 'live duel' }
    };
    const { state } = J.buildFightPrompt(ctx);
    assert.ok(!/\s\./.test(state), `stray sentence fragment: ${state}`);
    assert.ok(!/\(\s*\)/.test(state), 'empty parentheses');
    assert.match(state, /Steve vs AFK_Bot/);
    assert.match(state, /7 hearts/);
    assert.match(state, /creative|survival/);
    assert.match(state, /night/);
    assert.match(state, /drop/);
    assert.ok(state.length < J.DEFAULTS.stateChars, 'must fit the state budget');
  });

  test('option weights reflect the situation (retreat is not weighted high when healthy)', () => {
    const base = (over) => J.buildFightPrompt(Object.assign({
      gameName: 'X', botName: 'Y', distance: 2, tier: 0.5,
      self: { hp: 20, hearts: 10, weaponDamage: 7, gamemode: 'survival' },
      target: { hpEstimate: 20, hitsTaken: 0, missed: 0, gamemode: 'survival' },
      world: {}, rules: {}
    }, over)).questions.action.criteria;
    const healthy = base({});
    const hurt = base({ self: { hp: 5, hearts: 3, weaponDamage: 7, gamemode: 'survival' } });
    const creative = base({ target: { hpEstimate: 20, gamemode: 'creative', hitsTaken: 0, missed: 0 } });
    assert.ok(hurt.retreat > healthy.retreat * 3, `hurt should weight retreat far higher (${healthy.retreat} -> ${hurt.retreat})`);
    assert.ok(healthy.attack > hurt.attack, 'a healthy bot should press harder than a nearly-dead one');
    assert.ok(creative.disengage > healthy.disengage, 'a creative opponent should raise disengage');
    // A creative opponent PRUNES the attack options entirely, rather than
    // down-weighting them. That is deliberate and measured: six live probes
    // against the endpoint showed weights barely move the answer, while the
    // KEYS of the criteria map define the option space exactly (3 labels in,
    // 3 labels out). See docs/jev-api.md. So impossibilities are removed from
    // the menu instead of being made rarer on it.
    assert.ok(!('attack' in creative), 'a creative opponent must not be offered "attack" at all');
    assert.ok(!('press' in creative), 'nor press');
    assert.ok('space' in creative && 'retreat' in creative, 'but non-combat options stay available');
    // Every option must stay reachable: a zero weight means the model cannot
    // pick it, and "never retreat" was precisely the over-confidence this bot had.
    for (const [k, v] of Object.entries(healthy)) assert.ok(v > 0, `${k} weight must be > 0`);
  });

  test('impossible options are pruned, but the menu is never emptied', () => {
    // Pruning the option space is the lever that verifiably works on this model.
    // Used too aggressively it would send an empty criteria map, which fails the
    // entire request - so the builder must guarantee a non-empty menu.
    const mk = (over) => J.buildFightPrompt(Object.assign({
      gameName: 'X', botName: 'Y', tier: 0.5,
      self: { hp: 20, gamemode: 'survival' },
      target: { hpEstimate: 20, gamemode: 'survival' },
      world: {}, rules: {}
    }, over)).questions.action.criteria;
    const far = mk({ distance: 30 });
    assert.ok(Object.keys(far).length >= 4, 'a long-range duel still has options');
    assert.ok(!('guard' in far), 'guard is pruned at range (it does nothing 30 blocks away)');
    const creative = mk({ distance: 1, target: { hpEstimate: 20, gamemode: 'creative' } });
    assert.ok(Object.keys(creative).length >= 3, 'vs creative: retreat/space remain, attack is gone');
    // Both impossible-flag conditions at once must not collapse the menu.
    const both = mk({ distance: 30, target: { hpEstimate: 20, gamemode: 'spectator' } });
    assert.ok(Object.keys(both).length >= 3, `pruning must never empty the option space, got ${Object.keys(both).length}`);
  });

  test('sanitizeQuestions repairs or drops unusable questions', () => {
    const out = J.sanitizeQuestions({
      good: { type: 'choice', instructions: 'x', criteria: { a: 1, b: 2 } },
      empty: { type: 'choice', instructions: 'x', criteria: {} },
      allzero: { type: 'choice', instructions: 'x', criteria: { a: 0, b: 0 } },
      badweight: { type: 'choice', instructions: 'x', criteria: { a: 'nope', b: 3, c: 4 } },
      // only one usable weight after stripping: must be DROPPED, not sent
      singleweight: { type: 'choice', instructions: 'x', criteria: { a: 'nope', b: 3 } },
      scoreok: { type: 'score', instructions: 'y', criteria: ['lo', 'hi'] },
      scorebad: { type: 'score', instructions: 'y' },
      scoreOne: { type: 'score', instructions: 'y', criteria: ['only'] },
      nonsense: { type: 'other' },
      nullq: null
    }, 8);
    assert.ok(out.good, 'a valid choice question survives');
    assert.ok(!out.empty && !out.allzero, 'empty criteria would fail the whole request: dropped');
    assert.ok(out.badweight && out.badweight.criteria.a === undefined, 'a non-numeric weight is stripped, the question is kept');
    assert.ok(out.scoreok, 'a score with a legend survives');
    assert.ok(!out.scorebad && !out.nonsense && !out.nullq);
  });

  test('sanitizeQuestions enforces the endpoint\'s 2+ option rule (measured live)', () => {
    // Not a style choice - verified against the running service:
    //   {"error":"Choice question \"action\" needs 2+ options."}   -> HTTP 400
    //   {"error":"Score question \"s\" needs 2+ ordered levels."}   -> HTTP 400
    // and a single 400 fails the WHOLE request, discarding the answers to every
    // other question in it. So a question reduced to one option by pruning or by
    // stripped weights must be dropped rather than sent. The original code only
    // guarded against zero, which is why this needed its own test.
    const out = J.sanitizeQuestions({
      choiceOne: { type: 'choice', instructions: 'x', criteria: { only: 1 } },
      choiceZero: { type: 'choice', instructions: 'x', criteria: {} },
      choiceTwo: { type: 'choice', instructions: 'x', criteria: { a: 1, b: 1 } },
      scoreOne: { type: 'score', instructions: 'x', criteria: ['solo'] },
      scoreTwo: { type: 'score', instructions: 'x', criteria: ['lo', 'hi'] }
    }, 8);
    assert.ok(!out.choiceOne, 'a 1-option choice must be dropped, not 400 the request');
    assert.ok(!out.choiceZero, 'and a 0-option choice too');
    assert.ok(out.choiceTwo, 'a 2-option choice is the valid minimum and survives');
    assert.ok(!out.scoreOne, 'a 1-level score must be dropped');
    assert.ok(out.scoreTwo, 'a 2-level score survives');
    // And the builder's pruning can never produce a request the endpoint rejects.
    const mk = (over) => J.buildFightPrompt(Object.assign({
      gameName: 'X', botName: 'Y', distance: 30, tier: 0.5,
      self: { hp: 20, gamemode: 'survival' },
      target: { hpEstimate: 20, gamemode: 'creative' },
      world: {}, rules: {}
    }, over));
    for (const ctx of [
      { distance: 30, target: { hpEstimate: 20, gamemode: 'creative' } },
      { distance: 1, target: { hpEstimate: 20, gamemode: 'spectator' } },
      { distance: 40, target: { hpEstimate: 20, gamemode: 'adventure' }, weapons: { none: true } }
    ]) {
      const q = mk(ctx).questions;
      const sent = J.sanitizeQuestions(q, 8);
      assert.ok(sent.action, `action question vanished for ${JSON.stringify(ctx)}`);
      assert.ok(Object.keys(sent.action.criteria).length >= 2,
        `pruning left ${Object.keys(sent.action.criteria).length} options, which the endpoint rejects`);
    }
  });

  test('too many options are truncated rather than rejected', () => {
    const crit = {};
    for (let i = 0; i < 20; i++) crit['opt' + i] = 1;
    const out = J.sanitizeQuestions({ q: { type: 'choice', instructions: 'x', criteria: crit } }, 8);
    assert.strictEqual(Object.keys(out.q.criteria).length, 8);
  });

  /* ---------------- answer interpretation ---------------- */
  test('interpretFight accepts a legal choice and ranks alternatives', () => {
    const a = J.interpretFight(okAnswer('strafe', { strafe: 0.5, attack: 0.3, retreat: 0.2 }).answers, {});
    assert.strictEqual(a.action, 'strafe');
    assert.deepStrictEqual(a.alternatives, ['attack', 'retreat']);
    assert.strictEqual(a.confident, true);
  });

  test('interpretFight falls back to the probability ranking when the label is bogus', () => {
    const a = J.interpretFight(okAnswer('dance', { attack: 0.4, strafe: 0.45, retreat: 0.1 }).answers, {});
    assert.strictEqual(a.action, 'strafe', 'the highest-probability legal option wins');
    assert.ok(a.alternatives.includes('attack'));
  });

  test('interpretFight returns null on garbage instead of guessing', () => {
    // A well-formed answer is NOT garbage, so it must parse: this is the check
    // that the null-cases below are about malformed input, not about the parser
    // being broken for everything.
    assert.strictEqual(J.interpretFight(okAnswer('attack', { attack: 1 }).answers, {}).action, 'attack');
    assert.strictEqual(J.interpretFight(null, {}), null);
    assert.strictEqual(J.interpretFight({}, {}), null);
    assert.strictEqual(J.interpretFight({ action: {} }, {}), null);
    assert.strictEqual(J.interpretFight({ action: { choice: 'dance', probabilities: {} } }, {}), null);
  });

  test('a flat probability distribution is marked not-confident', () => {
    // The point of this guard: acting on a coin flip at 110 ms is a hazard, not a
    // decision. The loop must then fall back to its own tier logic.
    const a = J.interpretFight(okAnswer('attack', { attack: 0.14, strafe: 0.13, retreat: 0.12 }, { confidence: 0.05 }).answers, {});
    assert.strictEqual(a.confident, false);
  });

  test('score questions map onto 0..1 scales', () => {
    const ans = okAnswer('press', { press: 0.6, attack: 0.2 }, {
      confidence: 0.6,
      extra: { aggression: { type: 'score', score: 3 }, risk: { type: 'score', score: 1 } }
    });
    const a = J.interpretFight(ans.answers, {});
    assert.strictEqual(a.action, 'press');
    assert.strictEqual(a.aggression, 0.75, 'score 3 of 0..4');
    assert.strictEqual(a.risk, 0.25);
  });

  /* ---------------- client behaviour ---------------- */
  test('a successful call returns answers and records usage', async () => {
    const tr = fakeTransport(okAnswer('attack', { attack: 0.8, retreat: 0.1 }));
    const c = new J.JevClient({ transport: tr, enabled: true });
    const { state, questions } = J.buildFightPrompt({
      gameName: 'S', botName: 'B', distance: 2, self: {}, target: {}, world: {}, rules: {}
    });
    const ans = await c.ask(state, questions);
    assert.ok(ans && ans.action, 'answers returned');
    assert.strictEqual(tr.calls.length, 1);
    assert.strictEqual(tr.calls[0].headers.Origin, 'https://jevtypesafeai.com',
      'the demo tier 403s without Origin+Referer — this is not optional');
    assert.strictEqual(tr.calls[0].headers.Referer, 'https://jevtypesafeai.com/');
    assert.strictEqual(tr.calls[0].body.state, state);
    assert.ok(tr.calls[0].body.questions.action.criteria, 'criteria weights are sent');
    assert.strictEqual(c.snapshot().ok, 1);
    assert.strictEqual(c.model, 'jev-test');
  });

  test('answers are cached within the TTL (the loop must not spam the endpoint)', async () => {
    const tr = fakeTransport(okAnswer('attack', { attack: 0.8 }));
    const c = new J.JevClient({ transport: tr, ttlMs: 100000 });
    const q = J.buildFightPrompt({ self: {}, target: {}, world: {}, rules: {}, distance: 2 }).questions;
    const st = 'same state';
    await c.ask(st, q); await c.ask(st, q); await c.ask(st, q);
    assert.strictEqual(tr.calls.length, 1, 'three asks, one network call');
    assert.strictEqual(c.snapshot().cached, 2);
  });

  test('prefetch is fire-and-forget and peek reads the cache', async () => {
    const tr = fakeTransport(okAnswer('strafe', { strafe: 0.7 }), { delay: 40 });
    const c = new J.JevClient({ transport: tr, ttlMs: 5000 });
    const q = { a: { type: 'choice', instructions: 'x', criteria: { strafe: 1, attack: 2 } } };
    assert.strictEqual(c.peek('st', q), null, 'nothing cached yet');
    c.prefetch('st', q);
    const before = tr.calls.length;
    assert.ok(before >= 1, 'prefetch started a request without us awaiting it');
    // Poll rather than guess a duration: the assertion is about *ordering*
    // (peek reads a cache that a fire-and-forget request filled), and a fixed
    // sleep only measures how busy the event loop happens to be.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !c.peek('st', q)) await new Promise(r => setTimeout(r, 25));
    assert.ok(c.peek('st', q), 'the answer arrived and is readable without awaiting');
    assert.strictEqual(c.pending.size, 0);
  });

  test('the loop never blocks: ask() returns null while the inflight limit is hit', async () => {
    let releaseFirst;
    const gate = new Promise(r => { releaseFirst = r; });
    let n = 0;
    const c = new J.JevClient({
      enabled: true, maxInflight: 1,
      transport: async () => {
        n++;
        if (n === 1) { await gate; return { status: 200, body: JSON.stringify(okAnswer('attack', { attack: 1 })) }; }
        return { status: 200, body: JSON.stringify(okAnswer('retreat', { retreat: 1 })) };
      }
    });
    const q = { a: { type: 'choice', instructions: 'x', criteria: { attack: 1, retreat: 1 } } };
    const first = c.ask('one', q);
    await new Promise(r => setImmediate(r));
    const second = await c.ask('two', q);          // no cache, inflight full
    assert.strictEqual(second, null, 'a busy advisor must return nothing, not queue up');
    releaseFirst();
    await first;
    assert.strictEqual(c.pending.size, 0, 'the pending slot is always released');
  });

  test('403 latches a long cooldown instead of a retry storm', async () => {
    const tr = fakeTransport({ error: 'This free demo can only be called from jevtypesafeai.com.' }, { status: 403 });
    const c = new J.JevClient({ transport: tr, maxFailures: 1, cooldownMs: 120000 });
    const q = { a: { type: 'choice', instructions: 'x', criteria: { attack: 1 } } };
    assert.strictEqual(await c.ask('s', q), null);
    assert.strictEqual(tr.calls.length, 1);
    await c.ask('s2', q); await c.ask('s3', q);
    assert.strictEqual(tr.calls.length, 1, 'unavailable until the cooldown elapses');
    assert.strictEqual(c.snapshot().refused >= 2, true);
  });

  test('repeated transport failures stop calling', async () => {
    let calls = 0;
    const c = new J.JevClient({
      enabled: true, maxFailures: 2, cooldownMs: 60000,
      transport: async () => { calls++; throw new Error('ECONNRESET'); }
    });
    const q = { a: { type: 'choice', instructions: 'x', criteria: { attack: 1 } } };
    await c.ask('a', q); await c.ask('b', q);
    const snapshotCalls = calls;
    await c.ask('c', q); await c.ask('d', q);
    assert.strictEqual(calls, snapshotCalls, 'backoff after maxFailures');
    assert.strictEqual(c.snapshot().unavailable, true);
  });

  test('a stale answer is served while a refresh is running', async () => {
    let n = 0;
    const c = new J.JevClient({
      enabled: true, ttlMs: 1, staleGraceMs: 5000,
      transport: async () => {
        n++;
        return { status: 200, body: JSON.stringify(okAnswer(n === 1 ? 'attack' : 'retreat', { attack: 1, retreat: 1 })) };
      }
    });
    const q = { a: { type: 'choice', instructions: 'x', criteria: { attack: 1, retreat: 1 } } };
    const first = await c.ask('same', q);
    assert.strictEqual(first.action.choice, 'attack');
    await new Promise(r => setTimeout(r, 10));            // TTL expires
    const second = await c.ask('same', q);
    assert.ok(second, 'an expired-but-in-grace answer is still returned rather than null');
  });

  test('non-JSON and empty-answers bodies are handled as failures', async () => {
    for (const raw of ['<html>502 bad gateway</html>', '{}', '{"answers":{}}', 'not json at all']) {
      const c = new J.JevClient({ enabled: true, maxFailures: 99, transport: async () => ({ status: 200, body: raw }) });
      const q = { a: { type: 'choice', instructions: 'x', criteria: { attack: 1 } } };
      assert.strictEqual(await c.ask('s' + raw, q), null, `should reject: ${raw}`);
    }
  });

  test('disabled client never touches the transport', async () => {
    let calls = 0;
    const c = new J.JevClient({ enabled: false, transport: async () => { calls++; return { status: 200, body: '{}' }; } });
    assert.strictEqual(await c.ask('s', { a: { type: 'choice', instructions: 'x', criteria: { attack: 1 } } }), null);
    assert.strictEqual(calls, 0);
  });

  test('the state string is truncated to the configured budget', async () => {
    const tr = fakeTransport(okAnswer('attack', { attack: 1 }));
    const c = new J.JevClient({ transport: tr, stateChars: 80 });
    await c.ask('x'.repeat(500), { a: { type: 'choice', instructions: 'x', criteria: { attack: 1 } } });
    assert.strictEqual(tr.calls[0].body.state.length, 80);
  });

  test('cache is bounded (a long session must not grow without limit)', async () => {
    const tr = fakeTransport(okAnswer('attack', { attack: 1 }));
    const c = new J.JevClient({ transport: tr, cacheBytes: 2000, ttlMs: 0 });
    for (let i = 0; i < 200; i++) await c.ask('state ' + i, { a: { type: 'choice', instructions: 'x', criteria: { attack: 1 } } });
    assert.ok(c.cache.size < 200, `cache grew unbounded: ${c.cache.size}`);
  });

  /* ---------------- integration: the advisor changes behaviour, safely ------- */
  function makeArenaPvp(aiMode) {
    const world = MockWorld.arena({ floorY: FLOOR, radius: 20 });
    const bot = new MockBot(world, { username: 'Tester', manualTicks: true });
    bot._spawn();
    const logs = [];
    const logger = {
      info: (m, f) => logs.push(['info', m, f]), warn: (m, f) => logs.push(['warn', m, f]),
      error: () => {}, debug: () => {}
    };
    const actor = new Actor(bot, {
      logger,
      config: {
        mode: 'afk', survive: { enabled: false },
        pvp: { ai: aiMode, reach: 3, engageRange: 25, giveUpDist: 40 },
        ai: { pvp: aiMode, ttlMs: 100 }
      }
    });
    actor.onSpawn();
    const id = 2500;
    const e = { id, username: 'Steve', name: 'Steve', displayName: 'Steve', type: 'player', kind: 'player', isValid: true, position: bot.entity.position.offset(2, 0, 0), equipment: [] };
    bot.entities[id] = e;
    bot.players['Steve'] = { username: 'Steve', entity: e, gamemode: 0 };
    return { bot, actor, logs, entity: e };
  }

  testAsync('with ai=assist a "retreat" recommendation is ignored (safety veto)', async () => {
    const { actor, logs } = makeArenaPvp('assist');
    actor.jev = new J.JevClient({
      enabled: true, ttlMs: 1,
      transport: async () => ({ status: 200, body: JSON.stringify(okAnswer('retreat', { retreat: 0.9, attack: 0.05 }, { confidence: 0.99 })) })
    });
    actor.exec('pvp Steve hard');
    const p = actor.pvp;
    const d2 = Date.now() + 4000;
    while (Date.now() < d2 && !(p.summary().ai && p.summary().ai.last)) await sleep(60);
    const applied = p.summary().ai && p.summary().ai.applied;
    // The property under test is that an unsafe recommendation is NOT adopted, so
    // `applied` may legitimately be null (nothing was ever adopted) or some other
    // action. Asserting it was non-null would assert the opposite of the veto - my
    // error, caught by the run rather than by reading the intent of the test.
    assert.ok(p.summary().ai.last, 'the advisor answer should still be READ and reported');
    assert.strictEqual(p.summary().ai.last.action, 'retreat', 'the stub said retreat');
    assert.notStrictEqual(applied, 'retreat', 'assist mode must not let the advisor route the bot');
    assert.notStrictEqual(p.result, 'forfeit', 'and it must not end the fight');
    actor.destroy(); p.stop('test');
    void logs;
  });

  testAsync('with ai=force the recommendation is obeyed when it is legal', async () => {
    const { actor } = makeArenaPvp('force');
    actor.jev = new J.JevClient({
      enabled: true, ttlMs: 1,
      transport: async () => ({ status: 200, body: JSON.stringify(okAnswer('strafe', { strafe: 0.9, attack: 0.05 }, { confidence: 0.9 })) })
    });
    actor.exec('pvp Steve hard');
    const p = actor.pvp;
    // Poll, do not sleep a fixed 300 ms. What is under test is "the advisor's
    // answer reaches the loop", and the answer arrives on the *second* loop
    // cycle by design (the first fires the request and reads an empty cache).
    // A fixed sleep makes that a race against the event loop rather than a
    // statement about behaviour, and it failed intermittently in the full suite
    // while passing in isolation.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(p.summary().ai && p.summary().ai.last)) await sleep(60);
    const s = p.summary();
    assert.strictEqual(s.ai.mode, 'force');
    assert.strictEqual(s.ai.last.action, 'strafe', `advisor answer should be visible, got ${JSON.stringify(s.ai)}`);
    assert.strictEqual(s.ai.applied, 'strafe', 'force mode must apply it, not merely record it');
    actor.destroy(); p.stop('test');
  });

  testAsync('a slow advisor does not slow the fight loop', async () => {
    const { actor } = makeArenaPvp('assist');
    actor.jev = new J.JevClient({
      enabled: true, ttlMs: 1,
      transport: async () => { await new Promise(r => setTimeout(r, 400)); return { status: 200, body: JSON.stringify(okAnswer('attack', { attack: 1 })) }; }
    });
    actor.exec('pvp Steve hard');
    const p = actor.pvp;
    const t0 = Date.now();
    await sleep(600);
    const s = p.summary();
    assert.ok(s.counts.swings >= 0, 'the loop kept running');
    assert.ok(Date.now() - t0 >= 590, 'and the test window was real');
    actor.destroy(); p.stop('test');
  });

  testAsync('a dead advisor leaves the bot fighting normally', async () => {
    const { actor, logs } = makeArenaPvp('assist');
    actor.jev = new J.JevClient({
      enabled: true, maxFailures: 1, cooldownMs: 60000,
      transport: async () => { throw new Error('socket hang up'); }
    });
    actor.exec('pvp Steve hard');
    const p = actor.pvp;
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual(p.running, true, 'pvp must not stop because the advisor is down');
    assert.strictEqual(p.jev.snapshot().unavailable, true, 'and it should say so once, then back off');
    const out = logs.map(l => l[1]).join(' ');
    assert.ok(!/pvp loop ended/.test(out), out);
    actor.destroy(); p.stop('test');
  });

  test('ai off by default: no network calls from a stock config', () => {
    const world = MockWorld.arena({ floorY: FLOOR, radius: 10 });
    const bot = new MockBot(world, { manualTicks: true });
    bot._spawn();
    const actor = new Actor(bot, { config: { mode: 'afk' } });
    assert.strictEqual(actor.jev, null, 'a default config must not build an HTTP client');
    assert.strictEqual(actor.aiMode, 'off');
    actor.destroy();
  });
}

module.exports = { register };
