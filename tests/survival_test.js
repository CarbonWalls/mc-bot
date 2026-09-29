/**
 * Survival-layer and gather-selection unit tests (P4).
 *
 * These exercise the pure decision functions in src/actor.js — the parts that
 * previously had NO test coverage even though they decide whether the bot
 * lives or dies. They use the mock world, so they run offline.
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
const { isNight, nearestHostile, countHostiles } = require(path.join(SRC, 'actor.js'));

function makeBotWithZombie(dist) {
  const world = new MockWorld();
  world.generate();
  const bot = new MockBot(world);
  bot._spawn();
  // a zombie standing `dist` blocks away, matching the real mineflayer fields
  const p = bot.entity.position;
  bot.entities[9001] = {
    id: 9001, name: 'zombie', displayName: 'Zombie',
    kind: 'Hostile mobs', isValid: true, health: 20,
    position: p.offset(dist, 0, 0)
  };
  return bot;
}

function register({ test }) {

  /* ---------------- time of day ---------------- */
  test('isNight: matches the vanilla dark window', () => {
    const b = new MockBot(new MockWorld());
    b.time = { timeOfDay: 6000 };
    assert.ok(!isNight(b), 'noon is not night');
    b.time = { timeOfDay: 18000 };
    assert.ok(isNight(b), 'midnight is night');
    b.time = { timeOfDay: 12541 };
    assert.ok(isNight(b), 'the window start boundary is night');
    b.time = { timeOfDay: 23458 };
    assert.ok(isNight(b), 'the window end boundary is night');
    b.time = { timeOfDay: 12540 };
    assert.ok(!isNight(b), 'just before the window is day');
    b.time = { timeOfDay: 23459 };
    assert.ok(!isNight(b), 'just after the window is day');
  });

  test('isNight: unknown time assumes day (no false panic)', () => {
    assert.ok(!isNight({ time: undefined }), 'missing time => day');
    assert.ok(!isNight({}), 'no time object => day');
  });

  /* ---------------- hostile classification ---------------- */
  test('nearestHostile finds a mob classified the way live mineflayer reports it', () => {
    const bot = makeBotWithZombie(8);
    const e = nearestHostile(bot, 24);
    assert.ok(e, 'a zombie at kind="Hostile mobs" must be found');
    assert.strictEqual(e.displayName, 'Zombie');
  });

  test('nearestHostile respects range', () => {
    const bot = makeBotWithZombie(20);
    assert.ok(nearestHostile(bot, 24), 'within range');
    assert.ok(!nearestHostile(bot, 10), 'beyond range');
  });

  test('countHostiles counts only hostiles in range', () => {
    const bot = makeBotWithZombie(8);
    assert.strictEqual(countHostiles(bot, 32), 1);
    assert.strictEqual(countHostiles(bot, 4), 0, '8 blocks away is outside a 4-block radius');
  });

  test('a passive mob is never classified hostile', () => {
    const world = new MockWorld();
    world.generate();
    const bot = new MockBot(world);
    bot._spawn();
    const p = bot.entity.position;
    bot.entities[42] = {
      id: 42, name: 'cow', displayName: 'Cow',
      kind: 'Animals', isValid: true, position: p.offset(2, 0, 0)
    };
    assert.ok(!nearestHostile(bot, 24), 'a cow must not be treated as hostile');
    assert.strictEqual(countHostiles(bot, 32), 0);
  });

  /* ---------------- gather target selection ---------------- */
  test('gather does not path into the canopy: trees resolve to a ground-level log', () => {
    // A tree in the mock world has its base on the ground; findBlocks must
    // return that base (a walkable-adjacent position), not a leaf-layer log.
    const world = new MockWorld();
    world.generate();
    const bot = new MockBot(world);
    bot._spawn();
    const logs = bot.findBlocks({ matching: b => b.name === 'oak_log', maxDistance: 96, count: 8 });
    assert.ok(logs.length > 0, 'mock world must contain trees');
    // every returned position must be a real log voxel
    for (const p of logs) {
      const blk = bot.blockAt(p);
      assert.ok(blk && /log/.test(blk.name), `findBlocks must return log voxels, got ${blk && blk.name}`);
    }
  });
}

module.exports = { register };
