'use strict';

/**
 * Terrain reasoning. Shared by the actor (pathing, anti-stuck) and the PvP
 * controller (ringing a cliff instead of walking off it).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The bot used to treat the world as a flat plane. Every destination was
 * resolved with "the highest solid block in this column, near my current y",
 * and every escape vector was computed with x/z trigonometry that never looked
 * at what was under the target. On a real map the ground is not flat, and that
 * single blind spot produced two failures the user reported:
 *
 *   1. A one-block step was an impassable wall. Not because the bot cannot
 *      jump — mineflayer's local physics does jump when it is told to — but
 *      because nothing ever *told* it to. The only `jump` calls in the codebase
 *      were inside flee (a random 25% chance) and unstick (a fixed 500 ms
 *      burst, useless without holding forward). Standing against a block,
 *      toggling jump alone does exactly nothing: you need forward *and* jump
 *      at the same time, which is what the pathfinder does and what the
 *      controller now does deliberately.
 *   2. An escape vector aimed at a column that was 5 blocks lower than the bot
 *      produced a path the pathfinder refused to take (a drop beyond its
 *      budget), or one it took eagerly — into the void. The bot "got stuck as
 *      soon as it fell by one or more blocks" because after the fall the same
 *      blind math computed another unreachable target, four times, and then
 *      gave up and went AFK in the pit.
 *
 * Everything here is written against `bot.blockAt()` only, so it works against
 * a live mineflayer bot and against the offline mock alike.
 */

const { Vec3 } = require('vec3');

// Reusable scratch vector. mineflayer's world accessor demands a real Vec3
// (it calls pos.floored()); allocating one per probe would churn the GC badly
// inside the render loops and the gather loop.
const _scratch = new Vec3(0, 0, 0);
function probe(x, y, z) { _scratch.x = x; _scratch.y = y; _scratch.z = z; return _scratch; }

const HALF_BLOCKS = new Set([
  'snow', 'ice', 'carpet', 'farmland', 'dirt_path', 'grass_path', 'mud',
  'soul_sand', 'soul_soil', 'sculk', 'water', 'lava'
]);

function safeBlockAt(bot, x, y, z) {
  try { return bot.blockAt(probe(x, y, z)); } catch (_) { return null; }
}

/** True when `block` is something the bot's feet would be stopped by. */
function isSolidBlock(block) {
  if (!block || !block.name) return false;
  if (block.name === 'air') return false;
  const bb = block.boundingBox;
  if (bb === 'empty') return false;
  if (bb == null) return true;              // mock/partial blocks: assume solid
  return bb === 'block';
}

/** True when the bot can stand at this cell (air at feet, headroom above). */
function isStandable(bot, x, y, z) {
  const feet = safeBlockAt(bot, x, y, z);
  const head = safeBlockAt(bot, x, y + 1, z);
  if (isSolidBlock(feet) || isSolidBlock(head)) return false;
  const under = safeBlockAt(bot, x, y - 1, z);
  return isSolidBlock(under);
}

/**
 * Height of the walkable surface at column (x,z), searching around `refY`.
 * Returns null when the column is not loaded, so callers can distinguish
 * "the ground is here" from "I have no idea" instead of pathing into a void on
 * an assumption.
 */
function topSolidY(bot, x, z, refY, span = 24) {
  x = Math.floor(x); z = Math.floor(z);
  const world = bot.world;
  if (!world) return null;
  let loaded = true;
  try {
    if (world.getColumnAt) loaded = !!world.getColumnAt(probe(x, 0, z));
    else if (world.getBlock) loaded = world.getBlock(probe(x, 0, z)) != null;
    else if (bot.blockAt) loaded = bot.blockAt(probe(x, 0, z)) != null;
  } catch (_) { loaded = false; }
  if (!loaded) return null;
  const base = Math.floor(refY == null ? 64 : refY);
  for (let y = Math.min(320, base + span); y >= Math.max(-64, base - span); y--) {
    let b = null;
    try { b = bot.blockAt(probe(x, y, z)); } catch (_) { return null; }
    if (isSolidBlock(b)) return y;
  }
  return base;
}

/**
 * A safe place to stand while digging the block at `pos`: the nearest adjacent
 * column whose top is solid and has head room. Prefers a surface close to the
 * block's own height, so climbing is never part of the plan unless it has to be.
 */
function standableSpotNear(bot, pos) {
  const x = pos.x, y = pos.y, z = pos.z;
  let best = null, bestScore = Infinity;
  for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + d[0], nz = z + d[2];
    const top = topSolidY(bot, nx, nz, y);
    if (top == null) continue;
    const head = safeBlockAt(bot, nx, top + 2, nz);
    if (isSolidBlock(head)) continue;
    const score = Math.abs(top - y);
    if (score < bestScore) { bestScore = score; best = { x: nx, y: top + 1, z: nz }; }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * elevation & hazards
 * ------------------------------------------------------------------ */

/**
 * Everything the bot needs to know about the column it is about to walk into.
 * `y` is the *standing* height (the empty cell above the surface), so a goal
 * built from this is always a place the bot can actually be.
 */
function columnInfo(bot, x, z, refY) {
  x = Math.floor(x); z = Math.floor(z);
  const top = topSolidY(bot, x, z, refY);
  if (top == null) return null;
  const surf = safeBlockAt(bot, x, top, z);
  const info = {
    x, z,
    surface: top,          // the block the feet rest on
    y: top + 1,            // the empty cell the entity occupies
    block: surf ? surf.name : 'air',
    headBlocked: isSolidBlock(safeBlockAt(bot, x, top + 2, z))
  };
  // How far does this column drop if you keep walking? Look at a shallow ring
  // of neighbours one step beyond, and take the worst (lowest) surface found.
  let low = info.surface, lowDx = 0, lowDz = 0;
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]]) {
    const n = topSolidY(bot, x + dx, z + dz, refY);
    if (n == null) continue;
    if (n < low) { low = n; lowDx = dx; lowDz = dz; }
  }
  info.dropBeyond = info.surface - low;      // >0 means a cliff nearby
  info.dropDir = { dx: lowDx, dz: lowDz };
  info.loaded = true;
  return info;
}

/**
 * How far below the bot's feet the ground goes, in a given direction, up to
 * `maxDepth` + 1. A number >= maxDepth+1 means "at least that deep, giving up"
 * — i.e. a genuine cliff rather than a step.
 */
function dropInDirection(bot, from, dx, dz, maxDepth = 4) {
  if (!from) return 0;
  const start = Math.floor(from.y);
  let x = Math.floor(from.x) + dx, z = Math.floor(from.z) + dz;
  for (let depth = 1; depth <= maxDepth + 1; depth++) {
    const y = start - depth;
    if (isSolidBlock(safeBlockAt(bot, x, y, z))) return depth - 1;
  }
  return maxDepth + 1;
}

/**
 * The best nearby cell to retreat *to*, given a threat position.
 *
 * Replaces the old escape math, which computed
 *
 *     away = botPos * 2 - threatPos
 *
 * and then asked the pathfinder to reach it. That vector was pure x/z
 * arithmetic: on any map with relief it lands in a gully, on a ledge, inside a
 * hill, or past a cliff the pathfinder will not descend — so the bot "only
 * worked on flat ground". Now the candidate ring is *scored against the world*:
 * distance from the threat first, then climb-ability (a one-block step back is
 * fine, a five-block climb is not), then whether the cell is a dead end.
 */
function escapeSpot(bot, from, threat, opts = {}) {
  if (!from || !threat) return null;
  const tp = threat.position || threat;
  if (tp.x == null || tp.z == null) return null;
  const radius = opts.radius != null ? opts.radius : 10;
  const minGap = opts.minGap != null ? opts.minGap : 4;
  let best = null, bestScore = -Infinity;
  const fx = Math.floor(from.x), fz = Math.floor(from.z), fy = Math.floor(from.y);
  const tx = Math.floor(tp.x), tz = Math.floor(tp.z);
  for (let r = 2; r <= radius; r += 1) {
    for (let i = 0; i < 16; i++) {
      // bias toward "away from the threat" but scan a full ring, so an escape
      // sideways or backwards around a cliff is still found
      const ang = (i / 16) * Math.PI * 2 + (r * 0.37);
      const x = fx + Math.round(Math.cos(ang) * r);
      const z = fz + Math.round(Math.sin(ang) * r);
      const col = columnInfo(bot, x, z, fy);
      if (!col || col.headBlocked) continue;
      // feet cell empty, head cell empty, floor solid — the full standability
      // test. columnInfo alone does not verify the floor under `col.y`.
      if (!isStandable(bot, x, col.y, z)) continue;
      const gap = Math.hypot(x - tx, z - tz);
      if (!(gap >= minGap)) continue;            // NaN-safe: reject, never fallthrough
      if (!Number.isFinite(gap)) continue;
      let score = gap * 2;
      const climb = col.y - fy;
      if (climb > 1) score -= (climb - 1) * 8;        // do not flee into a wall
      if (climb < -1) score -= Math.abs(climb + 1) * 4; // nor off a tall ledge
      if (col.dropBeyond > 2) score -= 6;             // a ledge with a cliff past it
      // a cell whose only exits are back the way we came is a pocket
      let exits = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = columnInfo(bot, x + dx, z + dz, fy);
        if (n && Math.abs(n.y - col.y) <= 1) exits++;
      }
      score += exits * 1.5;
      if (score > bestScore) { bestScore = score; best = col; }
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z, gap: Math.hypot(best.x - tx, best.z - tz) } : null;
}

module.exports = {
  probe,
  safeBlockAt,
  isSolidBlock,
  isStandable,
  topSolidY,
  standableSpotNear,
  columnInfo,
  dropInDirection,
  escapeSpot,
  HALF_BLOCKS
};
