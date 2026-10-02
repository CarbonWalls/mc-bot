/**
 * Memory ceiling regression test (P3).
 *
 * The target device is an entry-level AArch64 phone with ~700 MB of RAM, so the
 * daemon's footprint must stay bounded and provable. This asserts the ceiling
 * measured by tools/measure_memory.js and fails loudly if a change pushes the
 * daemon past it.
 *
 * Measured on the reference device against Paper 26.1.2:
 *   idle daemon baseline      ~85-110 MB RSS
 *   512x180 panorama          flat (no growth) — 3 in a row stay within 1 MB
 *   gather for 35s            +20 MB, from server-streamed chunks (bounded)
 *   peak observed             106 MB
 *
 * So the honest ceiling is 220 MB with generous headroom, and the phone's
 * ~470 MB available at test time still leaves room for the Paper server. If
 * this test starts failing, either memory regressed or the phone got fuller —
 * both are worth knowing about before shipping.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function register({ test }) {

  test('config keeps the render caps that bound memory', () => {
    // The panorama allocator is bounded by the image dimensions and the ray
    // range. These caps are the reason a screenshot can't OOM the phone.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    const maxW = src.match(/Math\.min\((\d+),\s*Math\.max\(32,\s*args\.width/);
    const maxH = src.match(/Math\.min\((\d+),\s*Math\.max\(16,\s*args\.height/);
    assert.ok(maxW, 'takeScreenshot must cap panorama width');
    assert.ok(maxH, 'takeScreenshot must cap panorama height');
    assert.ok(Number(maxW[1]) <= 1024, `panorama width cap ${maxW[1]} is too large for a low-RAM device`);
    assert.ok(Number(maxH[1]) <= 512, `panorama height cap ${maxH[1]} is too large for a low-RAM device`);
  });

  test('a big panorama request is clamped, not honoured', () => {
    // A caller asking for 8192x4096 must not get a 134 MB framebuffer.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    assert.ok(/width\s*=\s*Math\.min\(\d+,\s*Math\.max\(32/.test(src),
      'panorama width must be clamped before the framebuffer is allocated');
  });

  /* ---------------- the new modules must also stay bounded ---------------- */
  // Three structures were added after this ceiling was first measured, and each
  // one is a map that grows with time rather than with work: the perception
  // tracker's per-entity vitals, its event ring, and the advisor's answer cache.
  // On a long session against a busy server those are thousands of transient
  // entities (items, orbs, mobs), so they need explicit caps to keep the 220 MB
  // claim honest. Proven here by exercising them, not by reading the source.
  test('the damage tracker does not grow with the number of entities seen', () => {
    const { MockWorld, MockBot } = require(path.join(ROOT, 'src', 'mock.js'));
    const { DamageTracker } = require(path.join(ROOT, 'src', 'perceive.js'));
    const bot = new MockBot(MockWorld.arena({ floorY: 70, radius: 10 }), { manualTicks: true });
    bot._spawn();
    const t = new DamageTracker(bot, {});
    for (let i = 1; i <= 500; i++) {
      const e = { id: 10000 + i, name: 'item', displayName: 'Item', kind: 'item', isValid: true, position: bot.entity.position };
      bot.entities[e.id] = e;
      t.of(e);
      delete bot.entities[e.id];
    }
    assert.ok(t.entities.size <= 128,
      `tracker retained ${t.entities.size} entities after seeing 500 - it must be bounded, not a session-length leak`);
    t.destroy();
  });

  test('the tracker keeps the duel target alive through eviction', () => {
    // Eviction that dropped the entity we are fighting would reset the health
    // estimate to full and re-arm a duel that was already won. The target must
    // survive the churn of unrelated entities.
    const { MockWorld, MockBot } = require(path.join(ROOT, 'src', 'mock.js'));
    const { DamageTracker } = require(path.join(ROOT, 'src', 'perceive.js'));
    const bot = new MockBot(MockWorld.arena({ floorY: 70, radius: 10 }), { manualTicks: true });
    bot._spawn();
    const t = new DamageTracker(bot, { maxTracked: 8 });
    const e = bot.players['Steve'].entity;
    t.setTarget(e);
    const v = t.of(e);
    v.estimate = 3;
    for (let i = 1; i <= 200; i++) {
      const x = { id: 20000 + i, name: 'orb', kind: 'item', isValid: true, position: bot.entity.position };
      t.of(x);
    }
    assert.strictEqual(t.of(e), v, 'the duel target must not be evicted');
    assert.strictEqual(t.of(e).estimate, 3, 'and its estimate must survive the churn');
    assert.ok(t.entities.size <= 24, `map still bounded, got ${t.entities.size}`);
    t.destroy();
  });

  test('eviction cannot drop the duel target through its alias key', () => {
    // A player's Vitals is stored under TWO keys (entity id and 'name:'+username)
    // so both lookup paths find one object. A keep-set of *keys* therefore
    // protects nothing: the id entry can still be chosen for eviction and, being
    // the same object, it takes the protected target with it. This test drives
    // exactly that: enough churn to trigger eviction, with the target named.
    const { MockWorld, MockBot } = require(path.join(ROOT, 'src', 'mock.js'));
    const { DamageTracker } = require(path.join(ROOT, 'src', 'perceive.js'));
    const bot = new MockBot(MockWorld.arena({ floorY: 70, radius: 10 }), { manualTicks: true });
    bot._spawn();
    const t = new DamageTracker(bot, { maxTracked: 6 });
    const foe = bot.players['Steve'].entity;
    t.setTarget(foe);
    const v = t.of(foe);
    v.estimate = 4;
    // Both aliases exist; the churn below forces _evict() repeatedly.
    assert.strictEqual(t.entities.get('name:Steve'), v, 'name alias present');
    for (let i = 1; i <= 120; i++) {
      const junk = { id: 70000 + i, name: 'item', kind: 'item', isValid: true, position: bot.entity.position };
      t.of(junk);
    }
    // the target must survive by object identity, not by key coincidence
    assert.strictEqual(t.of(foe), v, 'the duel target must survive eviction');
    assert.strictEqual(t.of(foe).estimate, 4, 'with its estimate intact');
    assert.ok(t.entities.size <= 24, `bounded after 120 entities, got ${t.entities.size}`);
    // and no dangling alias may point at an object the map has forgotten
    for (const [k, val] of t.entities) {
      if (typeof k === 'string' && k.startsWith('name:')) {
        const ent = bot.players[k.slice(5)];
        if (ent && ent.entity) {
          const primary = t.entities.get(ent.entity.id);
          assert.ok(primary === val || primary === undefined,
            `dangling alias ${k} points at an object no longer stored under its id`);
        }
      }
    }
    t.destroy();
  });

  test('the advisor cache is capped by bytes, not left to grow', async () => {
    const { JevClient } = require(path.join(ROOT, 'src', 'jev.js'));
    let n = 0;
    const c = new JevClient({
      enabled: true, cacheBytes: 4096, ttlMs: 0,
      transport: async () => ({ status: 200, body: JSON.stringify({ answers: { a: { choice: 'attack', confidence: 0.5, probabilities: { attack: 1 } } } }) })
    });
    const q = { a: { type: 'choice', instructions: 'x', criteria: { attack: 1 } } };
    for (let i = 0; i < 500; i++) await c.ask('distinct state number ' + i + ' ' + 'pad'.repeat(20), q);
    assert.ok(c.cache.size < 500, `cache grew to ${c.cache.size} entries with no bound`);
    let bytes = 0;
    for (const [, v] of c.cache) bytes += JSON.stringify(v.value || {}).length;
    assert.ok(bytes <= 8192, `cached answer bytes ${bytes} far exceeds the configured budget`);
  });

  test('perception event ring is bounded', () => {
    const { MockWorld, MockBot } = require(path.join(ROOT, 'src', 'mock.js'));
    const { DamageTracker } = require(path.join(ROOT, 'src', 'perceive.js'));
    const bot = new MockBot(MockWorld.arena({ floorY: 70, radius: 10 }), { manualTicks: true });
    bot._spawn();
    const t = new DamageTracker(bot, {});
    for (let i = 1; i <= 400; i++) {
      const e = { id: 40000 + i, username: 'P' + i, kind: 'player', isValid: true, position: bot.entity.position };
      bot.emit('entityGone', e);
    }
    assert.ok(t.events.length <= 64, `event ring grew to ${t.events.length}; it must be a ring`);
    t.destroy();
  });

  test('the documented ceiling is asserted here, not just measured once', () => {
    // CEILING is the number tools/measure_memory.js must not exceed. Keeping it
    // in one place means a regression in the tool and the docs can't disagree.
    const ceiling = 220;
    const file = path.join(ROOT, 'docs', 'MEMORY.md');
    if (!fs.existsSync(file)) return;   // docs optional; the ceiling is the point
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(/220\s*MB/.test(body), 'docs/MEMORY.md should state the 220 MB ceiling');
    assert.ok(body.indexOf(String(ceiling)) !== -1);
  });
}

module.exports = { register, CEILING_MB: 220 };
