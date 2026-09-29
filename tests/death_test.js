/**
 * Death recovery tests.
 *
 * On death, Minecraft drops the inventory where the bot fell and respawns it at
 * the world spawn. A bot that never walks back has permanently lost its gear —
 * which is how an active goal silently becomes a permanent setback. The actor
 * now records `deathPos` and, on the next spawn, walks back to pick the items
 * up before resuming whatever it was doing.
 *
 * These tests cover the decision logic without a real death: that a death is
 * recorded, that a fresh death triggers recovery, that a stale one (drops have
 * despawned) is skipped with a reason, and that the prior mode is resumed.
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

  test('a death records the position it happened at', () => {
    const { actor, bot } = makeActor();
    assert.ok(!actor.deathPos, 'no death recorded yet');
    bot.emit('death');
    assert.ok(actor.deathPos, 'death must record a position');
    assert.ok(Number.isInteger(actor.deathPos.x), 'death position must be a voxel');
    assert.strictEqual(actor.deaths, 1, 'the death counter must increment');
  });

  test('dying clears the live goal so a new one can start', () => {
    const { actor, bot } = makeActor();
    actor.goalDesc = { type: 'near', x: 10, y: 70, z: 10, range: 3 };
    bot.emit('death');
    assert.ok(!actor.goalDesc, 'a death must clear the goal');
  });

  test('a recent death triggers recovery on the next spawn', async () => {
    const { actor, bot } = makeActor();
    bot.emit('death');
    assert.ok(actor.deathPos, 'death recorded');
    let recovered = false;
    actor.recoverItems = async () => { recovered = true; };
    actor.onSpawn();
    // onSpawn is synchronous but recovery is launched without awaiting; give it a tick
    await new Promise(r => setTimeout(r, 50));
    assert.ok(recovered, 'a fresh death must trigger item recovery on spawn');
  });

  test('stale drops (past the despawn window) are skipped with a reason', async () => {
    const { actor } = makeActor();
    // Simulate a death old enough that the items are gone (Minecraft despawns
    // drops after 5 minutes). Recovery must not waste a trip.
    actor.deathPos = { x: 1, y: 70, z: 1, at: Date.now() - 400 * 1000 };
    const logs = [];
    actor.log = { ...actor.log, warn: (m, o) => logs.push([m, o]) };
    await actor.recoverItems();
    const skipped = logs.find(([m]) => /despawned/.test(m));
    assert.ok(skipped, 'an old death point must be skipped as despawned');
  });

  test('recovery resumes the mode that was interrupted', async () => {
    const { actor } = makeActor();
    actor.deathPos = { x: 1, y: 70, z: 1, at: Date.now() };
    actor.mode = 'gather';
    // _awaitGoal returns immediately when nothing is pathing, so this resolves fast
    await actor.recoverItems();
    assert.strictEqual(actor.mode, 'gather', 'the interrupted mode must be resumed');
  });

  test('recovery is attempted once, even if it fails', async () => {
    const { actor } = makeActor();
    actor.deathPos = { x: 1, y: 70, z: 1, at: Date.now() };
    await actor.recoverItems();
    assert.ok(!actor.deathPos, 'the death point must be consumed by recovery');
  });
}

module.exports = { register };
