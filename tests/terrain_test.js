/**
 * Terrain and movement tests: the "only works on flat ground / it never jumps"
 * regression suite.
 *
 * These are the tests that could not have existed before, for two reasons worth
 * stating plainly, because they are the reason the bug survived:
 *
 *   1. There was no terrain-aware movement code to test. `jump` was pulsed for
 *      500 ms with no `forward`, which in Minecraft moves a bot exactly zero
 *      blocks against a step.
 *   2. The offline mock could not express terrain at all. `MockWorld.getBlock()`
 *      rejected the `Vec3` call form that every terrain query uses, so
 *      `topSolidY` answered "column not loaded", the goal code bailed out, and
 *      the mock silently *agreed* with the flat-ground assumption. A test written
 *      against that mock would have passed while the live bot failed.
 *
 * `MockWorld.arena()` now builds terrain a test controls, and the mock's physics
 * consumes real control states, so a step here blocks the bot unless it jumps —
 * exactly like the server.
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
const T = require(path.join(SRC, 'terrain.js'));
const M = require(path.join(SRC, 'movement.js'));

const FLOOR = 70;

function arena(opts) {
  const world = MockWorld.arena(Object.assign({ floorY: FLOOR, radius: 20 }, opts || {}));
  const bot = new MockBot(world, { username: 'Tester', manualTicks: true });
  bot._spawn();
  return { world, bot };
}

/** Run n mock physics ticks with no timers involved. */
function tick(bot, n) { for (let i = 0; i < n; i++) bot._tick(); }

function register({ test, testAsync }) {

  /* ---------------- the mock itself must be trustworthy ---------------- */
  test('mock world answers Vec3-form blockAt, which every terrain query uses', () => {
    const { bot } = arena();
    const { Vec3 } = require('vec3');
    assert.ok(bot.blockAt(new Vec3(0, FLOOR, 0)), 'Vec3 form must return a block');
    assert.strictEqual(T.topSolidY(bot, 0, 0, FLOOR), FLOOR, 'topSolidY must resolve, not report unloaded');
    // and the world accessor path used by the loaded-column check
    assert.ok(bot.world.getBlock(new Vec3(0, 0, 0)) || bot.world.getBlock(0, 0, 0),
      'getBlock must accept at least one of the two call forms');
  });

  test('arena terrain is where the test says it is', () => {
    const { world } = arena({ stepAtZ: 8, cliffBeyondZ: 14, cliffDrop: 4 });
    assert.strictEqual(world.arenaHeight(0, 5), FLOOR, 'pre-step floor');
    assert.strictEqual(world.arenaHeight(0, 9), FLOOR + 1, 'one-block step');
    // z=15 is past BOTH features, so the modifiers stack: +1 step, -4 cliff.
    assert.strictEqual(world.arenaHeight(0, 15), FLOOR + 1 - 4, 'cliff and step modifiers compose');
  });

  /* ---------------- terrain reasoning ---------------- */
  test('topSolidY returns the surface block, so a stand goal is one above it', () => {
    const { bot } = arena();
    bot.entity.position.set(0.5, FLOOR + 1, 0.5);
    const y = T.topSolidY(bot, 0, 5, FLOOR);
    assert.strictEqual(y, FLOOR);
    // The bug this guards: antiIdleTarget handed back the surface y itself, i.e.
    // a position inside solid ground. pathfinder had no route, path_stop fired,
    // and the bot froze.
    const spot = new (require(path.join(SRC, 'actor.js')).Actor)(bot, { config: {} }).antiIdleTarget(3, 3);
    assert.ok(spot, 'a flat arena must offer an anti-idle step');
    assert.strictEqual(spot.y, FLOOR + 1, 'the goal must be the standing cell, not the block');
  });

  test('columnInfo reports a cliff instead of blithely returning the column', () => {
    const { bot } = arena({ cliffBeyondZ: 12, cliffDrop: 5 });
    bot.entity.position.set(0.5, FLOOR + 1, 10.5);
    const edge = T.columnInfo(bot, 0, 12, FLOOR);
    assert.ok(edge, 'loaded column');
    assert.ok(edge.dropBeyond >= 3, `expected a real drop beyond the edge, got ${edge.dropBeyond}`);
    const flat = T.columnInfo(bot, 0, 2, FLOOR);
    assert.ok(flat.dropBeyond < 3, 'middle of the arena is not an edge');
  });

  test('dropInDirection measures the hole before the bot falls into it', () => {
    const { bot } = arena({ pit: [4, 4, 3, 3] });
    bot.entity.position.set(3.5, FLOOR + 1, 5.5);
    assert.strictEqual(T.dropInDirection(bot, bot.entity.position, 1, 0, 4), 3, 'one step right is a 3-deep pit');
    assert.strictEqual(T.dropInDirection(bot, bot.entity.position, -1, 0, 4), 0, 'left is solid floor');
  });

  test('escapeSpot never aims an escape into a cliff', () => {
    const { bot } = arena({ cliffBeyondZ: 6, cliffDrop: 6 });
    bot.entity.position.set(0.5, FLOOR + 1, 4.5);
    const threat = { position: bot.entity.position.offset(-6, 0, 0) };
    for (let i = 0; i < 12; i++) {
      const spot = T.escapeSpot(bot, bot.entity.position, threat, { radius: 8, minGap: 4 });
      assert.ok(spot, 'a flat arena with an escape must yield one');
      const drop = T.dropInDirection(bot, bot.entity.position, Math.sign(spot.x), Math.sign(spot.z), 4);
      assert.ok(drop <= 3, `escape target ${spot.x},${spot.z} is off a ${drop}-block ledge`);
    }
  });

  test('escapeSpot prefers a reachable spot over the arithmetic "straight back"', () => {
    // Threat due west; straight back is due east, into the pit at x=4..6.
    const { bot } = arena({ pit: [4, 0, 3, 3] });
    bot.entity.position.set(2.5, FLOOR + 1, 1.5);
    const threat = { position: bot.entity.position.offset(-5, 0, 0) };
    const spot = T.escapeSpot(bot, bot.entity.position, threat, { radius: 10, minGap: 5 });
    assert.ok(spot, 'must find an escape');
    // the naive vector points straight into the hole; the scored one must not
    assert.ok(!(spot.x >= 4 && spot.x <= 6 && spot.z >= 0 && spot.z <= 2),
      `escape ${spot.x},${spot.z} lands in the pit the naive formula aimed at`);
  });

  test('the old flee formula corrupted the bot\'s own position vector', () => {
    // WHY this is a test and not just a deleted line. The original escape code was
    //   const away = bot.entity.position.scale(2).minus(threat.position);
    // and vec3's scale() MUTATES its receiver (verified against the installed
    // package: minus/plus/offset/clone return new vectors, scale/normalize do not).
    // So the expression did not compute a vector *from* the position, it rewrote
    // the position itself — to 2*(x,y,z), including y. Standing at (2.5, 71, 1.5)
    // the bot's recorded position became (5, 142, 3): inside the sky, far from any
    // floor. Every distance, every terrain query and every goal computed afterwards
    // used that corrupted vector, which is a much stronger explanation for "gets
    // stuck as soon as it falls by one or more blocks" than the flat-ground
    // arithmetic alone: after a single damage event while fleeing, the bot no
    // longer knew where it was.
    const { Vec3 } = require('vec3');
    const pos = new Vec3(2.5, FLOOR + 1, 1.5);
    const threat = new Vec3(-2.5, FLOOR + 1, 1.5);
    const before = pos.toString();
    const away = pos.scale(2).minus(threat);      // the old expression, verbatim
    assert.notStrictEqual(pos.toString(), before,
      'if vec3 ever stops mutating, delete this test - but note the API changed');
    assert.strictEqual(pos.y, (FLOOR + 1) * 2, 'the old formula doubled the bot\'s own Y');
    assert.ok(away.x !== pos.x, 'and the value it returned was not even the vector it stored');

    // The replacement must be pure. escapeSpot reads .x/.y/.z off the position and
    // never writes to it.
    const { MockWorld, MockBot } = require(path.join(SRC, 'mock.js'));
    const bot = new MockBot(MockWorld.arena({ floorY: FLOOR, radius: 20 }), { manualTicks: true });
    bot._spawn();
    bot.entity.position.set(2.5, FLOOR + 1, 1.5);
    const t = { position: new Vec3(-2.5, FLOOR + 1, 1.5) };
    const pristine = bot.entity.position.clone();
    for (let i = 0; i < 20; i++) T.escapeSpot(bot, bot.entity.position, t, { radius: 12, minGap: 5 });
    assert.ok(bot.entity.position.distanceTo(pristine) < 1e-9,
      `escapeSpot mutated the caller's position vector: ${bot.entity.position} != ${pristine}`);
  });

  /* ---------------- movement: the jump fix ---------------- */
  test('forward alone is stopped by a one-block step (the original bug, reproduced)', () => {
    const { bot } = arena({ stepAtZ: 6 });
    bot.entity.position.set(0.5, FLOOR + 1, 3.5);
    bot.entity.yaw = Math.atan2(0, -1);          // face +z
    bot.setControlState('forward', true);
    tick(bot, 40);
    assert.ok(bot.entity.position.z < 6, `walked through a wall that should stop it (z=${bot.entity.position.z})`);
    assert.ok(bot._blockedAt, 'the mock must report being blocked by the step');
    assert.strictEqual(bot.entity.position.y, FLOOR + 1, 'did not magically climb');
  });

  test('forward + jump clears a one-block step', () => {
    const { bot } = arena({ stepAtZ: 6 });
    bot.entity.position.set(0.5, FLOOR + 1, 3.5);
    bot.entity.yaw = Math.atan2(0, -1);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    tick(bot, 60);
    assert.ok(bot.entity.position.z > 6.5, `should be past the step, z=${bot.entity.position.z}`);
    assert.ok(bot.entity.position.y >= FLOOR + 2, `should be on the step, y=${bot.entity.position.y}`);
  });

  test('classifyGround: jump on a step, refuse a big drop, allow an agreed one', () => {
    // stepAtZ/cliffBeyondZ compose, so the bot must be stood on the feature it is
    // actually on: feet are one above that column's surface, not one above the
    // arena floor. Placing it at FLOOR+1 on top of the step buries it in solid
    // ground, and "block at feet" is then the *correct* answer.
    const { bot, world } = arena({ stepAtZ: 6, cliffBeyondZ: 12, cliffDrop: 2 });
    bot.entity.position.set(0.5, world.surfaceY(0, 5) + 1, 5.4);
    const step = M.probeAlong(bot, 0, 1);
    assert.strictEqual(M.classifyGround(step, { maxDrop: 1, allowFall: false }).action, 'jump', 'a step is a jump');

    bot.entity.position.set(0.5, world.surfaceY(0, 11) + 1, 11.4);    // one above the step's surface
    const cliff = M.probeAlong(bot, 0, 1);
    assert.strictEqual(M.classifyGround(cliff, { maxDrop: 1, allowFall: false }).action, 'refuse', 'an unagreed drop is refused');
    assert.strictEqual(M.classifyGround(cliff, { maxDrop: 3, allowFall: true }).action, 'walk', 'an agreed drop within budget is a walk');

    bot.entity.position.set(0.5, FLOOR + 1, 2);
    assert.strictEqual(M.classifyGround(M.probeAlong(bot, 0, 1), {}).action, 'walk', 'flat ground is just walking');
  });

  test('walkToward crosses a step without being told to jump', () => {
    const { bot } = arena({ stepAtZ: 6 });
    bot.entity.position.set(0.5, FLOOR + 1, 3.5);
    bot.entity.yaw = Math.atan2(0, -1);
    for (let i = 0; i < 60; i++) {
      M.walkToward(bot, { x: 0.5, z: 9 });
      tick(bot, 1);
    }
    assert.ok(bot.entity.position.y >= FLOOR + 2, `climbed the step (y=${bot.entity.position.y})`);
    assert.ok(bot.entity.position.z > 7, `moved past it (z=${bot.entity.position.z})`);
  });

  test('walkToward refuses to walk off a ledge and detours instead', () => {
    const { bot } = arena({ cliffBeyondZ: 8, cliffDrop: 6 });
    bot.entity.position.set(0.5, FLOOR + 1, 6.5);
    const start = bot.entity.position.clone();
    let decisions = [];
    for (let i = 0; i < 40; i++) {
      decisions.push(M.walkToward(bot, { x: 0.5, z: 12 }, { allowFall: false, maxDrop: 1 }));
      tick(bot, 1);
    }
    assert.ok(bot.entity.position.y > FLOOR - 1, `fell off the cliff (y=${bot.entity.position.y})`);
    assert.ok(!decisions.includes('walk') || decisions.some(d => /detour|blocked/.test(d)),
      'a cliff must produce a refusal or a detour, never a straight walk');
    assert.notStrictEqual(decisions[decisions.length - 1], 'noop');
    void start;
  });

  test('strafe goes the way the yaw convention says it should', () => {
    // Verified against prismarine-physics applyHeading: forward = (-sin y, -cos y),
    // right = (cos y, -sin y). At yaw=PI forward is +z, so "right" is -x.
    const { bot } = arena();
    bot.entity.position.set(0.5, FLOOR + 1, 3.5);
    bot.entity.yaw = Math.PI;
    bot.setControlState('right', true);
    tick(bot, 20);
    assert.ok(bot.entity.position.x < -0.5, `right at yaw=PI must be -x, got x=${bot.entity.position.x}`);

    // and the same through the heading API, which is what PvP uses
    bot.clearControlStates();
    bot.entity.position.set(0.5, FLOOR + 1, 3.5);
    for (let i = 0; i < 12; i++) { M.walkToward(bot, { x: 0.5, z: 4.5 }, { strafe: 1 }); tick(bot, 1); }
    assert.ok(bot.entity.position.x < 0.5, `strafe=+1 (right) drifted the wrong way: x=${bot.entity.position.x}`);
    assert.ok(bot.entity.position.z > 3.5, 'it should still be making some forward progress');
  });

  test('bestExitDirection finds the jumpable side of a pit', () => {
    const { bot } = arena({ pit: [-2, -2, 4, 2] });
    bot.entity.position.set(0.5, FLOOR - 2 + 1, 0.5);       // two blocks down in the pit
    const exit = M.bestExitDirection(bot, { hop: true });
    assert.ok(exit, 'a pit this shallow must have an exit');
    assert.ok(Math.abs(exit.rise) <= 2, `exit is climbable, rise=${exit.rise}`);
  });

  test('bestExitDirection aims at the rim of a wide hole', () => {
    const { bot } = arena({ pit: [-2, -2, 5, 2] });
    bot.entity.position.set(0.5, FLOOR - 2 + 1, 0.5);
    const exit = M.bestExitDirection(bot, { hop: true });
    assert.ok(exit, 'a 5x5 pit two blocks deep still has a way out');
    assert.ok(exit.rimDistance > 1, `the rim is more than one step away here, got ${exit.rimDistance}`);
    assert.ok(exit.rise >= 1, `the exit must actually rise, got ${exit.rise}`);
  });

  test('climbOut actually leaves a one-block hole', () => {
    // The controller only sets control states; something has to integrate
    // physics, or "climbed" can never happen and the test passes by accident.
    // With manualTicks we drive the mock's physics on the same clock the
    // controller sleeps on, which is what a real client does every tick.
    const world = MockWorld.arena({ floorY: FLOOR, radius: 20, pit: [-1, -1, 3, 1] });
    const bot = new MockBot(world, { username: 'Tester', manualTicks: true });
    bot._spawn();
    bot.entity.position.set(0.5, FLOOR - 1 + 1, 0.5);
    const y0 = bot.entity.position.y;
    const iv = setInterval(() => bot._tick(), 50);
    return M.climbOut(bot, { timeoutMs: 3000, hop: true }).then(res => {
      clearInterval(iv);
      assert.strictEqual(res, 'climbed', `climbOut returned ${res} at y=${bot.entity.position.y}`);
      assert.ok(bot.entity.position.y > y0, 'a climbed bot is higher than it started');
    });
  });

  test('an agreed controlled fall is still allowed inside the budget', () => {
    // Regression guard for the rim check being too strict: climbing out of a hole
    // is very often "walk over the lip", so a caller that allows a 2-block drop
    // must not be stopped by a 2-block edge.
    const { bot, world } = arena({ cliffBeyondZ: 8, cliffDrop: 2 });
    bot.entity.position.set(0.5, world.surfaceY(0, 7) + 1, 7.4);
    const edge = M.probeAlong(bot, 0, 1);
    assert.strictEqual(M.classifyGround(edge, { maxDrop: 1, allowFall: false }).action, 'refuse');
    assert.strictEqual(M.classifyGround(edge, { maxDrop: 2, allowFall: true }).action, 'walk');
  });

  test('climbOut escapes a pit WIDER than one cell', () => {
    // The case that makes hole-escape genuinely hard: in a 3x3 pit the bot stands
    // in the middle, every adjacent column is level floor, and the rim is two
    // steps away. A one-cell scan reports "no exit" and the bot sits there until
    // it starves — which is exactly the reported "stuck as soon as it falls".
    const world = MockWorld.arena({ floorY: FLOOR, radius: 20, pit: [-2, -2, 5, 2] });
    const bot = new MockBot(world, { username: 'Tester', manualTicks: true });
    bot._spawn();
    bot.entity.position.set(0.5, FLOOR - 2 + 1, 0.5);       // dead centre, two blocks down
    const y0 = bot.entity.position.y;
    const iv = setInterval(() => bot._tick(), 50);
    return M.climbOut(bot, { timeoutMs: 4000, hop: true }).then(res => {
      clearInterval(iv);
      assert.strictEqual(res, 'climbed', `expected a climb out of a 5x5 pit, got ${res} at y=${bot.entity.position.y}`);
      assert.ok(bot.entity.position.y > y0 + 1.5, `should be near the surface, y=${bot.entity.position.y}`);
    });
  });

  test('drive() decomposes a sideways heading into strafe, not into a turn', () => {
    const { bot } = arena();
    bot.entity.position.set(0.5, FLOOR + 1, 3.5);
    bot.entity.yaw = Math.PI;                       // facing +z
    // heading due +x: that is 90 degrees LEFT of facing, so it must be a strafe
    M.drive(bot, 1, 0, { action: 'walk' }, {}, false);
    assert.strictEqual(bot.getControlState('forward'), false, 'a pure side heading must not press forward');
    assert.ok(bot.getControlState('left') !== bot.getControlState('right'), 'exactly one strafe key held');
    assert.strictEqual(bot.getControlState('left'), true, '+x at yaw=PI is left');
  });

  test('hop() holds forward and jump together (a jump pulse alone does nothing)', () => {
    const { bot } = arena({ stepAtZ: 6 });
    bot.entity.position.set(0.5, FLOOR + 1, 4.5);
    bot.entity.yaw = Math.atan2(0, -1);
    M.hop(bot);
    assert.strictEqual(bot.getControlState('jump'), true);
    assert.strictEqual(bot.getControlState('forward'), true,
      'the old unstick pulsed jump without forward, which is the bug');
  });

  /* ---------------- unstick uses the new movement ---------------- */
  test('unstick recovers from a step by jumping, not by burning attempts', () => {
    const { Actor } = require(path.join(SRC, 'actor.js'));
    // This one needs the mock's own physics timer: the recovery sequence awaits
    // real sleeps, and with manualTicks nothing advances during them, so the bot
    // would "not move" for a reason that has nothing to do with the behaviour.
    const world = MockWorld.arena({ floorY: FLOOR, radius: 20, stepAtZ: 6 });
    const bot = new MockBot(world, { username: 'Tester' });
    bot._spawn();
    bot.entity.position.set(0.5, FLOOR + 1, 4.5);
    const logs = [];
    const actor = new Actor(bot, {
      logger: { info: (m, f) => logs.push([m, f]), warn: (m, f) => logs.push([m, f]), error() {}, debug() {} },
      config: { mode: 'afk', canDig: true, stuckTimeoutMs: 300, maxStuckAttempts: 4 }
    });
    actor.goalDesc = { type: 'near', x: 0, y: FLOOR + 2, z: 9, range: 2 };
    actor.goalStartedAt = 0;                       // no grace period: force the stall
    actor._recoverMark = bot.entity.position.clone();
    actor.lastMoveAt = 0;
    actor.unstick();
    return new Promise(res => setTimeout(res, 2500)).then(() => {
      void logs;
      assert.ok(bot.entity.position.y >= FLOOR + 2 || bot.entity.position.z > 5,
        `unstick should have moved the bot over the step (z=${bot.entity.position.z} y=${bot.entity.position.y})`);
      actor.destroy();
    });
  });
}

module.exports = { register };
