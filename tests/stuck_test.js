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
}

module.exports = { register };
