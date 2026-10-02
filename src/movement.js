'use strict';

/**
 * Low-level movement: the part that makes the bot work on real ground.
 *
 * THE BUG THIS FIXES
 * ------------------
 * "It only works on flat ground and it doesn't jump at all (except when
 * fleeing)." The literal reading is correct: outside `fleeLoop`'s 25% random
 * jump and `unstick`'s 500 ms burst, nothing in the codebase ever set the
 * `jump` control. But the deeper cause is a design one — movement was expressed
 * entirely as *destinations* handed to the pathfinder, and those destinations
 * were computed with flat-ground arithmetic (`topSolidY`, `pos*2 - threat`). So:
 *
 *   - PvP and fight modes drive raw control states rather than the pathfinder,
 *     so there the bot literally could not jump and halted at any step;
 *   - when the pathfinder *was* used, a target on the far side of a drop it was
 *     not allowed to take produced `path_stop` ("no route"), the goal resolved
 *     to AFK, and the bot froze where it stood;
 *   - after a fall of even one block, the next target was computed from the new,
 *     lower position with the same blind arithmetic and became unreachable for
 *     the same reason — so the bot stayed stuck in the pit.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Makes control-state calls *terrain-aware*, and decides the vertical problem
 * before the bot commits to the horizontal move. A step up and a step down are
 * different problems with different solutions:
 *
 *   step up 1 block    forward + jump HELD. Jump alone against a block does
 *                      nothing; forward alone does nothing either. Together, on
 *                      the same tick as the collision, they clear it. This is
 *                      the whole fix for "won't jump".
 *   step up 2 blocks   jump-sneak block-hop, else route around, else refuse.
 *   step down <= 1     walk.
 *   step down <= maxDrop  walk, but only when `allowFall` — a deliberate choice.
 *   step down > maxDrop   refuse and detour. Never discover a cliff by falling.
 *
 * Conventions worth pinning down, because getting them wrong is invisible until
 * someone walks into a wall:
 *   - mineflayer's yaw is radians, wrapped to [-pi, pi], and *decreases* when
 *     turning right (the vanilla convention). Verified against
 *     prismarine-physics/index.js `applyHeading`, which is the authority:
 *       world forward of facing = (-sin yaw, -cos yaw)
 *       world right of facing = ( cos yaw, -sin yaw)
 *     and `bot.lookAt` uses yaw = atan2(-dx, -dz), so the two are consistent.
 *     The right-of-facing vector is easy to get sign-flipped, which produces a
 *     bot that strafes into a wall instead of around it and never says so.
 *   - `bot.controlState` is a live view of the local physics control states, so
 *     reading it costs nothing and never disagrees with the packet log.
 *   - `setControlState(name, bool)` asserts on an invalid name and no-ops when
 *     the value is unchanged, so calling it every tick is cheap and correct.
 */

const T = require('./terrain');

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

function set(bot, control, on) {
  if (!bot || typeof bot.setControlState !== 'function') return;
  try { bot.setControlState(control, !!on); } catch (_) { /* unsupported on this build */ }
}

function get(bot, control) {
  try {
    if (bot.controlState && bot.controlState[control] != null) return !!bot.controlState[control];
    if (typeof bot.getControlState === 'function') return !!bot.getControlState(control);
  } catch (_) {}
  return false;
}

function clearAll(bot) { for (const c of CONTROLS) set(bot, c, false); }

/** True when the bot is standing on something (not mid-fall, not swimming). */
function onGround(bot) {
  const e = bot && bot.entity;
  if (!e) return false;
  if (e.onGround != null) return !!e.onGround;
  const v = e.velocity;
  if (v && Math.abs(v.y) < 0.02 && Math.hypot(v.x, v.z) < 0.02) return true;
  const under = T.safeBlockAt(bot, Math.floor(e.position.x), Math.floor(e.position.y) - 1, Math.floor(e.position.z));
  return T.isSolidBlock(under);
}

function inWater(bot) {
  const e = bot && bot.entity;
  if (!e) return false;
  if (e.isInWater) return true;
  const here = T.safeBlockAt(bot, Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z));
  return !!(here && (here.name === 'water' || here.name === 'lava'));
}

/** World-space forward/right unit vectors for the bot's current yaw. */
function basis(bot, yaw) {
  const y = yaw != null ? yaw : (bot && bot.entity ? bot.entity.yaw || 0 : 0);
  const s = Math.sin(y), c = Math.cos(y);
  return { fx: -s, fz: -c, rx: c, rz: -s };
}

/** Yaw that faces a world heading — same formula mineflayer's lookAt uses. */
function headingToYaw(hx, hz) { return Math.atan2(-hx, -hz); }
/** Unit heading for a yaw — the inverse of headingToYaw. */
function yawToHeading(yaw) { return { x: -Math.sin(yaw), z: -Math.cos(yaw) }; }

/**
 * What is in front along the bot's current facing. Kept for callers that
 * genuinely mean "in front of me" (unstick digging, look-based checks).
 */
function aheadInfo(bot, opts = {}) {
  const e = bot && bot.entity;
  if (!e) return null;
  const b = basis(bot);
  const steps = opts.steps != null ? opts.steps : 1;
  const px = Math.floor(e.position.x + b.fx * steps);
  const pz = Math.floor(e.position.z + b.fz * steps);
  const cell = probeCell(bot, px, pz);
  if (!cell) return null;
  return Object.assign({ dx: b.fx, dz: b.fz, px, pz, loaded: true }, cell);
}

/**
 * The ground relationship of one column, relative to where the bot stands now.
 * Returns null when the column is not loaded, which callers must treat as
 * "unknown", never as "safe".
 */
function probeCell(bot, x, z) {
  const e = bot.entity;
  const here = T.topSolidY(bot, Math.floor(e.position.x), Math.floor(e.position.z), e.position.y);
  const there = T.topSolidY(bot, x, z, e.position.y);
  if (there == null) return null;
  const feetY = Math.floor(e.position.y);
  const feetBlock = T.safeBlockAt(bot, x, feetY, z);
  const headBlock = T.safeBlockAt(bot, x, feetY + 1, z);
  const surfaceBlock = T.safeBlockAt(bot, x, there, z);
  // Compare SURFACES, not the target surface against our feet. The feet sit one
  // above the surface, so measuring from them makes every flat cell read as
  // "1 block down" and a genuine one-block step read as "flat" — which is
  // exactly how a bot ends up walking into a wall it never classified as a step.
  const ownSurface = here == null ? feetY - 1 : here;
  return {
    x, z,
    surfaceY: there,
    ownSurface,
    rise: there - ownSurface,                       // +1 => a step to climb
    drop: ownSurface - there,                       // + => how far the floor falls away
    wallAtFeet: T.isSolidBlock(feetBlock),
    blocked: T.isSolidBlock(feetBlock) || T.isSolidBlock(headBlock),
    headBlockedAtSurface: T.isSolidBlock(T.safeBlockAt(bot, x, there + 2, z)),
    surfaceName: surfaceBlock ? surfaceBlock.name : 'air'
  };
}

/** The cell one step (0.85 blocks) along a world heading. */
function probeAlong(bot, hx, hz, distance = 0.85) {
  const e = bot.entity;
  const x = Math.floor(e.position.x + hx * distance);
  const z = Math.floor(e.position.z + hz * distance);
  const cell = probeCell(bot, x, z);
  if (!cell) return null;
  /* Cliff-edge detection, the part that has to look *past* the cell.
   *
   * A cell is safe to enter and still fatal to stand on: at the rim, the floor
   * under you is solid, the next floor along your heading is not. Probing only
   * the cell you are entering (or even two) lets a bot creep to the rim, accept
   * every step as "flat", and then fall the moment it overshoots by a hair —
   * which is what the ledge test caught. And once it has fallen, its own column
   * is the pit floor, so every subsequent probe compares pit-to-pit and reports
   * flat ground while it is still in the air. Prevention has to happen at the rim.
   *
   * So: look one cell further along the heading. If THAT one falls away, this
   * cell is a ledge edge and walking into it means agreeing to a drop we have
   * not budgeted for. */
  const beyondCol = probeCellAt(bot, x + Math.round(hx), z + Math.round(hz), cell.surfaceY);
  // Note the `.surfaceY`: subtracting the probe object from a number yields NaN,
  // `NaN > 1` is false, and the ledge check silently never fires — which is
  // precisely the "walks off a cliff" bug this code exists to prevent, and it
  // would have looked exactly like the terrain module not working.
  const beyond = beyondCol ? beyondCol.surfaceY : null;
  cell.atEdge = beyond != null && (cell.surfaceY - beyond) > 1;
  cell.beyondDrop = beyond == null ? 0 : Math.max(0, cell.surfaceY - beyond);
  return cell;
}

/** probeCell for an explicit column, comparing against a given own surface. */
function probeCellAt(bot, x, z, ownSurface) {
  const there = T.topSolidY(bot, x, z, ownSurface);
  return there == null ? null : { x, z, surfaceY: there };
}

/**
 * Decide what to do about the ground in front, before touching the controls.
 * Returns { action: 'walk'|'jump'|'hop'|'refuse', reason }
 */
function classifyGround(cell, opts) {
  if (!cell) return { action: 'walk', reason: 'unknown-terrain' };   // trust the caller's plan
  const maxDrop = opts.maxDrop != null ? opts.maxDrop : 1;
  const allowFall = opts.allowFall !== false;
  if (cell.rise >= 2) {
    if (opts.hop && cell.rise <= 2 && !cell.headBlockedAtSurface) return { action: 'hop', reason: 'two-block step' };
    return { action: 'refuse', reason: 'wall' };
  }
  if (cell.rise === 1) {
    if (cell.headBlockedAtSurface) return { action: 'refuse', reason: 'no headroom above step' };
    return { action: 'jump', reason: 'one-block step' };
  }
  if (cell.wallAtFeet) return { action: 'refuse', reason: 'block at feet' };
  if (cell.atEdge && !(opts.allowEdge || (opts.allowFall && cell.beyondDrop <= (opts.maxDrop != null ? opts.maxDrop : 1)))) {
    // The cell is standable but the next one is the void. Standing on the rim is
    // how a bot ends up falling; treat it as a wall unless the caller really
    // intends to descend here.
    return { action: 'refuse', reason: `ledge edge (${cell.beyondDrop} beyond)` };
  }
  if (cell.drop > maxDrop) {
    if (!allowFall) return { action: 'refuse', reason: `drop ${cell.drop} > budget ${maxDrop}` };
    if (cell.drop > 3) return { action: 'refuse', reason: `drop ${cell.drop} would hurt` };
    return { action: 'walk', reason: `controlled fall of ${cell.drop}` };
  }
  return { action: 'walk', reason: 'flat' };
}

/** Combine two ground verdicts, keeping the more cautious one. */
function worseOf(a, b) {
  const rank = { walk: 0, jump: 1, hop: 2, refuse: 3 };
  return (rank[b.action] > rank[a.action]) ? b : a;
}

/**
 * Move along a desired world heading, handling what the ground does.
 *
 * @param {object} bot
 * @param {{x,z}|null} to      world cell to move toward (or pass opts.heading)
 * @param {object} opts {
 *   heading: {x,z}      use this heading instead of computing one from `to`
 *   strafe: -1|1        bias the heading 90 degrees sideways (orbiting)
 *   allowFall: bool     may step down more than 1 block? (default true)
 *   maxDrop: number     largest drop considered safe (default 1)
 *   hop: bool           attempt a jump-sneak block-hop onto a 2-block step
 *   sprint: bool        sprint when the ground ahead is flat and clear
 *   sneak: bool         hold sneak (ledge-walking / combat guard)
 *   jumpAlways: bool    unconditionally hold jump (swimming, panic hops)
 *   detour: bool        route around obstructions (default true)
 * }
 * @returns {string} what it decided ('walk', 'jump-walk', 'hop', 'detour-right',
 *                   'blocked', 'idle', 'noop') — for logs and tests
 */
function walkToward(bot, to, opts = {}) {
  const e = bot && bot.entity;
  if (!e || (!to && !opts.heading)) return 'noop';
  const water = inWater(bot);

  // 1) desired world-space heading
  let hx, hz;
  if (opts.heading) {
    const l = Math.hypot(opts.heading.x, opts.heading.z) || 1;
    hx = opts.heading.x / l; hz = opts.heading.z / l;
  } else {
    hx = to.x - e.position.x; hz = to.z - e.position.z;
    const l = Math.hypot(hx, hz);
    if (l < 0.001) { stop(bot); return 'idle'; }
    hx /= l; hz /= l;
  }
  const strafe = opts.strafe || 0;
  if (strafe) {
    // Rotate the wanted heading toward the strafe side and blend, so a duelist
    // closing while sidestepping moves on a diagonal instead of stopping at the
    // wall it is walking into. strafe=+1 is "step right", and the right of a
    // heading (hx,hz) in this convention is (-hz, hx).
    //
    // Temporaries matter here: assigning hx before computing hz from it is an
    // aliasing bug that turns a side-step into a spiral, and it is invisible
    // until someone watches the bot walk.
    const ox = hx, oz = hz;
    hx = ox * 0.45 + (-oz) * strafe;
    hz = oz * 0.45 - (-ox) * strafe;
    const l2 = Math.hypot(hx, hz) || 1; hx /= l2; hz /= l2;
  }

  // 2) read the ground we are about to enter, along the *heading* — not along
  // the facing, because in a duel the bot faces its opponent while moving
  // sideways. Probe two cells: at a diagonal heading the near cell can be
  // perfectly safe while the next one is the ledge, and the one that matters is
  // the one the bot is actually about to leave its feet from.
  const cell = probeAlong(bot, hx, hz);
  const beyond = probeAlong(bot, hx, hz, 1.7);
  const g = water
    ? { action: 'walk', reason: 'swimming' }
    : worseOf(classifyGround(cell, opts), classifyGround(beyond, opts));

  // 3) an obstruction is routed around, never answered with a stop. A bot that
  // stops at a wall has only relocated its stuck state.
  if (g.action === 'refuse' && opts.detour !== false) {
    const alt = findDetour(bot, hx, hz, opts);
    if (alt) {
      const kind = drive(bot, alt.hx, alt.hz, alt.ground, opts, water);
      return `detour-${alt.label}:${kind}`;
    }
    // nowhere to go: hold position, keep facing, do not grind against the wall
    if (!opts.keepPressure) stop(bot);
    return 'blocked';
  }

  const res = drive(bot, hx, hz, g, opts, water);
  if (res === 'gated') {
    // Every key along the current facing would move us into refused terrain.
    // Turn toward something safe rather than stand still on the rim.
    const alt = findDetour(bot, hx, hz, opts);
    if (alt) {
      const r2 = drive(bot, alt.hx, alt.hz, alt.ground, opts, water);
      return `detour-${alt.label}:${r2}`;
    }
    if (!opts.keepPressure) stop(bot);
    return 'blocked';
  }
  return res;
}

/**
 * Should this movement key actually be pressed, given the terrain along the
 * axis the key moves you?
 *
 * The subtlety that makes this necessary: a heading is a *request*, and the
 * client obeys *keys*. Decomposed against the yaw, forward+right is a 45-degree
 * diagonal — so on the rim of a cliff, probing along the wanted heading can say
 * "safe" while the key that ends up pressed drives the bot one cell further in a
 * slightly different direction, across the edge. That mismatch is why ledge
 * refusal looked solid until a run happened to align with it. Gating every key
 * along its own axis removes the gap: what is refused is what would actually
 * move us, not what we intended.
 */
function keyIsSafe(bot, ax, az, opts) {
  const near = classifyGround(probeAlong(bot, ax, az, 0.6), opts);
  const far = classifyGround(probeAlong(bot, ax, az, 1.15), opts);
  return worseOf(near, far).action !== 'refuse';
}

/**
 * Apply controls for a world heading, decomposed against the bot's yaw so it can
 * strafe without turning, then gate each key against the terrain it moves into.
 */
function drive(bot, hx, hz, ground, opts, water) {
  const e = bot.entity;
  const b = basis(bot);
  const wantF = hx * b.fx + hz * b.fz;
  const wantR = hx * b.rx + hz * b.rz;
  const gate = opts.gate !== false && !water;

  const jumping = ground.action === 'jump' || ground.action === 'hop' || !!opts.jumpAlways || !!water;
  const hopping = ground.action === 'hop';

  // Forward unless the heading is mostly sideways or backwards; then use the
  // lateral/back controls, which need no turn and so no lost time.
  // Decompose against the current yaw so the bot never has to turn to move: a
  // turn costs a second of not being able to hit anything. `control.right -
  // control.left` is the strafe term in prismarine-physics, so wantR > 0 means
  // press right. Forward+strafe together is a diagonal, which is how a duelist
  // keeps full speed while holding aim.
  const goingBack = wantF < -0.05;
  let goF = !goingBack && wantF > 0.05;
  let goB = goingBack;
  let goL = wantR < -0.15, goR = wantR > 0.15;
  if (gate) {
    if (goF && !keyIsSafe(bot, b.fx, b.fz, opts)) goF = false;
    if (goB && !keyIsSafe(bot, -b.fx, -b.fz, opts)) goB = false;
    if (goR && !keyIsSafe(bot, b.rx, b.rz, opts)) goR = false;
    if (goL && !keyIsSafe(bot, -b.rx, -b.rz, opts)) goL = false;
  }
  set(bot, 'forward', goF || goR || goL ? goF : false);
  set(bot, 'back', goB);
  set(bot, 'left', goL);
  set(bot, 'right', goR);
  if (gate && !goF && !goB && !goL && !goR) return 'gated';

  set(bot, 'jump', jumping && (goF || goB || goL || goR || !!opts.jumpAlways));
  if (hopping) {
    // Jump-sneak block-hop: sneaking the instant you leave the ground lets you
    // climb onto the block you are facing. Requires low speed => no sprint.
    set(bot, 'sneak', true);
    set(bot, 'forward', goF || !gate);
    set(bot, 'sprint', false);
  } else {
    set(bot, 'sneak', !!opts.sneak);
    const sprint = !!opts.sprint && !water && !jumping && !opts.sneak &&
      ground.action === 'walk' && onGround(bot);
    set(bot, 'sprint', sprint);
  }
  if (water) set(bot, 'sprint', false);
  return hopping ? 'hop' : jumping ? 'jump-walk' : 'walk';
}

/**
 * Search for a passable heading near a refused one: +-40, +-80, +-120 degrees,
 * preferring the side the caller was already biased toward, and only reversing
 * as a last resort (a bot that backs off at every obstacle never arrives).
 */
function findDetour(bot, hx, hz, opts) {
  const base = headingToYaw(hx, hz);
  let cands = [0.7, -0.7, 1.4, -1.4, 2.1, -2.1];
  if (opts.strafe) cands = cands.slice().sort((a, b) => Math.abs(a - opts.strafe) - Math.abs(b - opts.strafe));
  for (const off of cands) {
    const a = base + off;
    const h = yawToHeading(a);
    const cell = probeAlong(bot, h.x, h.z);
    const g = classifyGround(cell, opts);
    if (g.action === 'refuse') continue;
    // yaw increases to the left in this convention
    return { hx: h.x, hz: h.z, ground: g, label: off > 0 ? 'left' : 'right' };
  }
  // nothing but a wall: the only sane move is backwards along the heading we came
  const cell = probeAlong(bot, -hx, -hz);
  const g = classifyGround(cell, opts);
  if (g.action !== 'refuse') return { hx: -hx, hz: -hz, ground: g, label: 'back' };
  return null;
}

/**
 * Circle a point at a held distance, staying on safe ground. This is what
 * replaces "run straight away from the threat" — on real terrain the straight
 * line ends in a cliff, and the old code discovered that by falling off it.
 */
function orbit(bot, center, radius, dir = 1, opts = {}) {
  const e = bot && bot.entity;
  if (!e || !center) return 'noop';
  const dx = e.position.x - center.x, dz = e.position.z - center.z;
  const dist = Math.hypot(dx, dz) || 0.001;
  const want = opts.want != null ? opts.want : radius;
  // Tangent along the ring, plus a radial term that pulls the radius back to
  // `want` so the bot holds spacing instead of spiralling in or drifting out.
  // The tangent of (dx,dz) pointing "clockwise when viewed from above" is
  // (dz,-dx); dir flips which way it goes.
  const tx = (dz / dist) * dir, tz = (-dx / dist) * dir;
  const radial = (want - dist) / Math.max(1, want);
  return walkToward(bot, null, Object.assign({
    heading: { x: tx + (dx / dist) * radial * 1.6, z: tz + (dz / dist) * radial * 1.6 },
    allowFall: false,
    maxDrop: opts.maxDrop != null ? opts.maxDrop : 1,
    hop: opts.hop !== false
  }, opts));
}

/** Face a point without touching movement. Never lets a rejected look bubble up. */
async function face(bot, pos, opts = {}) {
  if (!bot || !pos) return;
  const e = bot.entity;
  if (!e) return;
  try {
    const head = opts.headOffset != null ? opts.headOffset : 1.1;
    if (opts.exact && typeof bot.lookAt === 'function') { await maybe(bot.lookAt(pos.offset(0, head, 0))); return; }
    const dx = pos.x - e.position.x;
    const dz = pos.z - e.position.z;
    const dy = (pos.y + head) - (e.position.y + (e.eyeHeight || 1.62));
    const yaw = normalizeYaw(Math.atan2(-dx, -dz) + (opts.yawError || 0));
    const pitch = clampPitch(Math.atan2(dy, Math.hypot(dx, dz)) + (opts.pitchError || 0));
    await maybe(bot.look(yaw, pitch));
  } catch (_) { /* a missed look is not worth a stack trace */ }
}

function maybe(p) { return (p && typeof p.then === 'function') ? p.catch(() => {}) : Promise.resolve(); }

function normalizeYaw(y) {
  let v = y % (Math.PI * 2);
  if (v > Math.PI) v -= Math.PI * 2;
  if (v < -Math.PI) v += Math.PI * 2;
  return v;
}
function clampPitch(p) { return Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, p)); }

/** Stop, releasing every control. Always safe to call. */
function stop(bot) { clearAll(bot); }

/**
 * One real jump, in the direction the bot faces: forward + jump held together.
 * The old `unstick()` pulsed jump for 500 ms without forward, which against a
 * one-block step moves a bot exactly zero blocks — the single biggest reason the
 * watchdog "recovered" four times and then gave up.
 */
function hop(bot, dir = 1) {
  const e = bot && bot.entity;
  if (!e) return;
  set(bot, 'forward', dir > 0);
  set(bot, 'back', dir < 0);
  set(bot, 'jump', true);
  const t = setTimeout(() => { clearAll(bot); }, 500);
  if (t.unref) t.unref();
}

/**
 * Escape a pit: choose the least-bad direction to climb out, preferring a
 * one-block step (jumpable) over a two-block wall over a dead end. Returns
 * { dx, dz, rise, score } or null when the bot is genuinely boxed in.
 */
function bestExitDirection(bot, opts = {}) {
  const e = bot && bot.entity;
  if (!e) return null;
  const x = Math.floor(e.position.x), z = Math.floor(e.position.z), y = Math.floor(e.position.y);
  // Compare SURFACES. The feet sit one above the block they stand on, so
  // `neighbourTop - feetY` reports a real one-block step as 0 ("level") and the
  // bot walks into the rim without ever deciding to jump it. This is the same
  // feet-vs-surface mistake as in probeCell, and it was caught by the climb test.
  const ownSurface = T.topSolidY(bot, x, z, y);
  const base = ownSurface == null ? y - 1 : ownSurface;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  let best = null;
  for (const [dx, dz] of dirs) {
    const nx = x + dx, nz = z + dz;
    const top = T.topSolidY(bot, nx, nz, y);
    if (top == null) continue;
    const rise = top - base;
    if (T.isSolidBlock(T.safeBlockAt(bot, nx, top + 2, nz))) continue;   // no headroom
    let score;
    if (rise <= 0) score = 3 + Math.min(3, -rise);          // level or downhill
    else if (rise === 1) score = 7;                          // jumpable step: the good exit
    else if (rise === 2 && opts.hop !== false) score = 4;     // block-hoppable
    else continue;
    // prefer a direction that keeps going, so we do not hop into a second pocket
    const beyond = T.topSolidY(bot, nx + dx, nz + dz, y);
    if (beyond != null && Math.abs(beyond - top) <= 1) score += 1.5;
    if (!best || score > best.score) best = { dx, dz, rise, score };
  }

  /* A hole wider than one cell has no climbable neighbour: standing in the
   * middle of a 3x3 pit, every adjacent column is level floor and the rim is two
   * steps away. Reporting "no exit" there is wrong — the way out is to walk to
   * the rim and THEN jump it, which is a two-phase move the one-cell scan cannot
   * see. So if nothing within one step rises, look two and three steps out and
   * aim at the highest ground in that direction, flagged with `rimDistance` so
   * climbOut knows it has to travel before it can climb. */
  if (!best || best.rise < 1) {
    let rim = null;
    for (const [dx, dz] of dirs) {
      for (const scale of [2, 3]) {
        const nx = x + dx * scale, nz = z + dz * scale;
        const top = T.topSolidY(bot, nx, nz, y);
        if (top == null) continue;
        const rise = top - base;
        // The rim must be CLIMBABLE. Reporting the tallest thing in range as an
        // "exit" is worse than reporting none: climbOut then walks the bot into a
        // cliff face it cannot scale and burns the recovery budget there. Only a
        // 1-block jump or a 2-block block-hop counts as an exit.
        if (rise < 1 || rise > 2) continue;
        if (T.isSolidBlock(T.safeBlockAt(bot, nx, top + 2, nz))) continue;
        // prefer the closest climbable rim, and a 1-block lip over a 2-block one
        const quality = (rise === 1 ? 2 : 1) - scale * 0.1;
        if (!rim || quality > rim.quality) {
          rim = { dx, dz, rise, score: quality, quality, rimDistance: scale };
        }
      }
    }
    if (rim) return rim;
  }
  return best;
}

/**
 * Climb out of a hole, using the local controls rather than the pathfinder.
 *
 * The pathfinder is the right tool for a long route and the wrong tool for "I
 * am one block down in a trench and my goal is above me": for that it needs a
 * reachable column, which is precisely what a pit does not offer, and it gives
 * up with path_stop. So this walks toward the best exit cell, and jumps while it
 * does — which is the combination the code never issued before.
 */
async function climbOut(bot, opts = {}) {
  const exit = bestExitDirection(bot, opts);
  if (!exit) return 'boxed-in';
  const e = bot.entity;
  const step = exit.rimDistance || 1;
  const target = { x: Math.floor(e.position.x) + exit.dx * step + 0.5, z: Math.floor(e.position.z) + exit.dz * step + 0.5 };
  await face(bot, { x: target.x, y: e.position.y, z: target.z }, { headOffset: 0 });
  const started = Date.now();
  const startPos = e.position.clone ? e.position.clone() : { x: e.position.x, y: e.position.y, z: e.position.z };
  void target;
  // Keep driving forward+jump for as long as it takes to gain height, capped so
  // a genuinely blocked exit cannot spin here forever.
  const hlen = Math.hypot(exit.dx, exit.dz) || 1;
  const needRise = Math.max(1, exit.rise);
  while (Date.now() - started < (opts.timeoutMs || 2500)) {
    // Re-read the ground every iteration rather than using the plan made at the
    // pit centre: the rim becomes a *step* once we are next to it, and that is
    // the moment the jump has to be held.
    const cell = probeCell(bot, Math.floor(e.position.x + (exit.dx / hlen) * 0.9), Math.floor(e.position.z + (exit.dz / hlen) * 0.9));
    const g = classifyGround(cell, { maxDrop: 1, allowFall: false, hop: opts.hop !== false });
    drive(bot, exit.dx / hlen, exit.dz / hlen, g.action === 'refuse' ? { action: 'walk' } : g,
      { hop: opts.hop !== false, gate: false }, inWater(bot));
    const risen = e.position.y - startPos.y;
    if (risen >= needRise - 0.05) { clearAll(bot); return 'climbed'; }
    await sleep(110);
  }
  clearAll(bot);
  return 'failed';
}

function sleep(ms) { return new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); }

module.exports = {
  CONTROLS,
  set,
  get,
  clearAll,
  onGround,
  inWater,
  basis,
  aheadInfo,
  probeCell,
  probeAlong,
  classifyGround,
  walkToward,
  drive,
  keyIsSafe,
  findDetour,
  orbit,
  face,
  stop,
  hop,
  bestExitDirection,
  climbOut,
  worseOf,
  probeCellAt,
  headingToYaw,
  yawToHeading,
  normalizeYaw,
  clampPitch
};
