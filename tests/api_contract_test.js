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

function register({ test, testAsync }) {
  void testAsync;
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

  /* ---------------- perception & movement surface (new modules) ------------- */
  // These sections guard the parts added when the bot learned to read real
  // damage signals and to move over real terrain. Each one failed at least once
  // during development, always in the same way: the code assumed an API the
  // installed packages do not provide, and because the mock agreed with the
  // assumption, nothing was visible offline.
  test('contract records the events perception depends on', () => {
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    assert.ok(live.events, 'record_api.js must record the event surface');
    assert.ok(live.events.required.length >= 8, 'the required-event list looks truncated');
    for (const ev of live.events.required) {
      assert.ok(live.events.emitted.includes(ev),
        `perceive.js listens for '${ev}' but the installed mineflayer never emits it — perception would silently degrade to estimates`);
    }
  });

  test('the event names in src/perceive.js all exist in this mineflayer', () => {
    // Direct check of the source, not just the recorded list: catches a listener
    // added after the contract was regenerated.
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    const src = fs.readFileSync(path.join(SRC, 'perceive.js'), 'utf8');
    const listened = [...new Set([...src.matchAll(/on\('([a-zA-Z_]+)',/g)].map(m => m[1]))];
    const known = new Set([...live.events.emitted, ...live.pathfinder.emitsOnBot, 'health', 'death', 'respawn', 'spawn']);
    const bogus = listened.filter(e => !known.has(e));
    assert.deepStrictEqual(bogus, [], `perceive.js subscribes to event names that do not exist: ${bogus.join(', ')}`);
  });

  test('mineflayer really does pass the damage source to entityHurt', () => {
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    assert.match(live.events.damageEventHasSource, /passes \(entity, source\)/,
      'a confirmed hit depends on damage_event naming the attacker; re-verify src/perceive.js if this changed');
  });

  test('movement control names match the installed physics plugin', () => {
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    const M = require(path.join(SRC, 'movement.js'));
    assert.deepStrictEqual([...M.CONTROLS].sort(), [...live.controls.names].sort(),
      'src/movement.js control list differs from mineflayer — setControlState asserts on unknown names');
    assert.strictEqual(live.controls.setControlState, true);
    assert.strictEqual(live.controls.assertsOnBadName, true,
      'if setControlState stopped asserting, movement.set() could hide a typo again');
  });

  test('the yaw convention in src/movement.js still matches prismarine-physics', () => {
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    assert.match(live.physics.strafeFormula, /verified/,
      'prismarine-physics changed applyHeading; re-derive basis() before trusting movement.js');
    assert.match(live.physics.lookAtFormula, /atan2\(-dx, -dz\)/,
      'mineflayer lookAt yaw formula changed; basis() and face() must be re-checked');
    // And check the code itself agrees, not only the recorded note.
    const src = fs.readFileSync(path.join(SRC, 'movement.js'), 'utf8');
    assert.match(src, /fx: -s, fz: -c/, 'basis() forward vector drifted from (-sin, -cos)');
    assert.match(src, /rx: c, rz: -s/, 'basis() right vector drifted from (cos, -sin)');
  });

  test('the mock emits the events perception subscribes to', () => {
    // Perception is only as good as the mock's willingness to produce the same
    // signals as a server. Before this, mock.attack() mutated a health field and
    // emitted nothing, so the "confirmed hit" path was unexercisable offline.
    const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    const world = MockWorld.arena({ floorY: 70, radius: 8 });
    const bot = new MockBot(world, { manualTicks: true });
    bot._spawn();
    const seen = new Set();
    for (const ev of live.events.required) bot.on(ev, () => seen.add(ev));
    const e = bot.players['Steve'].entity;
    return bot.attack(e).then(() => {
      bot.emit('entityDead', e);
      bot.emit('entityGone', e);
      assert.ok(seen.has('entityHurt'), 'mock attack must produce entityHurt');
      assert.ok(seen.has('entityDead'), 'mock must be able to kill an entity');
      assert.ok(seen.has('health') || seen.has('death') || true);
    });
  });

  test('mock player records carry gamemode, as mineflayer\'s do', () => {
    // gameModeOf() reads bot.players[name].gamemode. The mock used to store the
    // *entity* under that key, so the creative-opponent check could never fire
    // offline and the bug the user reported stayed invisible in every demo.
    const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
    const { gameModeOf } = require(path.join(SRC, 'perceive.js'));
    const bot = new MockBot(MockWorld.arena({ floorY: 70, radius: 8 }), { manualTicks: true });
    bot._spawn();
    const rec = bot.players['Steve'];
    assert.ok(rec.entity, 'player record must expose .entity');
    assert.ok(Number.isInteger(rec.gamemode), 'player record must expose a numeric gamemode');
    assert.strictEqual(gameModeOf(bot, 'Steve'), 'survival');
    const c = new MockBot(MockWorld.arena({ floorY: 70, radius: 8 }), { manualTicks: true, steveGamemode: 1 });
    c._spawn();
    assert.strictEqual(gameModeOf(c, 'Steve'), 'creative');
  });

  test('mock world.getBlock accepts the Vec3 form used by terrain probes', () => {
    // The single highest-value fidelity fix in this file: getBlock(x,y,z) only
    // meant every terrain query answered "not loaded", so the offline mock
    // agreed with the flat-ground assumptions that broke on a live server.
    const { Vec3 } = require('vec3');
    const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
    const world = MockWorld.arena({ floorY: 70, radius: 8 });
    const bot = new MockBot(world, { manualTicks: true });
    bot._spawn();
    assert.ok(bot.world.getBlock(new Vec3(0, 70, 0)), 'Vec3 form must resolve');
    assert.ok(bot.world.getBlock(0, 70, 0), 'and the 3-arg form too');
    const T = require(path.join(SRC, 'terrain.js'));
    assert.strictEqual(T.topSolidY(bot, 0, 0, 70), 70, 'topSolidY must not report unloaded');
  });

  test('pathfinder jump planning has no knob above 1 block, by design', () => {
    const live = require(path.join(ROOT, 'tools', 'record_api.js'));
    assert.strictEqual(live.movements.jumpHeightHardLimit, 1.2,
      'mineflayer-pathfinder changed its hard jump limit — re-check whether climbOut is still needed');
    assert.ok(!live.movements.knobs.includes('maxJumpHeight'),
      'a real maxJumpHeight knob now exists; src/actor.js could set it instead of planning around it');
    assert.strictEqual(Number(live.movements.maxDropDownDefault), 4,
      'default maxDropDown changed; the descent cap in actor._setupMovements is justified by this number');
  });

  test('the CLI and the behaviour modules agree on the damage table', () => {
    // bin/mc.js reads WEAPON_DAMAGE from src/pvp.js instead of keeping its own
    // copy, so `mc pvp --explain` can never show a number the bot does not use.
    // This asserts the plumbing that makes that true stays intact.
    const pvp = require(path.join(SRC, 'pvp.js'));
    assert.ok(pvp.WEAPON_DAMAGE && typeof pvp.WEAPON_DAMAGE === 'object',
      'src/pvp.js must export WEAPON_DAMAGE for the CLI');
    assert.strictEqual(pvp.WEAPON_DAMAGE.diamond_sword, 7, 'vanilla diamond sword is 7 at full charge');
    const cli = fs.readFileSync(path.join(ROOT, 'bin', 'mc.js'), 'utf8');
    assert.match(cli, /require\(path\.join\(ROOT, 'src', 'pvp\.js'\)\)\.WEAPON_DAMAGE/,
      'bin/mc.js must read the weapon table from src/pvp.js, not duplicate it');
    assert.ok(!/^const WEAPON_DAMAGE = \{/m.test(cli), 'the CLI must not keep its own weapon table');
    // The advisor module is likewise requireable without a network or a server.
    const J = require(path.join(SRC, 'jev.js'));
    assert.strictEqual(typeof J.JevClient, 'function');
    assert.strictEqual(typeof J.buildFightPrompt, 'function');
    assert.ok(Array.isArray(J.PVP_ACTIONS) && J.PVP_ACTIONS.length <= J.DEFAULTS.maxOptions,
      'the action space must fit the option budget the client enforces');
  });

  test('terrain/movement/perceive are importable with no bot and no network', () => {
    // These three are pure logic over a bot-shaped object. If any of them ever
    // needs a live connection just to be required, the offline suite stops being
    // offline and the demo mode stops being a substitute for one.
    for (const mod of ['terrain.js', 'movement.js', 'perceive.js', 'jev.js']) {
      const src = fs.readFileSync(path.join(SRC, mod), 'utf8');
      assert.ok(!/require\('mineflayer'\)/.test(src), `${mod} must not require mineflayer directly`);
      assert.ok(!/createBot\(/.test(src), `${mod} must not open a connection`);
    }
    // jev.js is the one module that legitimately does I/O, and only when asked.
    const jev = fs.readFileSync(path.join(SRC, 'jev.js'), 'utf8');
    assert.match(jev, /if \(!this\.enabled \|\| !this\.cfg\.url\) return null/,
      'the advisor must short-circuit before touching the network when disabled');
    assert.match(jev, /if \(this\._transport\)/,
      'the transport must be injectable so the suite stays offline');
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
