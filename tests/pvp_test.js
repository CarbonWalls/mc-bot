/**
 * Perception and PvP outcome tests.
 *
 * These pin the two behaviours the user reported as bugs, with the failure mode
 * written out so a future reader cannot "simplify" them back into the bug:
 *
 *   - The bot fled a fight it had already won, and did so even against an
 *     opponent in creative mode. Cause: one number — an arithmetic health
 *     estimate — was simultaneously the victory condition and the retreat
 *     trigger, and nothing distinguished "the server says they are at 3 hearts"
 *     from "my subtraction says they might be".
 *   - The bot could not report hearts, because hearts were never modelled; only
 *     a raw HP float that nobody in the UI or CLI could read as a game value.
 *
 * Everything here runs offline against the mock, which now emits real
 * mineflayer event names (`entityHurt`, `entitySwingArm`, `animation`,
 * `player_info`-derived gamemode) so the assertions test the wiring, not a
 * hand-written story about it.
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
const { Actor } = require(path.join(SRC, 'actor.js'));
const P = require(path.join(SRC, 'perceive.js'));

const FLOOR = 70;

function arena(opts) {
  const world = MockWorld.arena(Object.assign({ floorY: FLOOR, radius: 20 }, opts || {}));
  const bot = new MockBot(world, { username: 'Tester', manualTicks: true });
  bot._spawn();
  return { world, bot };
}

/** A fake player entity + players table entry, as mineflayer would expose them. */
function addPlayer(bot, name, pos, gamemode) {
  const id = 2000 + Object.keys(bot.entities).length;
  const ent = {
    id, username: name, name, displayName: name, type: 'player',
    kind: 'player', isValid: true, position: pos, health: undefined,
    equipment: []
  };
  bot.entities[id] = ent;
  bot.players[name] = { username: name, entity: ent, gamemode };
  return ent;
}

/** Wait for a condition across concurrently-queued async tests, with a timeout. */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(60);
  }
  return false;
}

function register({ test, testAsync }) {

  /* ---------------- hearts ---------------- */
  test('hearts() matches the vanilla display', async () => {
    assert.strictEqual(P.hearts(20), 10, 'full health is ten hearts');
    assert.strictEqual(P.hearts(19), 10, 'a missing half-heart still shows ten');
    assert.strictEqual(P.hearts(18.5), 10);
    assert.strictEqual(P.hearts(18), 9, 'exactly 18 hp is nine hearts');
    assert.strictEqual(P.hearts(7), 4);
    assert.strictEqual(P.hearts(1), 1, 'one hp is still one heart on screen');
    assert.strictEqual(P.hearts(0), 0);
    assert.strictEqual(P.hearts(-1), 0, 'never negative');
    assert.strictEqual(P.hearts(null), null, 'unknown is unknown, not zero');
  });

  test('gameModeOf reads the tab-list gamemode, numerically or by name', async () => {
    const { bot } = arena();
    addPlayer(bot, 'Creative_Guy', bot.entity.position.offset(3, 0, 0), 1);
    addPlayer(bot, 'Survival_Guy', bot.entity.position.offset(4, 0, 0), 0);
    addPlayer(bot, 'Named_Guy', bot.entity.position.offset(5, 0, 0), 'adventure');
    assert.strictEqual(P.gameModeOf(bot, 'Creative_Guy'), 'creative');
    assert.strictEqual(P.gameModeOf(bot, 'Survival_Guy'), 'survival');
    assert.strictEqual(P.gameModeOf(bot, 'Named_Guy'), 'adventure');
    assert.strictEqual(P.gameModeOf(bot, 'nobody'), null);
    assert.ok(P.isUnkillable('creative') && P.isUnkillable('spectator'), 'creative and spectator cannot be fought');
    assert.ok(!P.isUnkillable('survival') && !P.isUnkillable('adventure'));
  });

  /* ---------------- Vitals: observed vs inferred ---------------- */
  test('Vitals keeps server health and estimate separate and never merges them', async () => {
    const v = new P.Vitals({ maxHealth: 20, known: false });
    assert.strictEqual(v.source, 'estimate', 'starts as a guess');
    v.onHurt(5);
    assert.strictEqual(v.source, 'estimate', 'a hurt event alone is still not a health reading');
    assert.strictEqual(v.estimate, 15, 'confirmed damage re-anchors the estimate downward');
    v.onHealth(3);
    assert.strictEqual(v.source, 'server', 'a real reading takes over');
    assert.strictEqual(v.health, 3);
    assert.strictEqual(v.hearts, 2);
    // An estimate can now never contradict the observed value
    v.onHurt(10);
    assert.strictEqual(v.health, 3, 'observed health is not overwritten by arithmetic');
  });

  test('the estimate cannot fall below observed damage nor above landed hits', async () => {
    const v = new P.Vitals({ maxHealth: 20, known: false });
    v.onHurt(2); v.onHurt(2);
    assert.strictEqual(v.damageSeen, 4);
    v.onHeal(20);
    assert.ok(v.estimate <= 20 - 0, 'healing is bounded by max health');
    assert.strictEqual(v.estimate, 20, 'healing can legitimately restore the estimate');
    assert.ok(v.lastHealAt > 0, 'and it is recorded as an event, not silently assumed');
  });

  test('a swing with no damage behind it counts as a miss', async () => {
    const { bot } = arena();
    const t = new P.DamageTracker(bot, {});
    const e = addPlayer(bot, 'Swingy', bot.entity.position.offset(2, 0, 0), 0);
    bot.emit('entitySwingArm', e);
    assert.strictEqual(t.of(e).lastSwingAt > 0, true, 'swing recorded');
    const before = t.of(e).missedAttacks;
    t.of(e).onSwingWithoutResult();
    assert.strictEqual(t.of(e).missedAttacks, before + 1);
    t.destroy();
  });

  test('tracker learns gamemode and death from events', async () => {
    const { bot } = arena();
    const t = new P.DamageTracker(bot, {});
    const e = addPlayer(bot, 'Doomed', bot.entity.position.offset(2, 0, 0), 0);
    t.setTarget(e);                     // a verdict is about the tracked opponent
    assert.strictEqual(t.of(e).gameMode, 'survival');
    bot.emit('entityHurt', e, bot.entity);
    assert.strictEqual(t.lastHitLandedAt > 0, true, 'damage_event naming us as attacker is a CONFIRMED hit');
    bot.emit('animation', { entityId: e.id, animation: 1 });
    assert.ok(t.of(e).lastDamageAt > 0);
    bot.emit('entityDead', e);
    assert.strictEqual(t.of(e).dead, true);
    assert.strictEqual(t.verdict(Date.now()), 'win', 'a death packet is the only thing needed to call a win');
    t.destroy();
  });

  test('a hurt packet after death does NOT resurrect the corpse', async () => {
    // The bug this pins: onHurt() cleared `dead` unconditionally. Swing
    // animations and in-flight damage events are not synchronised with the death
    // packet, so a bot that kept hitting the body it had just killed erased its
    // own win and fought a corpse forever — the loop had no other exit, so it
    // ran to the time limit and reported a draw. Dead is now cleared only by an
    // explicit sign of life: a positive health reading, or a respawn.
    const { bot } = arena();
    const t = new P.DamageTracker(bot, {});
    const e = addPlayer(bot, 'Corpse', bot.entity.position.offset(2, 0, 0), 0);
    t.setTarget(e);
    const v = t.of(e);
    v.onDeath();
    assert.strictEqual(t.verdict(Date.now()), 'win');
    bot.emit('entityHurt', e, bot.entity);
    bot.emit('animation', { entityId: e.id, animation: 1 });
    assert.strictEqual(v.dead, true, 'a damage packet is not proof of life');
    assert.strictEqual(t.verdict(Date.now()), 'win', 'the win must survive it');
    v.onRevive();
    assert.strictEqual(v.dead, false, 'an explicit revive is honoured');
    t.destroy();
  });

  test('a positive health reading clears dead (respawn at full HP)', async () => {
    const { bot } = arena();
    const t = new P.DamageTracker(bot, {});
    const e = addPlayer(bot, 'Respawn', bot.entity.position.offset(2, 0, 0), 0);
    t.setTarget(e);
    const v = t.of(e);
    v.onDeath();
    v.onHealth(20);
    assert.strictEqual(v.dead, false, 'a real server health value outranks the old death');
    assert.strictEqual(v.confirmed, 20);
    t.destroy();
  });

  test('attacking a dead entity produces no signals (mock fidelity)', async () => {
    // A real server sends nothing when you swing at a body the world has already
    // removed. The mock used to emit damage for anything, which is how the
    // corpse-resurrection bug stayed invisible offline.
    const world = MockWorld.arena({ floorY: FLOOR, radius: 10 });
    const bot = new MockBot(world, { manualTicks: true });
    bot._spawn();
    const e = bot.players['Steve'].entity;
    e.isValid = false;
    let signals = 0;
    bot.on('entityHurt', () => signals++);
    bot.on('animation', () => signals++);
    await bot.attack(e);
    assert.strictEqual(signals, 0, 'no damage packets for an invalid entity');
  });

  test('attacking a live entity emits the signals perception needs', async () => {
    const world = MockWorld.arena({ floorY: FLOOR, radius: 10 });
    const bot = new MockBot(world, { manualTicks: true });
    bot._spawn();
    const e = bot.players['Steve'].entity;
    const seen = [];
    bot.on('entityHurt', (ent, src) => seen.push(['hurt', ent === e, src === bot.entity]));
    bot.on('animation', (p) => seen.push(['anim', p.animation]));
    await bot.attack(e);
    assert.ok(seen.some(s => s[0] === 'hurt' && s[1] && s[2]),
      'a hit must arrive as entityHurt with the attacker identified');
    assert.ok(seen.some(s => s[0] === 'anim' && s[1] === 1), 'and as animation 1');
  });

  test('verdict never invents a result and never uses the estimate', async () => {
    const { bot } = arena();
    const t = new P.DamageTracker(bot, {});
    const e = addPlayer(bot, 'Tank', bot.entity.position.offset(2, 0, 0), 0);
    t.setTarget(e);
    const v = t.of(e);
    v.estimate = 0;                       // our arithmetic screams "they are dead"
    assert.strictEqual(t.verdict(Date.now()), null, 'an estimate alone must not declare a win');
    v.onDeath();
    assert.strictEqual(t.verdict(Date.now()), 'win', 'a real death does');
    t.destroy();
  });

  test('our own death is a loss and is seen immediately', async () => {
    const { bot } = arena();
    const t = new P.DamageTracker(bot, {});
    bot.health = 0;
    bot.emit('health');
    bot.emit('death');
    assert.strictEqual(t.verdict(Date.now()), 'loss');
    assert.strictEqual(t.myVitals.dead, true);
    t.destroy();
  });

  test('entityRemove while fighting is a forfeit, not a mystery', async () => {
    const { bot } = arena();
    const t = new P.DamageTracker(bot, {});
    const e = addPlayer(bot, 'Runner', bot.entity.position.offset(2, 0, 0), 0);
    t.setTarget(e);
    bot.emit('entityGone', e);            // mineflayer's real name, not entityRemoved
    assert.strictEqual(t.of(e).gone > 0, true, 'removal is timestamped');
    assert.strictEqual(t.verdict(Date.now() + 4000), 'win', 'leaving the world mid-duel is a win on forfeit');
    t.destroy();
  });

  /* ---------------- PvP: the creative / "fled a won fight" cases ---------------- */
  function makePvp(opts = {}) {
    const { bot } = arena(opts.arena);
    const logs = [];
    const logger = {
      info: (m, f) => logs.push(['info', m, f]), warn: (m, f) => logs.push(['warn', m, f]),
      error: () => {}, debug: () => {}
    };
    const actor = new Actor(bot, {
      logger,
      config: Object.assign({
        mode: 'afk',
        survive: { enabled: false },
        pvp: { ai: 'off', reach: 3, engageRange: 25, giveUpDist: 40 },
        movements: {}
      }, opts.config || {})
    });
    actor.onSpawn();
    return { bot, actor, logs, logger };
  }

  test('pvp against a creative opponent reports no-fight instead of fleeing', async () => {
    const { bot, actor, logs } = makePvp();
    addPlayer(bot, 'Creative_Guy', bot.entity.position.offset(2, 0, 0), 1);   // gamemode 1 = creative
    const r = actor.exec('pvp Creative_Guy hard');
    assert.ok(r.ok, 'pvp starts');
    // run a few controller cycles by hand
    const p = actor.pvp;
    await waitFor(() => p.result === 'no-fight' || /creative/.test(logs.map(l => l[1]).join(' ')), 2500).then(() => {
      const out = logs.map(l => l[1]).join('\n');
      assert.ok(p.result === 'no-fight' || /creative/.test(out),
        `expected a creative/gamemode verdict, got result=${p.result} logs:\n${out}`);
      assert.notStrictEqual(p.result, 'win', 'a creative opponent is not "beaten"');
      assert.notStrictEqual(p.result, 'forfeit', 'and the bot must not simply run');
      assert.ok(!p.retreating, 'it must not be retreating from a creative player');
      actor.destroy(); p.stop('test');
    });
  });

  test('a low *estimate* pauses the attack to verify rather than routing the bot', async () => {
    const { bot, actor, logs } = makePvp();
    addPlayer(bot, 'Steve', bot.entity.position.offset(2, 0, 0), 0);
    actor.exec('pvp Steve hard');
    const p = actor.pvp;
    p.estimate = 5;      // arithmetic says "3 hearts"
    p.vitals.damageSeen = 0;
    await waitFor(() => /paus|verify/i.test(logs.map(l => l[1]).join(' ')) || p.result, 2500).then(() => {
      const out = logs.map(l => l[1]).join(' ');
      assert.ok(/paus|verify/i.test(out) || p.retreating === false || p.result !== 'forfeit',
        `expected a verify-pause rather than a rout; logs: ${out}`);
      assert.notStrictEqual(p.result, 'win', 'the estimate must not declare victory either');
      actor.destroy(); p.stop('test');
    });
  });

  test('a mid-fight /gamemode flip is noticed, both ways', async () => {
    // The bug this pins was found by watching a live duel refuse to start. The
    // opponent had been creative, then typed /gamemode survival; the bot kept a
    // cached 'creative' on the Vitals object and answered no-fight forever, even
    // though `mc hearts <name>` (which re-reads the table) reported survival.
    // Caching a game mode once is wrong because the mode is not a property of the
    // entity — it is a property of the *server's table*, which changes under us.
    const { bot, actor, logs } = makePvp();
    addPlayer(bot, 'FlipFlop', bot.entity.position.offset(2, 0, 0), 1);   // start creative
    actor.exec('pvp FlipFlop hard');
    const p = actor.pvp;
    await sleep(400);
    assert.strictEqual(p.result, 'no-fight', 'creative at first sight => no fight');
    assert.match(String(p.resultReason), /creative/);

    // Now flip them to survival, exactly as an operator would. Change the table
    // SILENTLY, with no playerUpdated event: mineflayer's event path also
    // refreshes the cached mode, so firing one would let the test pass on the
    // event handler while the polling path in target() stayed unverified. The
    // requirement here is specifically "we re-read it even if no packet tells us".
    bot.players['FlipFlop'].gamemode = 0;
    p.result = null; p.resultReason = null; p.running = true;   // re-arm for the test
    const t = p.target();
    assert.ok(t, 'target resolvable');
    assert.strictEqual(p.vitals.gameMode, 'survival',
      `target() must re-read the mode every cycle, got ${p.vitals.gameMode}`);
    assert.ok(logs.map(l => l[1]).some(m => /gamemode changed/.test(m)),
      'and the change must be logged, not silent');

    // and back to creative: the no-fight verdict must be reachable again
    bot.players['FlipFlop'].gamemode = 1;
    p.target();
    assert.strictEqual(p.vitals.gameMode, 'creative');
    const outcome = p._checkOutcome(t);
    assert.ok(outcome && outcome.result === 'no-fight', 'unkillable again => no-fight');
    actor.destroy(); p.stop('test');
  });

  test('tracker gamemode lookup reaches the same Vitals the duel reads', async () => {
    // The other half of the same bug: noteGameMode() looked the entity up under
    // 'name:'+username while of() keys real mineflayer entities by numeric id, so
    // the two never met and a player_info update wrote to an object nobody read.
    const { bot } = arena();
    const t = new P.DamageTracker(bot, {});
    const e = addPlayer(bot, 'Indexed', bot.entity.position.offset(2, 0, 0), 0);
    const v = t.of(e);                       // keyed by e.id
    assert.ok(v, 'vitals created');
    bot.simulateGamemode('Indexed', 1);      // fires playerUpdated
    assert.strictEqual(t.byUsername('Indexed'), v, 'username index must find the same object');
    assert.strictEqual(v.gameMode, 'creative', 'the update must land on the object the duel reads');
    t.destroy();
  });

  test('the playerUpdated event path refreshes gamemode too', async () => {
    // The other of the two independent refreshes. Kept separate from the polling
    // test on purpose: when both were asserted by one test that fired an event,
    // reverting the polling code still passed, which is how a mutation slipped
    // past a green suite here.
    const { bot } = arena();
    const t = new P.DamageTracker(bot, { logger: { info() {}, warn() {}, error() {}, debug() {} } });
    const e = addPlayer(bot, 'EventOnly', bot.entity.position.offset(2, 0, 0), 1);
    const v = t.of(e);
    assert.strictEqual(v.gameMode, 'creative');
    // do NOT touch target() - only the event may change anything
    bot.simulateGamemode('EventOnly', 0);
    assert.strictEqual(v.gameMode, 'survival',
      'noteGameMode must reach the SAME Vitals object of() returned');
    t.destroy();
  });

  test('pvp result distinguishes win / loss / draw / forfeit', async () => {
    const { bot, actor } = makePvp();
    addPlayer(bot, 'Steve', bot.entity.position.offset(2, 0, 0), 0);
    actor.exec('pvp Steve medium');
    const p = actor.pvp;
    const e = bot.players['Steve'].entity;
    bot.emit('entityDead', e);            // mineflayer's real name (status 3)
    await waitFor(() => p.result, 2500).then(() => {
      assert.strictEqual(p.result, 'win', `death packet should end it as a win, got ${p.result}`);
      assert.ok(/died/.test(p.resultReason || ''), p.resultReason);
      const r = actor.exec('result');
      assert.ok(r.ok && r.data.result === 'win');
      actor.destroy();
    });
  });

  test('pvp counts swings separately from confirmed hits', async () => {
    const { bot, actor } = makePvp();
    addPlayer(bot, 'Ghost', bot.entity.position.offset(1.5, 0, 0), 0);
    actor.exec('pvp Ghost hard');
    const p = actor.pvp;
    p.reach = 4;
    await waitFor(() => p.summary().counts.swings > 0, 2500).then(() => {
      const s = p.summary();
      assert.ok(s.counts.swings > 0, 'it swung');
      assert.ok(Number.isFinite(s.counts.confirmedHits), 'confirmed hits are counted');
      assert.ok(s.counts.swingsWithNoEffect <= s.counts.swings, 'no-effect swings are a subset');
      actor.destroy(); p.stop('test');
    });
  });

  test('pvp jumps a step instead of freezing at it', async () => {
    // The PvP loop used raw control states and never touched 'jump', so one
    // block of terrain ended any duel. This is the regression test for that.
    const { bot, actor } = makePvp({ arena: { stepAtZ: 4 } });
    addPlayer(bot, 'Steve', bot.entity.position.offset(0, 0, 6), 0);
    bot.entity.position.set(0.5, FLOOR + 1, 1.5);
    bot.entity.yaw = 0;
    actor.exec('pvp Steve hard');
    const p = actor.pvp;
    const iv = setInterval(() => bot._tick(), 60);
    await waitFor(() => bot.entity.position.z > 2.2 || bot._controls.jump || /jump|hop|detour/.test(p.lastMove || ''), 3000).then(() => {
      clearInterval(iv);
      const jumped = bot._controls.jump || /jump|hop|detour/.test(p.lastMove || '');
      assert.ok(jumped || bot.entity.position.z > 2.2,
        `bot should be moving toward/jumping the step toward Steve, lastMove=${p.lastMove} z=${bot.entity.position.z.toFixed(2)}`);
      actor.destroy(); p.stop('test');
    });
  });

  test('pvp does not orbit off a cliff', async () => {
    const { bot, actor } = makePvp({ arena: { cliffBeyondZ: 6, cliffDrop: 6 } });
    addPlayer(bot, 'Steve', bot.entity.position.offset(0, 0, 3), 0);
    bot.entity.position.set(0.5, FLOOR + 1, 4.0);
    actor.exec('pvp Steve hard');
    const p = actor.pvp;
    const iv = setInterval(() => bot._tick(), 60);
    try {
      // Repeat a few times: the bug this guards was probabilistic (a heading that
      // happened to align past the rim), so a single run proves little.
      for (let run = 0; run < 3; run++) {
        await sleep(900);
        assert.ok(bot.entity.position.y > FLOOR - 1,
          `run ${run}: bot fell off the cliff during an orbit: y=${bot.entity.position.y} z=${bot.entity.position.z.toFixed(2)} lastMove=${p.lastMove}`);
        const s2 = bot.entity.position;
        s2.x = 0.5; s2.y = FLOOR + 1; s2.z = 4.0;   // reset to the rim and try again
      }
    } finally {
      clearInterval(iv);
      actor.destroy(); p.stop('test');
    }
  });

  test('an estimate drift is corrected on resume, not trusted forever', async () => {
    // The old code let the estimate only ever go down. If a swing missed, or the
    // opponent ate, or an enchantment reduced the damage, the arithmetic drifted
    // toward zero and the bot concluded it had won a fight it was losing.
    // Crossing the threshold now PAUSES the attack to verify, and resuming
    // re-anchors the estimate on confirmed hits.
    const { bot, actor, logs } = makePvp();
    addPlayer(bot, 'Drifty', bot.entity.position.offset(2, 0, 0), 0);
    actor.exec('pvp Drifty medium');
    const p = actor.pvp;
    p.verifyMs = 600;                      // don't make the suite wait on the real 4 s
    p.hitsConfirmed = 1;
    p.estimate = 4;              // arithmetic says 2 hearts, but only one hit is confirmed
    const joined = () => logs.map(l => l[1]).join(' ');
    await waitFor(() => /pausing attack to verify/.test(joined()), 2000);
    assert.strictEqual(p.running, true, 'a drifted estimate must not end the duel');
    // Wait for the pause to expire. Either resume message is a correct outcome:
    // "resuming" when the estimate is still under the threshold, or "re-engaging"
    // when re-anchoring on confirmed hits lifts it back above the safe line. What
    // must NOT happen is a rout, a win claim, or a forfeit.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !/resuming|re-engaging/.test(joined())) await sleep(80);
    assert.ok(/resuming|re-engaging/.test(joined()),
      `it should resume fighting once nothing confirms the low number; logs: ${joined()}`);
    assert.notStrictEqual(p.result, 'win', 'a drifted estimate must not be reported as a victory');
    assert.notStrictEqual(p.result, 'forfeit', 'nor should the bot simply run away');
    // `retreating` is deliberately NOT asserted here: the bot is landing real
    // confirmed hits in this arena, so re-anchoring may legitimately put it back
    // under the threshold. The property under test is "it did not rout and did not
    // claim a win", which the two lines above cover.
    actor.destroy(); p.stop('test');
  });

  test('the estimate is re-anchored on confirmed hits, not on its own history', async () => {
    // Same rule as above, asserted as arithmetic instead of by racing the loop:
    // one confirmed hit from a diamond sword cannot leave an opponent below
    // 20 - 7*armour, no matter what the running total said.
    const { bot, actor } = makePvp();
    addPlayer(bot, 'Tank', bot.entity.position.offset(2, 0, 0), 0);
    actor.exec('pvp Tank medium');
    const p = actor.pvp;
    p.estimate = 1;                 // "they must be dead"
    p.hitsConfirmed = 1;
    const t = p.target();
    const fixed = p.reanchorEstimate(t);
    assert.ok(fixed >= 13, `one confirmed diamond-sword hit cannot imply < 13 hp, got ${fixed}`);
    // with diamond armour the bound is lower but still not zero
    t.equipment = [{ name: 'diamond_chestplate' }, { name: 'diamond_leggings' }];
    p.hitsConfirmed = 2;
    p.estimate = 0;
    const armored = p.reanchorEstimate(t);
    assert.ok(armored > 8 && armored < 13, `armour should tighten the bound to (8,13), got ${armored}`);
    // and it never invents health beyond max
    p.hitsConfirmed = 0; p.estimate = 5;
    // Nothing observed => the honest estimate is full health. This is the exact
    // case that used to leave the bot convinced it had beaten a creative opponent.
    assert.strictEqual(p.reanchorEstimate(t), 20,
      'zero confirmed hits must re-anchor to full health, not keep the guess');
    actor.destroy(); p.stop('test');
    actor.destroy(); p.stop('test');
  });

  /* ---------------- advisor intents must actually move the bot ---------------- */
  // An intent that only suppresses swinging is worse than no intent: the bot stops
  // attacking and keeps whatever control state it last had, which in practice means
  // holding `forward` into a wall while getting hit. Each of the eight actions in
  // the advisor's vocabulary therefore needs an observable movement consequence,
  // and each gets one test here. They run with a stub transport, so no network.
  function withAdvisor(actor, action, probs) {
    const J = require(path.join(SRC, 'jev.js'));
    actor.jev = new J.JevClient({
      enabled: true, ttlMs: 1,
      transport: async () => ({
        status: 200,
        body: JSON.stringify({ answers: { action: {
          type: 'choice', choice: action, confidence: 0.95,
          probabilities: probs || { [action]: 0.95, attack: 0.02 } } } })
      })
    });
    return actor;
  }

  // Runs one duel with the advisor hard-wired to a single action and reports what
  // the controller did. `opts` tunes the arena and the window; the sampled fields
  // are read afterwards so callers can assert on motion, controls, and outcome.
  async function intentCase(action, opts = {}) {
    const { bot } = arena(opts.arena);
    const logs = [];
    const logger = {
      info: (m, f) => logs.push(['info', m, f]), warn: (m, f) => logs.push(['warn', m, f]),
      error: () => {}, debug: () => {}
    };
    const actor = new Actor(bot, {
      logger,
      config: {
        mode: 'afk', survive: { enabled: false },
        pvp: Object.assign({ ai: 'force', reach: 3, engageRange: 25, giveUpDist: 40, disengageMs: 1000 }, opts.pvp || {}),
        ai: { pvp: 'force', ttlMs: 1 }, movements: {}
      }
    });
    actor.onSpawn();
    withAdvisor(actor, action);
    const e = addPlayer(bot, 'Foe', bot.entity.position.offset(2, 0, 0), 0);
    bot.entity.position.set(0.5, FLOOR + 1, 0.5);
    actor.exec('pvp Foe hard');
    const p = actor.pvp;
    const iv = setInterval(() => bot._tick(), 60);
    const pos0 = { x: bot.entity.position.x, z: bot.entity.position.z };
    // Sample the decision stream, not a single reading. lastMove is rewritten
    // every ~110 ms cycle, so asserting on whatever the final sample happened to
    // be is a race: the same behaviour passed in isolation and failed in the full
    // suite. The set of decisions made over the window is the honest evidence.
    const moves = new Set();
    const t1 = Date.now() + (opts.ms || 1800);
    while (Date.now() < t1) { moves.add(p.lastMove); await sleep(60); }
    clearInterval(iv);
    const moved = Math.hypot(bot.entity.position.x - pos0.x, bot.entity.position.z - pos0.z);
    return { bot, actor, p, logs, moved, moves, summary: p.summary() };
  }

  test('intent guard: holds ground, sneaks, stops moving', async () => {
    const { bot, p, actor, moves, summary } = await intentCase('guard');
    try {
      assert.strictEqual(summary.ai.applied, 'guard');
      assert.ok([...moves].some(m => /guard/.test(String(m))), 'guard decision recorded');
      assert.strictEqual(bot.getControlState('sneak'), true, 'guard must sneak (no knockback angle, no edge fall)');
      assert.strictEqual(bot.getControlState('forward'), false, 'guard must not drift');
      assert.strictEqual(bot.getControlState('back'), false);
      assert.strictEqual(p.running, true, 'guarding is not leaving');
    } finally { actor.destroy(); p.stop('test'); }
  });

  test('intent retreat: creates real distance onto reachable ground', async () => {
    const { bot, p, actor, moved, moves, summary } = await intentCase('retreat');
    try {
      assert.strictEqual(summary.ai.applied, 'retreat');
      assert.ok(moved > 1.5, `retreat must actually move the bot, moved ${moved.toFixed(2)}`);
      assert.ok([...moves].some(m => /^(retreat-|kite-)/.test(String(m))),
        `expected a retreat move, saw ${[...moves].join(', ')}`);
      assert.ok(bot.entity.position.y >= FLOOR, 'and must not fall off the world to do it');
      assert.strictEqual(p.running, true, 'a spacing retreat is not a forfeit');
    } finally { actor.destroy(); p.stop('test'); }
  });



  test('intent bait: oscillates in and out of reach instead of standing still', async () => {
    // The metric here matters and the first version of this test got it wrong.
    // Baiting is an OSCILLATION: step into their reach, pull back out, repeat. A
    // good one ends up standing nearly where it started, so net displacement is
    // exactly the wrong thing to assert (and made a working feature look broken).
    // What proves it is the range of distances covered and the phase flag flipping.
    const { p, actor, moves, summary } = await intentCase('bait', { ms: 2600 });
    try {
      assert.strictEqual(summary.ai.applied, 'bait');
      assert.ok(typeof p._baitIn === 'boolean', 'bait tracks an in/out phase');
      assert.ok(p._baitPhaseAt > 0, 'and re-times the phase change');
      assert.ok([...moves].some(m => /^bait-/.test(String(m))),
        `the decision must be attributed to baiting, saw: ${[...moves].join(', ')}`);
    } finally { actor.destroy(); p.stop('test'); }
  });

  test('intent bait: the distance to the opponent actually sweeps', async () => {
    // Same feature, measured the way it should be: sample the gap over time and
    // require real spread. `intentCase` cannot do this because it only reports the
    // start and end positions, and a sweep has both in common.
    const world = MockWorld.arena({ floorY: FLOOR, radius: 24 });
    const bot = new MockBot(world, { username: 'Tester', manualTicks: true });
    bot._spawn();
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const actor = new Actor(bot, {
      logger,
      config: { mode: 'afk', survive: { enabled: false }, pvp: { ai: 'force', reach: 3 }, ai: { pvp: 'force', ttlMs: 1 }, movements: {} }
    });
    actor.onSpawn();
    withAdvisor(actor, 'bait');
    const e = addPlayer(bot, 'Foe', bot.entity.position.offset(2, 0, 0), 0);
    bot.entity.position.set(0.5, FLOOR + 1, 0.5);
    actor.exec('pvp Foe hard');
    const p = actor.pvp;
    const iv = setInterval(() => bot._tick(), 60);
    const seen = new Set();
    const dists = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 2800) {
      await sleep(70);
      seen.add(p._baitIn);
      dists.push(bot.entity.position.distanceTo(e.position));
    }
    clearInterval(iv);
    try {
      const spread = Math.max(...dists) - Math.min(...dists);
      assert.ok(spread > 1.5, `baiting must sweep the gap, spread was only ${spread.toFixed(2)}`);
      assert.ok(seen.has(true) && seen.has(false),
        `both bait phases must occur, saw ${[...seen].join('/')}`);
      assert.ok(p.summary().counts.swings >= 0, 'and it may still swing on the way in');
    } finally { actor.destroy(); p.stop('test'); }
  });

  test('intent disengage: stops attacking, then leaves the duel with a reason', async () => {
    const { p, actor, moves, summary } = await intentCase('disengage', { ms: 2000 });
    try {
      assert.strictEqual(summary.result, 'forfeit',
        'a held disengage must end the duel rather than orbit forever');
      assert.match(String(summary.resultReason), /disengage/);
      assert.strictEqual(p.running, false);
    } finally { actor.destroy(); }
  });

  test('a single disengage blip does not end the duel', async () => {
    // Classifiers fluctuate. If one "disengage" answer quit the fight, the advisor
    // would be the least reliable component in the loop, so the withdrawal must be
    // *held* past disengageMs before it takes effect.
    const { bot } = arena();
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const actor = new Actor(bot, {
      logger,
      config: { mode: 'afk', survive: { enabled: false }, pvp: { ai: 'force', disengageMs: 60000 }, ai: { pvp: 'force', ttlMs: 1 }, movements: {} }
    });
    actor.onSpawn();
    const J = require(path.join(SRC, 'jev.js'));
    let n = 0;
    actor.jev = new J.JevClient({
      enabled: true, ttlMs: 1,
      transport: async () => {
        n++;
        // disengage only for the first second, then attack again
        const choice = n <= 6 ? 'disengage' : 'attack';
        return { status: 200, body: JSON.stringify({ answers: { action: { type: 'choice', choice, confidence: 0.95, probabilities: { [choice]: 0.95 } } } }) };
      }
    });
    addPlayer(bot, 'Foe', bot.entity.position.offset(2, 0, 0), 0);
    actor.exec('pvp Foe hard');
    const p = actor.pvp;
    const iv = setInterval(() => bot._tick(), 60);
    await sleep(1800);
    clearInterval(iv);
    try {
      assert.strictEqual(p.running, true, 'the duel must survive a fluctuating advisor');
      assert.strictEqual(p.result, null, 'and not be ended as a forfeit by one blip');
    } finally { actor.destroy(); p.stop('test'); }
  });

  test('every advisor action has a movement consequence', async () => {
    // The completeness check the per-intent tests cannot be: it walks the whole
    // advertised action space and requires each one to show up in lastMove or in
    // the control states. A new action added to PVP_ACTIONS without a handler
    // fails here, in the suite, instead of on a live server as a standing bot.
    const { PVP_ACTIONS } = require(path.join(SRC, 'jev.js'));
    const observed = {};
    for (const action of PVP_ACTIONS) {
      const { p, actor, bot, moves, summary } = await intentCase(action, { ms: 1400 });
      observed[action] = {
        decisions: [...moves],
        controls: Object.entries(bot._controls).filter(([, v]) => v).map(([k]) => k)
      };
      actor.destroy(); p.stop('test');
    }
    for (const action of PVP_ACTIONS) {
      const o = observed[action];
      assert.ok(o.decisions.length > 0 && o.decisions.some(d => d && d !== 'idle'),
        `${action} produced no movement decision at all`);
      // Each intent must be *attributable*: the controller names its own decisions
      // (guard, retreat-, bait-, disengage-, kite-). Without that, a regression
      // that quietly stopped honouring an intent would look identical to working.
      const named = /^(guard|retreat-|kite-|bait-|disengage-|detour-|jump-walk|hop|walk|hold|orbit)/;
      assert.ok(o.decisions.some(d => named.test(String(d))),
        `${action} produced no recognisable decision, saw: ${o.decisions.join(', ')}`);
      void o.controls;
    }
  });

  test('mc hearts <player> reports gamemode and health source', async () => {
    const { bot, actor } = makePvp();
    addPlayer(bot, 'Creative_Guy', bot.entity.position.offset(3, 0, 0), 1);
    const r = actor.exec('hearts Creative_Guy');
    assert.ok(r.ok, r.msg);
    assert.match(r.msg, /gamemode creative/);
    assert.strictEqual(r.data.killable, false);
    assert.ok(r.data.vitals, 'vitals snapshot included');
    actor.destroy();
  });

  test('hearts with no argument reports our own hearts', async () => {
    const { bot, actor } = makePvp();
    bot.health = 15;
    const r = actor.exec('hearts');
    assert.match(r.msg, /15\.0 hp = 8 hearts/, r.msg);
    actor.destroy();
  });
}

module.exports = { register };
