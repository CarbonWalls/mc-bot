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

  test('repeated stalls give up and return the bot to AFK, not a hang', () => {
    const { actor, bot } = makeActor({ stuckTimeoutMs: 50, maxStuckAttempts: 2 });
    actor.setMode('goto');
    actor.goalDesc = { type: 'near', x: 500, y: 70, z: 500, range: 3 };   // unreachable
    bot.pathfinder._goal = actor.goalDesc;
    bot.pathfinder._moving = true;
    // Re-arm the "stale" timestamps each tick: unstick() does not advance the
    // clock, so without this every tick after the first looks current.
    for (let i = 0; i < 3 && actor.mode !== 'afk'; i++) {
      actor.goalStartedAt = Date.now() - 30000;
      actor.lastMoveAt = Date.now() - 30000;
      actor.lastPos = bot.entity.position.clone();
      actor.tick();
    }
    assert.strictEqual(actor.mode, 'afk',
      'after maxStuckAttempts the bot must give up and go AFK rather than spin');
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
