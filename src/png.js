'use strict';

/**
 * Minimal PNG encoder (RGB, 8-bit, no interlacing).
 *
 * Zero dependencies beyond node's own `zlib`. Used to write 360-degree
 * panoramas and radar maps captured from the bot's loaded world.
 */

const zlib = require('zlib');

function crc32() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return (buf, start, end) => {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
}

const crc = crc32();

function chunk(type, data) {
  // [ length:u32 ][ type:4 ][ data ][ crc:u32 ]
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  const c = crc(out, 4, 8 + data.length);
  out.writeUInt32BE(c, 8 + data.length);
  return out;
}

/**
 * Encode an RGB raster as a PNG buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} rgb  width*height*3 bytes, row-major, top row first
 */
function encode(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw new Error(`rgb buffer is ${rgb.length} bytes, expected ${width * height * 3}`);
  }
  // Filter type 0 (None) prefixed on every scanline.
  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    const src = y * stride;
    for (let i = 0; i < stride; i++) filtered[y * (stride + 1) + 1 + i] = rgb[src + i];
  }

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const idat = zlib.deflateSync(filtered, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { encode };
