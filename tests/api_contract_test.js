/**
 * Mock/real API drift detection.
 *
 * Every live bug in this project's history came from src/mock.js inventing an
 * API the real mineflayer-pathfinder does not have (isPathing, a public .goal,
 * findBlocks returning block objects, `kind === 'hostile'`). Those bugs are
 * invisible to any test written against the mock — the mock passes, the live
 * server breaks. This file exists to make that failure mode noisy.
 *
 * It does two things:
 *   1. asserts the mock's surface matches src/api_contract.json, a file
 *      generated mechanically from the installed packages (tools/record_api.js);
 *   2. asserts the contract file itself is up to date, so an upgrade that
 *      changes the real API can't slip through unrecorded.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function register({ test }) {
  const contractPath = path.join(SRC, 'api_contract.json');

  /* ---------------- contract file is current ---------------- */
  test('api_contract.json exists and is machine-regenerated', () => {
    assert.ok(fs.existsSync(contractPath), 'src/api_contract.json is missing — run: node tools/record_api.js > src/api_contract.json');
    const raw = fs.readFileSync(contractPath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'api_contract.json is not valid JSON');
  });

  test('api_contract.json matches the installed packages (no silent drift)', () => {
    // Regenerate in-memory and compare the substance. If the real plugin
    // changed, this is exactly the signal a hand-written contract would miss.
    const recorded = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    assert.ok(live && live.pathfinder, 'record_api.js must export the contract');

    const sort = a => [...a].sort().join(',');
    assert.strictEqual(sort(live.pathfinder.methods), sort(recorded.pathfinder.methods),
      'mineflayer-pathfinder methods changed — regenerate the contract');
    assert.strictEqual(sort(live.pathfinder.emitsOnBot), sort(recorded.pathfinder.emitsOnBot),
      'mineflayer-pathfinder events changed — regenerate the contract');
    assert.strictEqual(sort(live.bot.has), sort(recorded.bot.has),
      'mineflayer bot surface changed — regenerate the contract');
  });

  /* ---------------- the forbidden surface ---------------- */
  test('the real plugin exposes NO isPathing() and NO public .goal', () => {
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    for (const bad of live.pathfinder.forbidden) {
      assert.ok(!live.pathfinder.methods.includes(bad),
        `mineflayer-pathfinder now exposes ${bad}() — the compat shim in src/actor.js should be re-evaluated`);
    }
  });

  /* ---------------- the mock honors the contract ---------------- */
  const { MockBot, MockWorld } = require(path.join(SRC, 'mock.js'));

  test('mock exposes every pathfinder method the real plugin has', () => {
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    const b = new MockBot();
    assert.ok(b.pathfinder, 'mock has no bot.pathfinder');
    for (const m of live.pathfinder.methods) {
      assert.strictEqual(typeof b.pathfinder[m], 'function',
        `mock.pathfinder.${m} is missing — the mock is behind the real API`);
    }
  });

  test('mock exposes every pathfinder FIELD the real plugin has', () => {
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    const b = new MockBot();
    for (const f of live.pathfinder.fields) {
      assert.ok(f in b.pathfinder, `mock.pathfinder.${f} is missing — the mock is behind the real API`);
    }
  });

  test('mock does NOT expose surface the real plugin lacks (the drift that caused live bugs)', () => {
    const b = new MockBot();
    assert.ok(!('isPathing' in b.pathfinder) && typeof b.pathfinder.isPathing !== 'function',
      'mock exposes isPathing(), which the real plugin does NOT have — this is exactly what broke the watchdog live');
    assert.ok(!('goal' in b.pathfinder),
      'mock exposes a public pathfinder.goal, which the real plugin does NOT have');
  });

  test('mock findBlocks returns Vec3 positions, never block objects', () => {
    const { MockWorld } = require(path.join(SRC, 'mock.js'));
    const world = new MockWorld();
    world.generate();
    const b = new MockBot(world);
    b._spawn();   // place the bot and build the entity table
    const found = b.findBlocks({ matching: blk => blk.name === 'oak_log', maxDistance: 64, count: 4 });
    assert.ok(found.length > 0, 'mock found no oak_log — world generation regressed');
    for (const p of found) {
      assert.ok(p && typeof p.distanceTo === 'function' && Number.isFinite(p.x),
        'findBlocks must return Vec3 positions, not {name, position} block objects');
    }
  });

  test('mock emits pathfinder events on the bot, not on bot.pathfinder', () => {
    const b = new MockBot();
    let onBot = 0, onPf = 0;
    b.on('goal_updated', () => onBot++);
    b.on('goal_reached', () => onBot++);
    b.pathfinder.on('goal_updated', () => onPf++);
    b.pathfinder.setGoal({ x: 0, y: 0, z: 0 });
    assert.strictEqual(onBot, 1, 'goal_updated must fire on the bot object (real plugin behaviour)');
    assert.strictEqual(onPf, 0, 'goal_updated must NOT fire on bot.pathfinder (the real plugin does not emit there)');
  });

  test('mock entity classification matches live mineflayer (kind is a phrase)', () => {
    const b = new MockBot();
    let hostile = null;
    for (const id in b.entities) {
      const e = b.entities[id];
      if (e && e.kind && /hostile/i.test(String(e.kind))) { hostile = e; break; }
    }
    assert.ok(hostile, 'mock has no hostile entity to classify');
    // the exact shapes the survival layer depends on
    assert.ok(!/^(hostile|passive|neutral)$/.test(String(hostile.kind)),
      `mock kind "${hostile.kind}" is a bare word — real mineflayer uses a phrase like "Hostile mobs"`);
    assert.ok(typeof hostile.displayName === 'string' && hostile.displayName.length > 0,
      'mock must set displayName (the non-deprecated field); mobType is deprecated');
  });

  test('no live code reads the deprecated entity.mobType', () => {
    // mineflayer prints a deprecation stack trace every time mobType is read,
    // which pollutes the live log. Keep it out of src (comments are fine).
    const fs = require('fs');
    for (const f of ['src/core.js', 'src/actor.js', 'src/tui.js', 'src/mock.js']) {
      const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const lines = body.split('\n').map(l => l.trim());
      const bad = lines.filter(l => /\.mobType\b/.test(l) && !l.startsWith('//') && !l.startsWith('*'));
      assert.deepStrictEqual(bad, [],
        `${f} reads e.mobType (deprecated; use displayName): ${JSON.stringify(bad)}`);
    }
  });
}

module.exports = { register };
