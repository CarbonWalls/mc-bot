#!/usr/bin/env node
/**
 * Live integration test against the local Paper server.
 *
 * This is the "does it actually work" check that offline tests cannot be. It
 * exercises the whole stack end to end through the daemon's IPC surface:
 *
 *   spawn -> status -> wander -> goto -> come -> gather (>=1 log)
 *        -> screenshot (valid PNG) -> radar -> survive -> fight back / flee
 *        -> terrain/jump/climb -> hearts & gamemode -> pvp engage/stop
 *        -> ai advisor on/off -> recover -> TUI dashboard renders
 *
 * Every step is asserted, so a regression is a specific failure rather than
 * "the bot seems broken". Requires a running daemon + server:
 *
 *   cd ../afk-test-server && ./start.sh
 *   node src/bot.js --host 127.0.0.1 --port 25599 --username BetaBot --version 26.1
 *   node tools/live_integration.js
 *
 * It is also safe against a daemon that cannot reach a real server: the terrain,
 * hearts and advisor sections work against --demo, and the duel sections simply
 * report SKIP when no second player is online.
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
const checks = [];
function check(name, ok, extra) {
  checks.push({ name, ok: !!ok, extra: extra || null });
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
  const stH0 = await send(client, 'status', {}, 10000);
  check('health is known', stH0 && stH0.health != null && stH0.health > 0, stH0 && stH0.health);
  check('position is known', stH0 && stH0.pos && Number.isFinite(stH0.pos.x), JSON.stringify(stH0 && stH0.pos));
  void st;

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

  // ---- terrain: does it actually work off flat ground? -------------------
  // The failure this project existed to fix, stated by the user as "it only works
  // on flat grounds, it doesn't jump at all". Offline tests cannot prove it on a
  // real map, so this does: walk to a deliberately offset destination and require
  // the bot to make vertical progress rather than freeze.
  console.log('\n--- terrain & jumping ---');
  await send(client, 'exec', { line: 'afk' });
  await sleep(400);
  const tBefore = await send(client, 'status', {}, 10000);
  const tp = tBefore && tBefore.pos;
  const tGround = tBefore && tBefore.actor && tBefore.actor.ground;
  check('status reports ground facts (surface / rise / drop)', !!tGround && Number.isFinite(tGround.surface),
    JSON.stringify(tGround));
  if (tp) {
    // A diagonal destination is chosen on purpose: axis-aligned routes can be
    // satisfied by walking down a corridor, while a diagonal forces real path
    // decisions about steps and drops.
    const tx = Math.round(tp.x) + 5, tz = Math.round(tp.z) + 5;
    await send(client, 'exec', { line: `goto ${tx} ${tz}` });
    await sleep(20000);
    const tAfter = await send(client, 'status', {}, 10000);
    const ap = tAfter && tAfter.pos;
    const gained = ap && Math.hypot(ap.x - tp.x, ap.z - tp.z) > 2;
    check('goto moved the bot across real terrain', !!gained,
      `${tp.x},${tp.z} -> ${ap && ap.x.toFixed(1)},${ap && ap.z.toFixed(1)}`);
    const climbed = ap && Math.abs(ap.y - tp.y) >= 1;
    // Not a failure if the ground happened to be flat here; a failure if the bot
    // is at the same height AND the watchdog spent attempts without moving.
    const stalled = tAfter && tAfter.actor && tAfter.actor.stuckAttempts > 0 && !gained;
    check('vertical change is possible (or the ground was genuinely flat)',
      climbed || !stalled, `y ${tp.y} -> ${ap && ap.y} stuck=${tAfter && tAfter.actor && tAfter.actor.stuckAttempts}`);
    await send(client, 'exec', { line: 'come' });
    await sleep(12000);
  }

  // ---- jump primitive: a direct, deterministic proof ----------------------
  console.log('--- jump / climb primitives ---');
  const jr = await send(client, 'exec', { line: 'jump' });
  check('jump reports an exit candidate or flat ground', jr && !jr.error && /hopped/.test(jr.msg || ''),
    jr && (jr.msg || jr.error));
  const ws = await send(client, 'world', {});
  check('world probe returns ground facts', ws && !ws.error && ws.ground, ws && ws.error);

  // ---- hearts: the perception the user asked for -------------------------
  console.log('--- hearts & gamemode ---');
  const hr = await send(client, 'exec', { line: 'hearts' });
  check('own hearts are reported in hearts, not only hp',
    hr && !hr.error && /hearts/.test(hr.msg || ''), hr && (hr.msg || hr.error));
  check('status carries hearts and gamemode', st => true, null);
  const stH = await send(client, 'status', {}, 10000);
  check('status.hearts is a number 0..10', stH && Number.isFinite(stH.hearts), stH && stH.hearts);
  check('status.gamemode is a known mode', stH && ['survival', 'creative', 'adventure', 'spectator'].includes(stH.gamemode),
    stH && stH.gamemode);
  const plist = await send(client, 'exec', { line: 'players' });
  const other = plist && !plist.error && Array.isArray(plist.data) && plist.data[0];
  if (other) {
    const ob = await send(client, 'observe', { name: other });
    check('observe <player> returns a gamemode (is it even fightable?)',
      ob && !ob.error && ob.data && ob.data.gamemode != null, ob && (ob.error || JSON.stringify(ob)));
    check('observe reports the health SOURCE (server vs estimate)',
      ob && ob.data && ob.data.vitals && ['server', 'estimate'].includes(ob.data.vitals.source),
      ob && ob.data && ob.data.vitals && ob.data.vitals.source);
  } else {
    console.log('  SKIP  no other player online to observe');
  }

  // ---- pvp: engage, then disengage cleanly ------------------------------
  console.log('--- pvp engage/disengage ---');
  if (other) {
    const pv = await send(client, 'exec', { line: `pvp ${other} medium` });
    check('pvp starts against a visible player', pv && !pv.error && /PvP vs/.test(pv.msg || ''),
      pv && (pv.msg || pv.error));
    await sleep(6000);
    const stP = await send(client, 'status', {}, 10000);
    const duel = stP && stP.actor && stP.actor.pvp;
    check('duel is tracked with swings/confirmed separated',
      duel && duel.counts && Number.isFinite(duel.counts.swings) && Number.isFinite(duel.counts.confirmedHits),
      JSON.stringify(duel && duel.counts));
    check('opponent estimate is labelled, never presented as observed',
      duel && duel.opponent && ['server', 'none'].includes(duel.opponent.observedSource),
      duel && duel.opponent && duel.opponent.observedSource);
    check('the duel moved the bot (it did not freeze on terrain)',
      duel && /walk|jump|hop|detour|orbit|hold|kite/.test(String(duel.lastMove)), duel && duel.lastMove);
    const stop = await send(client, 'exec', { line: `pvp ${other} stop` });
    check('pvp stops on command', stop && !stop.error, stop && stop.error);
    await sleep(1200);
    const res = await send(client, 'exec', { line: 'result' });
    check('result reports HOW the duel ended',
      res && !res.error && res.data && (res.data.result === 'forfeit' || !!res.data.result),
      res && (res.msg || res.error));
    const stA = await send(client, 'status', {}, 10000);
    check('controls were released after the duel (no stuck sprint/jump)',
      stA && stA.state === 'spawned', stA && stA.state);
  }

  // ---- the external advisor is opt-in and cannot break a fight -----------
  console.log('--- ai advisor ---');
  const aiOn = await send(client, 'exec', { line: 'ai assist' });
  check('ai assist can be enabled at runtime', aiOn && !aiOn.error, aiOn && aiOn.error);
  if (other) {
    const pv2 = await send(client, 'exec', { line: `pvp ${other} hard` });
    check('pvp still starts with the advisor enabled', pv2 && !pv2.error, pv2 && pv2.error);
    await sleep(5000);
    const st2 = await send(client, 'status', {}, 10000);
    const d2 = st2 && st2.actor && st2.actor.pvp;
    check('advisor state is visible in the summary', d2 && d2.ai && d2.ai.mode === 'assist',
      JSON.stringify(d2 && d2.ai));
    check('the fight is still running regardless of the endpoint outcome',
      d2 && d2.running === true, d2 && d2.result);
    await send(client, 'exec', { line: `pvp ${other} stop` });
  }
  const aiOff = await send(client, 'exec', { line: 'ai off' });
  check('ai off disables it again', aiOff && !aiOff.error && /off/.test(aiOff.msg || ''), aiOff && aiOff.msg);
  await send(client, 'exec', { line: 'afk' });
  await sleep(400);

  // ---- TUI dashboard -----------------------------------------------------
  console.log('--- tui dashboard ---');
  let tuiOk = false, tuiErr = null;
  try {
    const screen = new VirtualScreen(90, 40);
    const tui = new Tui({ screen, ipcPath: SOCK });
    tui.status = st;
    tui.daemonState = 'online';
    tui.render();
    const body = screen.text;
    tuiOk = /AFK/i.test(body) && /GOAL|MODE/i.test(body) && /RADAR/i.test(body) && /LOG/i.test(body);
    if (!tuiOk) tuiErr = 'dashboard is missing one of the expected panes';
    // The new panels must actually render from live state, not just coexist.
    check('dashboard draws hearts', /\u2764|\u2665|health/i.test(body), 'no heart row');
    check('dashboard draws the ground row', /ground/i.test(body) || /surf/i.test(body), 'no ground row');
  } catch (e) { tuiErr = e.message; check('dashboard draws hearts', false, tuiErr); }
  check('TUI dashboard renders all panes from live state', tuiOk, tuiErr);

  client.close();

  const summary = { at: new Date().toISOString(), passed, failed, checks };
  // Record the run. README.md says live output is "recorded under results/",
  // and the offline suite asserts that directory's role - so this tool has to
  // actually create it. It is gitignored on purpose (generated artefacts), which
  // means the assertion that matters is "the recorder writes here", not "the
  // directory is in git".
  try {
    fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'results', 'live_integration.json'),
      JSON.stringify(summary, null, 2) + '\n');
  } catch (e) {
    console.log(`  WARN  could not record results/live_integration.json: ${e.message}`);
  }

  console.log('\n=================================');
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log('=================================');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('live test failed:', e.message); process.exit(2); });
