/**
 * Anti-stuck watchdog regression tests.
 *
 * The watchdog exists to satisfy the project's core promise — a goal must not
 * get stuck halfway. But the same watchdog caused the opposite failure: right
 * after a goal was set, the pathfinder spends a moment *computing* the path
 * rather than walking, so movement was zero and the watchdog immediately fired
 * `unstick()`. It burned all 4 recovery attempts within seconds and gave up on
 * goals the bot could trivially reach. Goto would report "stuck" three times
 * and then stop, 8 blocks short.
 *
 * The fix gives the pathfinder a grace period after each goal change. These
 * tests pin both halves: the grace period, and that a *genuine* stall still
 * triggers recovery.
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
const { Actor } = require(path.join(SRC, 'actor.js'));

function makeActor(cfg = {}) {
  const world = new MockWorld();
  world.generate();
  const bot = new MockBot(world);
  bot._spawn();
  // Freeze the mock's own 120ms physics timer. A test that awaits real time
  // (which the async recovery now requires) would otherwise see the bot drift,
  // and the watchdog would correctly decide it is NOT stuck — the right
  // behaviour, but it makes a stall test vacuous. With the timer stopped the bot
  // only moves when a test calls _tick(), so "stalled" means stalled.
  for (const t of bot._timers) { clearInterval(t); clearTimeout(t); }
  bot._timers = [];
  // Actor reads its settings from opts.config (mirroring how BotCore builds it).
  const actor = new Actor(bot, {
    config: {
      mode: 'afk',
      survive: { enabled: false, eatAt: 16, fleeHealth: 10 },
      stuckTimeoutMs: 400,
      maxStuckAttempts: 4,
      goalTimeoutMs: 60000,
      canDig: true,
      ...cfg
    }
  });
  return { actor, bot };
}

function register({ test }) {

  test('a freshly set goal is not judged as stuck during path computation', () => {
    const { actor, bot } = makeActor();
    // Set a goal the bot has not started moving toward yet. The old code fired
    // unstick() on the very first tick because `moved` was false.
    actor.goalDesc = { type: 'near', x: 5, y: 70, z: 5, range: 3 };
    actor.goalStartedAt = Date.now();
    bot.pathfinder._goal = actor.goalDesc;
    bot.pathfinder._moving = false;             // pathfinder is still computing
    const before = actor.stuckAttempts;
    actor.tick();
    assert.strictEqual(actor.stuckAttempts, before,
      'a goal set moments ago must not count as stuck — the pathfinder is still computing');
  });

  test('a goal that has been live a while with no movement DOES trigger recovery', () => {
    const { actor, bot } = makeActor({ stuckTimeoutMs: 100 });
    actor.goalDesc = { type: 'near', x: 50, y: 70, z: 50, range: 3 };
    // Old enough that the grace period has elapsed, and lastMoveAt is stale.
    actor.goalStartedAt = Date.now() - 5000;
    actor.lastMoveAt = Date.now() - 5000;
    actor.lastPos = bot.entity.position.clone();
    bot.pathfinder._goal = actor.goalDesc;
    bot.pathfinder._moving = true;              // pathfinder believes it is moving
    actor.tick();
    assert.ok(actor.stuckAttempts >= 1, 'a genuine stall must still trigger unstick()');
  });

  test('moving again forgives previous stalls', () => {
    const { actor, bot } = makeActor();
    actor.stuckAttempts = 3;
    actor.goalStartedAt = Date.now() - 5000;
    actor.goalDesc = { type: 'near', x: 5, y: 70, z: 5, range: 3 };
    bot.pathfinder._goal = actor.goalDesc;
    bot.pathfinder._moving = true;
    // nudge the bot so `moved` is true this tick
    bot.entity.position.x += 1;
    actor.tick();
    assert.strictEqual(actor.stuckAttempts, 0, 'movement should reset the stall counter');
  });

  test('repeated stalls give up and return the bot to AFK, not a hang', async () => {
    const { actor, bot } = makeActor({ stuckTimeoutMs: 50, maxStuckAttempts: 2 });
    actor.setMode('goto');
    actor.goalDesc = { type: 'near', x: 500, y: 70, z: 500, range: 3 };   // unreachable
    bot.pathfinder._goal = actor.goalDesc;
    bot.pathfinder._moving = true;
    // A recovery is now an async sequence, so ticks must be driven over time
    // rather than hammered synchronously. The contract is unchanged: after
    // maxStuckAttempts completed recoveries the bot gives up and goes AFK.
    const deadline = Date.now() + 30000;
    let lastArmed = 0;
    while (Date.now() < deadline && actor.mode !== 'afk') {
      // keep the stall "stale" so the watchdog keeps firing between recoveries
      if (!actor._recovering && Date.now() - lastArmed > 120) {
        actor.goalStartedAt = Date.now() - 30000;
        actor.lastMoveAt = Date.now() - 30000;
        actor.lastPos = bot.entity.position.clone();
        lastArmed = Date.now();
      }
      actor.tick();
      await new Promise(r => setTimeout(r, 60));
    }
    assert.strictEqual(actor.mode, 'afk',
      `after maxStuckAttempts the bot must give up and go AFK rather than spin (attempts=${actor.stuckAttempts})`);
    actor.destroy();
  });

  test('one recovery at a time: ticks during an in-flight recovery must not stack attempts', async () => {
    // The live failure this pins. A recovery takes seconds (walk+jump loop,
    // then climbOut up to 2.6s, then a dig), but the 500ms tick kept re-entering
    // unstick() and burned all four attempts in 1.5 seconds. Observed on a real
    // server:
    //     attempt=1 ... attempt=4, "giving up after repeated stalls"
    //     climb result res=climbed        <-- the climb WORKED, after the give-up
    // So the bot quit a hole it had already solved. The watchdog must wait for
    // the attempt it started.
    const { actor, bot } = makeActor({ stuckTimeoutMs: 10, maxStuckAttempts: 4 });
    actor.setMode('goto');
    actor.goalDesc = { type: 'near', x: 500, y: 70, z: 500, range: 3 };
    bot.pathfinder._goal = actor.goalDesc;
    bot.pathfinder._moving = true;
    actor.goalStartedAt = Date.now() - 30000;
    actor.lastMoveAt = Date.now() - 30000;
    actor.lastPos = bot.entity.position.clone();

    actor.tick();                                  // fires the first recovery
    assert.ok(actor._recovering, 'the recovery should be in flight');
    assert.strictEqual(actor.stuckAttempts, 1, 'exactly one attempt started');

    // Hammer the watchdog for 2s the way the 500ms tick would, keeping the
    // "no movement" condition true the whole time.
    const until = Date.now() + 2000;
    let ticks = 0;
    while (Date.now() < until) {
      actor.goalStartedAt = Date.now() - 30000;
      actor.lastPos = bot.entity.position.clone();  // pretend it never moved
      actor.tick();
      ticks++;
      await new Promise(r => setTimeout(r, 40));
    }
    assert.ok(ticks > 10, `the loop should have ticked many times, got ${ticks}`);
    assert.ok(actor.stuckAttempts <= 2,
      `a stall of 2s with slow recoveries must not burn the whole budget (attempts=${actor.stuckAttempts})`);
    assert.notStrictEqual(actor.mode, 'afk',
      'the bot must NOT have given up while a recovery was still working');
    actor.destroy();
  });

  test('unstick() re-arms the stall clock so the in-flight attempt can finish', () => {
    // Same bug, asserted directly and cheaply: if unstick did not move
    // lastMoveAt forward, the very next tick (500ms later in the daemon) would
    // see another stale clock and stack a second recovery on top of the first.
    const { actor, bot } = makeActor({ stuckTimeoutMs: 100, maxStuckAttempts: 4 });
    actor.goalDesc = { type: 'near', x: 500, y: 70, z: 500, range: 3 };
    bot.pathfinder._goal = actor.goalDesc;
    bot.pathfinder._moving = true;
    actor.goalStartedAt = Date.now() - 30000;
    actor.lastMoveAt = Date.now() - 30000;
    const before = actor.lastMoveAt;
    actor.unstick();
    assert.ok(actor.lastMoveAt > before,
      'starting a recovery must re-arm the clock the watchdog measures');
    assert.strictEqual(actor.stuckAttempts, 1);
    // and a second call while one runs is a no-op
    actor.unstick();
    assert.strictEqual(actor.stuckAttempts, 1, 're-entrancy must be refused');
    actor.destroy();
  });

  test('no goal means the watchdog does nothing', () => {
    const { actor, bot } = makeActor({ stuckTimeoutMs: 10 });
    actor.lastMoveAt = Date.now() - 60000;   // not moving for ages
    actor.lastPos = bot.entity.position.clone();
    bot.pathfinder._goal = null;             // but not pathing either
    assert.doesNotThrow(() => actor.tick());
    assert.strictEqual(actor.stuckAttempts, 0, 'an idle bot must never be flagged stuck');
  });

  test('a recovery in flight must not forgive the stall it is recovering from', () => {
    // Reported live as a bot wedged forever: `moving again` reset the counter on
    // the tiny movement the recovery's own walk produced, so attempts oscillated
    // 1 -> 2 -> 1 -> 2 and never reached the cap, and the bot never re-rolled its
    // unreachable wander target. While _recovering is true the counter must hold.
    const { actor, bot } = makeActor({ stuckTimeoutMs: 400, maxStuckAttempts: 4 });
    actor.stuckAttempts = 2;
    actor._recovering = true;
    actor.lastPos = bot.entity.position.clone().offset(1, 0, 0);   // > 0.2 blocks moved
    actor.lastMoveAt = Date.now();
    bot.pathfinder._goal = { type: 'near', x: 500, y: 70, z: 500, range: 3 };
    bot.pathfinder._moving = true;
    actor.goalDesc = bot.pathfinder._goal;
    actor.goalStartedAt = Date.now() - 30000;
    actor.tick();
    assert.strictEqual(actor.stuckAttempts, 2,
      'the stall budget must survive the recovery that has not fixed the stall');
    // Once the recovery is over, movement legitimately forgives the stall again.
    actor._recovering = false;
    actor.lastPos = bot.entity.position.clone().offset(1, 0, 0);   // moved again
    actor.tick();
    assert.strictEqual(actor.stuckAttempts, 0, 'after recovery, real movement forgives past stalls');
    actor.destroy();
  });

  test('recovery has a descent phase: a goal below the bot is not a dead end', async () => {
    // Reported: "wander gets stuck on the current level of y (it doesn't want to
    // fall or go up 1 block or more)". The ladder could only jump, climb UP, or
    // dig, so a goal below had no move at all. This asserts the phase exists and
    // is asked for with a descent budget; the live log confirms it runs end to
    // end (`goal is below, stepping down dy=-11` then the bot drops y=70 -> 63).
    //
    // Phase 1 is stubbed to make no progress so the descent branch is the one
    // exercised, instead of depending on the mock pathfinder's route choice.
    const world = MockWorld.arena({ floorY: 70, radius: 24 });
    const bot = new MockBot(world, { manualTicks: true });
    bot._spawn();
    for (const t of bot._timers) { clearInterval(t); clearTimeout(t); }
    bot._timers = [];
    const logs = [];
    const actor = new Actor(bot, {
      logger: { info: (m, d) => logs.push([m, d]), warn: (m, d) => logs.push([m, d]), error() {}, debug() {} },
      config: { mode: 'afk', survive: { enabled: false }, stuckTimeoutMs: 400, maxStuckAttempts: 4, canDig: true }
    });
    actor.onSpawn();
    bot.entity.position.set(0.5, world.surfaceY(0, 0) + 6, 0.5);
    // A goal well below: the descent branch must be selected on the goal's dy.
    actor.goalDesc = { type: 'near', x: 8, y: world.surfaceY(8, 8) + 1, z: 8, range: 2 };
    const dy = actor.goalDesc.y - bot.entity.position.y;
    assert.ok(dy < -0.5, `test precondition: the goal must be below the bot (dy=${dy})`);
    // Phase 1 must not be allowed to claim the credit.
    actor._progressSince = () => false;
    const M = require(path.join(SRC, 'movement.js'));
    const realWalk = M.walkToward;
    const seen = [];
    M.walkToward = (b, to, opts) => { seen.push(opts || {}); return 'blocked'; };
    try {
      await actor._recoverInner(1, 4, actor.goalDesc, bot);
    } finally {
      M.walkToward = realWalk;
    }
    const descending = logs.some(([m, d]) => m === 'actor: goal is below, stepping down' && d && d.dy < 0);
    assert.ok(descending, 'the recovery ladder must contain a descent phase for a goal below');
    const descentWalk = seen.find(o => o.allowEdge === true && o.maxDrop >= 3 && o.hop === false);
    assert.ok(descentWalk,
      'the descent walk must deliberately allow the edge with a safe 3-block budget ' +
      `(opts seen: ${JSON.stringify(seen)})`);
    actor.destroy();
  });

  test('wander only proposes targets the bot can actually walk to', () => {
    // The root cause of "wander gets stuck on the current level of y": the picker
    // measured every candidate column against a stale reference height and happily
    // proposed a target across a cliff, which the pathfinder cannot route to. The
    // live log proved it: `goal is below, stepping down dy=-12 maxDrop=3` while the
    // bot never moved. A plateau above a deep plain makes the rule checkable.
    const world = MockWorld.arena({ floorY: 70, radius: 40, cliffBeyondZ: 12, cliffDrop: 10 });
    const bot = new MockBot(world, { manualTicks: true });
    bot._spawn();
    for (const t of bot._timers) { clearInterval(t); clearTimeout(t); }
    bot._timers = [];
    const actor = new Actor(bot, {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: { mode: 'wander', survive: { enabled: false }, movements: {} }
    });
    actor.onSpawn();
    bot.entity.position.set(0.5, world.surfaceY(0, 0) + 1, 0.5);   // on the plateau
    const hereY = bot.entity.position.y;
    const ys = [];
    for (let i = 0; i < 200; i++) {
      const t = actor._randomReachable(40);
      if (t) ys.push(t.y);
    }
    assert.ok(ys.length > 20, `the picker must still find targets (found ${ys.length}/200)`);
    const outOfBand = ys.filter(y => y < hereY - 3 || y > hereY + 2);
    assert.deepStrictEqual(outOfBand, [],
      `targets must stay in the walkable band of y=${hereY} (-3 fall .. +2 climb), got ${[...new Set(outOfBand)]}`);
    actor.destroy();
  });

  test('wander anchors on the bot, not on a stale home height', () => {
    // Same bug, other half: home kept the Y it was set at, so a bot that had since
    // descended was still offered targets measured from up there.
    const world = MockWorld.arena({ floorY: 70, radius: 40 });
    const bot = new MockBot(world, { manualTicks: true });
    bot._spawn();
    for (const t of bot._timers) { clearInterval(t); clearTimeout(t); }
    bot._timers = [];
    const actor = new Actor(bot, {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: { mode: 'wander', survive: { enabled: false }, movements: {} }
    });
    actor.onSpawn();
    actor.home = { x: 0, y: 90, z: 0 };                            // stale home height
    bot.entity.position.set(0.5, world.surfaceY(0, 0) + 1, 0.5);  // bot really at ~71
    const ys = [];
    for (let i = 0; i < 80; i++) { const t = actor._randomReachable(30); if (t) ys.push(t.y); }
    assert.ok(ys.length > 0, 'the picker must still find targets');
    assert.ok(ys.every(y => Math.abs(y - bot.entity.position.y) <= 2),
      `targets must follow the BOT's height, not home's (ys=${[...new Set(ys)]}, botY=${bot.entity.position.y})`);
    actor.destroy();
  });
}

module.exports = { register };
