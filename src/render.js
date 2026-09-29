'use strict';

/**
 * Software renderers that turn the bot's loaded chunks into images.
 *
 *  - renderPanorama(): a full 360-degree equirectangular "screenshot" from the
 *    bot's eye position, produced by voxel raycasting. One ray per pixel
 *    column; shading comes from the hit face, distance fog, and a procedural
 *    sky gradient. No textures, no OpenGL, no GPU required.
 *  - renderRadar(): a top-down height map centred on the bot, for the TUI.
 *
 * Both take a `world` adapter of shape { getBlock(x, y, z) -> block | null },
 * so they work identically against mineflayer and against the offline mock.
 */

const { colorFor, isEmptyBlock, shade, blend } = require('./colors');
const { encode: encodePng } = require('./png');

const DEG = Math.PI / 180;

const DEFAULT_SKY = {
  zenith: [98, 148, 224],
  horizon: [186, 214, 240],
  fog: [196, 218, 238]
};

/**
 * Voxel DDA raycast (Amanatides & Woo).
 *
 * @returns {block, face:[nx,ny,nz], dist} or null if nothing solid within range.
 */
function raycast(world, ox, oy, oz, dx, dy, dz, range, minY, maxY) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
  const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
  const stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);

  // distance to the first voxel boundary in each axis
  const fracX = ox - x, fracY = oy - y, fracZ = oz - z;
  let tMaxX = dx === 0 ? Infinity : (dx > 0 ? 1 - fracX : fracX) * tDeltaX;
  let tMaxY = dy === 0 ? Infinity : (dy > 0 ? 1 - fracY : fracY) * tDeltaY;
  let tMaxZ = dz === 0 ? Infinity : (dz > 0 ? 1 - fracZ : fracZ) * tDeltaZ;

  let face = [0, 0, 0];
  let t = 0;
  const r2 = range * range;

  // advance to the first voxel boundary so the voxel containing the camera is
  // never sampled (otherwise a camera embedded in a block paints every ray)
  if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; face = [-stepX, 0, 0]; }
  else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += tDeltaY; face = [0, -stepY, 0]; }
  else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = [0, 0, -stepZ]; }

  while (t * t < r2) {
    if (y >= minY && y <= maxY) {
      const block = world.getBlock(x, y, z);
      if (block && !isEmptyBlock(block)) {
        return { block, face, dist: t };
      }
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; face = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; face = [0, -stepY, 0];
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = [0, 0, -stepZ];
    }
  }
  return null;
}

/**
 * Render a 360-degree panorama.
 *
 * @param {object} opts
 * @param {object} opts.world          { getBlock(x,y,z) }
 * @param {object} opts.eye            {x,y,z} camera position
 * @param {number} [opts.width]        horizontal pixels (default 160)
 * @param {number} [opts.height]       vertical pixels (default 48)
 * @param {number} [opts.pitchTopDeg]  top of the frame, degrees above horizon (default 35)
 * @param {number} [opts.pitchBottomDeg] bottom of frame, degrees below horizon (default -25)
 * @param {number} [opts.range]        ray length in blocks (default 128)
 * @param {number} [opts.minY]/[opts.maxY] world height bounds
 * @param {object} [opts.sky]          {zenith, horizon, fog} colours
 * @param {function} [opts.onProgress] called with (done, total) between row batches
 * @param {number} [opts.yieldEvery]   rows per macrotask (default 4; 0 = synchronous)
 * @returns {Promise<{width,height,data:Uint8Array}>}
 */
async function renderPanorama(opts) {
  const w = Math.max(8, opts.width | 0);
  const h = Math.max(4, opts.height | 0);
  const range = opts.range || 128;
  const minY = opts.minY != null ? opts.minY : -64;
  const maxY = opts.maxY != null ? opts.maxY : 320;
  const eye = opts.eye;
  const world = opts.world;
  const sky = Object.assign({}, DEFAULT_SKY, opts.sky || {});
  const top = (opts.pitchTopDeg != null ? opts.pitchTopDeg : 35) * DEG;
  const bottom = (opts.pitchBottomDeg != null ? opts.pitchBottomDeg : -25) * DEG;
  const yieldEvery = opts.yieldEvery != null ? opts.yieldEvery : 4;
  const data = new Uint8Array(w * h * 3);

  const skyColumn = new Array(h);
  for (let y = 0; y < h; y++) {
    const pitch = bottom + (top - bottom) * (h - 1 - y) / (h - 1);
    // unit direction for this row (horizontal part scaled per column below)
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    skyColumn[y] = { pitch, cosP, sinP };
    // sky colour: blend horizon -> zenith by pitch
    const t = Math.max(0, Math.min(1, pitch / (Math.PI / 2)));
    skyColumn[y].sky = blend(sky.horizon, sky.zenith, Math.pow(t, 0.6));
  }

  const rowFogStart = Math.min(range * 0.25, 48);

  for (let y = 0; y < h; y++) {
    const { pitch, cosP, sinP, sky: skyCol } = skyColumn[y];
    const rowOff = y * w * 3;
    for (let x = 0; x < w; x++) {
      const yaw = (x / w) * Math.PI * 2;
      const dx = -Math.sin(yaw) * cosP;
      const dy = sinP;
      const dz = Math.cos(yaw) * cosP;
      const hit = raycast(world, eye.x, eye.y, eye.z, dx, dy, dz, range, minY, maxY);
      let c;
      if (!hit) {
        c = skyCol;
      } else {
        const n = hit.face;
        let f = 1.0;
        if (n[1] > 0) f = 1.0;            // top
        else if (n[1] < 0) f = 0.55;      // bottom
        else if (n[0] !== 0) f = 0.80;    // x sides
        else f = 0.70;                    // z sides
        c = shade(colorFor(hit.block.name), f);
        const fogT = Math.max(0, Math.min(1, (hit.dist - rowFogStart) / (range - rowFogStart)));
        c = blend(c, sky.fog, fogT * 0.6);
      }
      const o = rowOff + x * 3;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
    }
    if (yieldEvery > 0 && onProgressAndYield(y + 1, h)) {
      if (opts.onProgress) opts.onProgress(y + 1, h);
      await new Promise(r => setImmediate(r));
    }
  }
  if (opts.onProgress) opts.onProgress(h, h);
  return { width: w, height: h, data };
}

function onProgressAndYield(row, h) { return row < h && (row % 4 === 0); }

/**
 * Render a top-down map centred on (cx, cz) at reference height refY.
 *
 * Each cell gets the colour of the highest non-empty block within
 * [refY - below, refY + above], shaded by its height relative to refY so that
 * hills and valleys are readable. Unloaded columns render as background.
 *
 * @returns {size, rgb:Uint8Array, topY:Int16Array}
 */
function renderRadar(opts) {
  const r = Math.max(1, opts.radius | 0);
  const size = r * 2 + 1;
  const cx = opts.cx, cz = opts.cz, refY = opts.refY;
  const above = opts.above != null ? opts.above : 12;
  const below = opts.below != null ? opts.below : 16;
  const minY = opts.minY != null ? opts.minY : -64;
  const maxY = opts.maxY != null ? opts.maxY : 320;
  const bg = opts.background || [30, 30, 38];
  const world = opts.world;
  const rgb = new Uint8Array(size * size * 3);
  const topY = new Int16Array(size * size);

  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = Math.floor(cx) + dx;
      const pz = Math.floor(cz) + dz;
      const idx = (dz + r) * size + (dx + r);
      let found = null;
      const yHi = Math.min(maxY, Math.floor(refY) + above);
      const yLo = Math.max(minY, Math.floor(refY) - below);
      for (let y = yHi; y >= yLo; y--) {
        const b = world.getBlock(px, y, pz);
        if (b && !isEmptyBlock(b)) { found = { b, y }; break; }
      }
      if (!found) {
        rgb[idx * 3] = bg[0]; rgb[idx * 3 + 1] = bg[1]; rgb[idx * 3 + 2] = bg[2];
        topY[idx] = -9999;
      } else {
        topY[idx] = found.y;
        const dy = found.y - Math.floor(refY);
        // higher ground is brighter, lower ground darker
        const f = Math.max(0.45, Math.min(1.25, 1 + dy * 0.028));
        const c = shade(colorFor(found.b.name), f);
        rgb[idx * 3] = c[0]; rgb[idx * 3 + 1] = c[1]; rgb[idx * 3 + 2] = c[2];
      }
    }
  }
  return { size, rgb, topY };
}

/** Write an RGB raster to disk as PNG. Returns the byte size written. */
function writePng(filePath, width, height, data) {
  const png = encodePng(width, height, data);
  require('fs').writeFileSync(filePath, png);
  return png.length;
}

/**
 * Downsample an RGB raster to a smaller box, nearest-neighbour, preserving
 * aspect ratio as closely as the box allows. Used to ship a TUI preview over
 * IPC without sending megabytes.
 *
 * @returns {width, height, data:Uint8Array}
 */
function downsample(src, srcW, srcH, boxW, boxH) {
  const scale = Math.max(1, Math.min(Math.floor(srcW / boxW), Math.floor(srcH / boxH)) || 1);
  const w = Math.max(1, Math.floor(srcW / scale));
  const h = Math.max(1, Math.floor(srcH / scale));
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * scale) * srcW * 3 + (x * scale) * 3;
      const di = (y * w + x) * 3;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2];
    }
  }
  return { width: w, height: h, data: out };
}

module.exports = { renderPanorama, renderRadar, raycast, writePng, downsample };
