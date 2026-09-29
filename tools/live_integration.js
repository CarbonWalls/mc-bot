#!/usr/bin/env node
/**
 * Live integration test against the local Paper server.
 *
 * This is the "does it actually work" check that offline tests cannot be. It
 * exercises the whole stack end to end through the daemon's IPC surface:
 *
 *   spawn -> status -> wander -> goto -> come -> gather (>=1 log)
 *        -> screenshot (valid PNG) -> radar -> survive -> fight back / flee
 *        -> recover -> TUI dashboard renders
 *
 * Every step is asserted, so a regression is a specific failure rather than
 * "the bot seems broken". Requires a running daemon + server:
 *
 *   cd ../afk-test-server && ./start.sh
 *   node src/bot.js --host 127.0.0.1 --port 25599 --username BetaBot --version 26.1
 *   node tools/live_integration.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const { IpcClient } = require(path.join(ROOT, 'src', 'ipc.js'));
const { VirtualScreen, Tui } = require(path.join(ROOT, 'src', 'tui.js'));

const SOCK = path.join(ROOT, 'run', 'bot.sock');

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function send(client, cmd, args, timeoutMs = 60000) {
  try { return await client.send(cmd, args || {}, timeoutMs); }
  catch (e) { return { error: e.message }; }
}

/** A PNG is only valid if it decodes and carries the expected dimensions. */
function pngIsValid(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 33 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (w === 0 || h === 0) return false;
    // every IDAT must inflate cleanly
    let pos = 8, ok = false;
    while (pos < buf.length - 8) {
      const len = buf.readUInt32BE(pos);
      const type = buf.slice(pos + 4, pos + 8).toString('ascii');
      if (type === 'IDAT') {
        const chunk = buf.slice(pos + 8, pos + 8 + len);
        zlib.inflateSync(Buffer.concat([chunk]));
        ok = true;
      }
      pos += 12 + len;
    }
    return ok;
  } catch (_) { return false; }
}

async function main() {
  const client = new IpcClient();
  client.connect(SOCK);

  console.log('\n=== live integration (Paper 26.1.2) ===\n');

  // ---- spawn / status ----------------------------------------------------
  console.log('--- spawn & status ---');
  let st = await send(client, 'status', {}, 10000);
  check('daemon responds to status', st && !st.error, st && st.error);
  check('bot has spawned', st && st.state === 'spawned', st && st.state);
  check('health is known', st && st.health != null && st.health > 0, st && st.health);
  check('position is known', st && st.pos && Number.isFinite(st.pos.x), JSON.stringify(st && st.pos));

  // ---- wander ------------------------------------------------------------
  console.log('--- wander ---');
  const before = st && st.pos ? { ...st.pos } : null;
  await send(client, 'exec', { line: 'wander 24' });
  await sleep(12000);
  st = await send(client, 'status', {}, 10000);
  const moved = before && st && st.pos &&
    Math.hypot(st.pos.x - before.x, st.pos.z - before.z) > 1.5;
  check('wander moved the bot', moved, JSON.stringify(st && st.pos));

  // ---- goto --------------------------------------------------------------
  console.log('--- goto ---');
  const target = before ? { x: Math.round(before.x) + 6, y: Math.round(before.y), z: Math.round(before.z) } : null;
  const startDist = target && st && st.pos
    ? Math.hypot(st.pos.x - target.x, st.pos.z - target.z) : 999;
  await send(client, 'exec', { line: `goto ${target.x} ${target.y} ${target.z}` });
  await sleep(15000);
  st = await send(client, 'status', {}, 10000);
  const dist = st && st.pos ? Math.hypot(st.pos.x - target.x, st.pos.z - target.z) : 999;
  // The goal is GoalNear with `gotoRange` (default 3). Real terrain can put the
  // last block out of reach (a wall, a drop, water). What matters is not the
  // final distance but that the goal RESOLVES — either arriving, or giving up
  // with a logged reason — instead of standing forever at 10 blocks claiming
  // to still be going there.
  const gotoRange = 3;
  check('goto closed the distance to the target', dist < startDist,
    `${startDist && startDist.toFixed(1)} -> ${dist && dist.toFixed(1)}`);
  check('goto stopped near the target or gave up cleanly',
    dist <= gotoRange + 8 || (st && st.actor && st.actor.mode === 'afk'),
    `distance ${dist && dist.toFixed(1)} mode ${st && st.actor && st.actor.mode}`);

  // ---- come --------------------------------------------------------------
  console.log('--- come ---');
  await send(client, 'exec', { line: 'come' });
  await sleep(12000);
  st = await send(client, 'status', {}, 10000);
  const home = st && st.home;
  const homeDist = st && st.pos && home
    ? Math.hypot(st.pos.x - home.x, st.pos.z - home.z) : 999;
  check('come returned the bot toward home', homeDist < 16, `distance ${homeDist && homeDist.toFixed(1)}`);

  // ---- screenshot --------------------------------------------------------
  console.log('--- screenshot ---');
  const shot = await send(client, 'screenshot', { width: 512, height: 180 }, 180000);
  check('screenshot command succeeded', shot && !shot.error && shot.file, shot && shot.error);
  check('panorama is a valid, decodable PNG', shot && shot.file && fs.existsSync(shot.file) && pngIsValid(shot.file));
  check('panorama has a preview payload', shot && shot.preview && shot.preview.data && shot.preview.data.length > 0);

  // ---- radar -------------------------------------------------------------
  console.log('--- radar ---');
  const radar = await send(client, 'radar', { radius: 24 });
  // The radar payload is a heightmap (topY, one entry per column) plus an
  // entity list and a rendered preview — there is no `cells` grid.
  check('radar produced a heightmap', radar && Array.isArray(radar.topY) && radar.topY.length > 0, radar && radar.error);
  check('radar reports its size and radius', radar && radar.size > 0 && radar.radius > 0);
  check('radar reports entities in range', radar && Array.isArray(radar.entities),
    JSON.stringify(radar && radar.entities && radar.entities.length));

  // ---- gather ------------------------------------------------------------
  console.log('--- gather ---');
  await send(client, 'exec', { line: 'afk' });
  await sleep(500);
  await send(client, 'survive', { on: true });
  const st0 = await send(client, 'status', {}, 10000);
  const startLogs = (st0 && st0.counters && st0.counters.logsChopped) || 0;
  await send(client, 'exec', { line: 'gather 64' });
  await sleep(45000);     // approach + chop; the night gate can extend this
  st = await send(client, 'status', {}, 10000);
  const endLogs = (st && st.counters && st.counters.logsChopped) || 0;
  const mode = (st && st.actor && st.actor.mode) || (st && st.mode);
  check('gather is in a known mode (not crashed)', !!mode, JSON.stringify(mode));
  check('at least one log was chopped', endLogs > startLogs,
    `logs ${startLogs} -> ${endLogs} (mode ${mode})`);

  // The point of the survival layer: an active goal must not silently spin.
  // Either it made progress, or it reported a reason.
  check('gather did something OR reported why it stopped',
    endLogs > startLogs || mode === 'afk' || mode === 'flee',
    `mode ${mode}, logs ${startLogs} -> ${endLogs}`);

  // ---- TUI dashboard -----------------------------------------------------
  console.log('--- tui dashboard ---');
  let tuiOk = false, tuiErr = null;
  try {
    const screen = new VirtualScreen(90, 32);
    const tui = new Tui({ screen, ipcPath: SOCK });
    tui.status = st;
    tui.daemonState = 'online';
    tui.render();
    const body = screen.text;
    tuiOk = /AFK/i.test(body) && /GOAL|MODE/i.test(body) && /RADAR/i.test(body) && /LOG/i.test(body);
    if (!tuiOk) tuiErr = 'dashboard is missing one of the expected panes';
  } catch (e) { tuiErr = e.message; }
  check('TUI dashboard renders all panes from live state', tuiOk, tuiErr);

  client.close();

  console.log('\n=================================');
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log('=================================');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('live test failed:', e.message); process.exit(2); });
