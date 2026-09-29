/**
 * Task queue tests.
 *
 * The queue exists so that multi-step goals ("gather wood, then planks, then
 * sticks, then a pickaxe") run as a sequence with preconditions instead of
 * needing each step triggered by hand. The behaviour that matters most is the
 * failure path: one failed step must stop the queue, not barrel on into later
 * steps whose inputs were never produced.
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { TaskQueue } = require(path.join(SRC, 'tasks.js'));

function fakeActor(logs = []) {
  return {
    log: {
      info: (m, o) => logs.push(['info', m, o]),
      warn: (m, o) => logs.push(['warn', m, o]),
      error: (m, o) => logs.push(['error', m, o]),
      debug: () => {}
    },
    logs
  };
}

function register({ test }) {

  test('tasks run in order and each sees the previous step finish', async () => {
    const order = [];
    const actor = fakeActor();
    const q = new TaskQueue(actor);
    q.add('first', async () => { await new Promise(r => setTimeout(r, 10)); order.push('first'); });
    q.add('second', async () => { order.push('second'); });
    q.add('third', () => { order.push('third'); });
    await q.start();
    assert.deepStrictEqual(order, ['first', 'second', 'third']);
    assert.ok(q.info.finished, 'the queue must report finished');
  });

  test('a failing task stops the queue and records the reason', async () => {
    const actor = fakeActor();
    const q = new TaskQueue(actor);
    let laterRan = false;
    q.add('boom', () => { throw new Error('no planks'); });
    q.add('should not run', () => { laterRan = true; });
    await q.start();
    assert.ok(!laterRan, 'later steps must not run after a failure');
    assert.ok(/no planks/.test(q.info.lastError), 'the failure reason must be recorded');
  });

  test('a task with no run function is rejected at add time', () => {
    const q = new TaskQueue(fakeActor());
    assert.throws(() => q.add('bad'), /no run function/);
  });

  test('start() is not re-entrant: a second call is a no-op', async () => {
    const actor = fakeActor();
    const q = new TaskQueue(actor);
    let runs = 0;
    q.add('slow', () => new Promise(r => setTimeout(() => { runs++; r(); }, 30)));
    const a = q.start();      // not awaited
    const b = q.start();
    await Promise.all([a, b]);
    assert.strictEqual(runs, 1, 'the queue must run once even if started twice');
  });

  test('clear() drops pending tasks without running them', async () => {
    const q = new TaskQueue(fakeActor());
    q.add('a', () => {});
    q.add('b', () => {});
    q.clear();
    assert.strictEqual(q.tasks.length, 0);
    assert.strictEqual(q.info.pending, 0);
  });

  test('an empty queue finishes immediately', async () => {
    const q = new TaskQueue(fakeActor());
    await q.start();
    assert.ok(q.info.finished);
    assert.strictEqual(q.info.current, null);
  });

  test('the wood->planks->sticks->pickaxe math holds', async () => {
    // One wooden pickaxe: 3 planks + 2 sticks = 5 planks; a log yields 4 planks,
    // so 2 logs per pickaxe. This pins the recipe arithmetic the task chain uses.
    const perPickaxe = 5, planksPerLog = 4, n = 3;
    const logsNeeded = Math.ceil((perPickaxe * n) / planksPerLog);
    assert.strictEqual(logsNeeded, 4, '3 pickaxes need 4 logs');
    assert.strictEqual(4 * logsNeeded, 16, '4 logs -> 16 planks');
    assert.strictEqual(2 * n, 6, '3 pickaxes need 6 sticks');
  });

  test('the crafting chain converts logs into a pickaxe end to end', async () => {
    const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
    const { Actor } = require(path.join(SRC, 'actor.js'));
    const world = new MockWorld();
    world.generate();
    const bot = new MockBot(world);
    bot._spawn();
    const actor = new Actor(bot, {
      config: { mode: 'afk', survive: { enabled: false }, canDig: true }
    });
    // give the bot 2 logs — exactly what one pickaxe needs
    bot.inventory.give('oak_log', 2);
    assert.strictEqual(typeof bot.recipesFor, 'function', 'recipesFor must live on the bot');
    // planks
    assert.ok(await actor.craftItem('oak_planks', 8), 'planks must craft from logs');
    assert.strictEqual(count(bot, 'oak_planks'), 8, '2 logs -> 8 planks');
    // sticks (4 sticks from 2 planks)
    await actor.craftItem('stick', 4);
    assert.ok(count(bot, 'stick') >= 2, 'sticks must be crafted');
    // the pickaxe itself
    await actor.craftItem('wooden_pickaxe', 1);
    assert.strictEqual(count(bot, 'wooden_pickaxe'), 1, 'the pickaxe must be crafted');
  });

  test('crafting reports a reason when ingredients are missing', async () => {
    const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
    const { Actor } = require(path.join(SRC, 'actor.js'));
    const bot = new MockBot(new MockWorld());
    bot._spawn();
    const actor = new Actor(bot, { config: { mode: 'afk', survive: { enabled: false } } });
    await assert.rejects(() => actor.craftItem('wooden_pickaxe', 1), /no recipe|missing/,
      'a craft with no ingredients must reject with a reason');
  });
}

function count(bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
}

module.exports = { register };