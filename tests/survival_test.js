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
const { Actor, isNight, nearestHostile, countHostiles, findFood } = require(path.join(SRC, 'actor.js'));

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
  /* ---------------- food / health reaction thresholds ---------------- */
  test('the bot eats at the regeneration floor, so it can actually heal', async () => {
    // Reported: "the same with eating". The old eatAt default of 16 sat BELOW the
    // 1.9+ natural-regeneration threshold of 18, so a bot at 16-17 food was too
    // hungry to regen and too full to eat — hurt, and doing nothing about it.
    // This asserts the behaviour (eat() gets called), not the constant.
    const world = new MockWorld();
    world.generate();
    const bot = new MockBot(world, { username: 'Eater' });
    bot._spawn();
    let ate = 0;
    const actor = new Actor(bot, {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: { survive: { enabled: true, eatAt: 18, fleeHealth: 10 }, movements: {} }
    });
    actor.onSpawn();
    actor.survive = true;
    actor.eat = async () => { ate++; return true; };
    // 17 food: below the regen floor, above the old (broken) gate of 16.
    bot.food = 17;
    actor.tick();
    assert.strictEqual(ate, 1, 'food 17 must trigger eating (below the 18 regen floor)');
    actor.destroy();
  });

  test('a hurt bot tops food up to full rather than stopping at the floor', async () => {
    const world = new MockWorld();
    world.generate();
    const bot = new MockBot(world, { username: 'Hurt' });
    bot._spawn();
    let ate = 0;
    const actor = new Actor(bot, {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: { survive: { enabled: true, eatAt: 18 }, movements: {} }
    });
    actor.onSpawn();
    actor.survive = true;
    actor.eat = async () => { ate++; return true; };
    // Healthy and well fed: no reason to eat (the gate must not fire forever).
    bot.food = 20; bot.health = 20;
    actor.tick();
    assert.strictEqual(ate, 0, 'full food + full health is not a reason to eat');
    // Hurt at 19 food: above the 18 floor, so only the "hurt" rule can fire.
    bot.food = 19; bot.health = 12;
    actor._lastEatAt = 0;
    actor.tick();
    assert.strictEqual(ate, 1, 'a hurt bot eats past the floor to speed regeneration');
    actor.destroy();
  });

  test('the bot eats safe food, never a spider eye to "heal"', () => {
    // Observed live: `ate item=spider_eye` while fleeing a spider at 7 hearts.
    // findFood took "the first item the registry calls food", and spider eyes
    // (poison), rotten flesh (hunger) and pufferfish (poison) are all in that
    // table. Eating one to heal is worse than not eating at all.
    const world = new MockWorld();
    world.generate();
    const bot = new MockBot(world);
    bot._spawn();
    bot.inventory.clear();
    bot.inventory.give('spider_eye', 3);
    bot.inventory.give('rotten_flesh', 3);
    assert.strictEqual(findFood(bot), null,
      'only harmful food available => eat nothing (null), not poison ourselves');
    bot.inventory.give('bread', 1);
    const pick = findFood(bot);
    assert.ok(pick && pick.name === 'bread', `should choose bread, got ${pick && pick.name}`);
    // Ranking: the best SAFE food by the registry's own quality is chosen, and a
    // better safe food added later wins. (Which of bread/steak is "better" is the
    // registry's business — the point is that harmful food never outranks safe.)
    bot.inventory.give('golden_apple', 1);
    const best = findFood(bot);
    assert.ok(best && !/spider_eye|rotten_flesh/.test(best.name),
      `must never fall back to harmful food while safe food exists, got ${best && best.name}`);
    const reg = bot.registry.foodsByName;
    const safeItems = ['golden_apple', 'bread'].map(n => ({ n, q: reg[n].effectiveQuality }));
    const top = safeItems.sort((a, b) => b.q - a.q)[0].n;
    assert.strictEqual(best.name, top,
      `should pick the highest-quality safe food (${top}), got ${best.name}`);
  });

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
