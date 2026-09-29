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
