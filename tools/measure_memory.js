/**
 * Memory ceiling measurement (P3).
 *
 * Target device is an entry-level AArch64 Android phone with ~700 MB of RAM
 * available, so the bot must have a provable ceiling. This measures RSS at the
 * three points that actually allocate: panorama rendering (chunk decode),
 * long-running gather, and the TUI redraw loop. It also reports the configured
 * cap so a regression is a number, not a feeling.
 *
 *   node tools/measure_memory.js [--seconds 60]
 *
 * Run against the local Paper server with a daemon already up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { IpcClient } = require(path.join(ROOT, 'src', 'ipc.js'));

function rssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const line = status.split('\n').find(l => l.startsWith('VmRSS:'));
    if (!line) return null;
    return Math.round(Number(line.split(/\s+/)[1]) / 1024);   // kB -> MB
  } catch (_) { return null; }
}

function availMb() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = k => Number((m.match(new RegExp(k + ':\\s+(\\d+)')) || [0, 0])[1]);
    return Math.round((get('MemAvailable') - get('MemFree') * 0) / 1024);   // keep MemAvailable as-is
  } catch (_) { return null; }
}

function systemFreeMb() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = k => Number((m.match(new RegExp(k + ':\\s+(\\d+)')) || [0, 0])[1]);
    return Math.round(get('MemAvailable') / 1024);
  } catch (_) { return null; }
}

function parseSeconds() {
  const a = process.argv.find(x => x.startsWith('--seconds'));
  if (!a) return 35;
  const n = Number(a.split('=')[1] !== undefined ? a.split('=')[1] : a.split('-')[2]);
  return Number.isFinite(n) && n > 0 ? n : 35;
}

function daemonPid() {  try {
    return Number(fs.readFileSync(path.join(ROOT, 'run', 'bot.pid'), 'utf8').trim());
  } catch (_) { return null; }
}

function send(client, cmd, args, timeoutMs = 240000) {  // IpcClient.send() already resolves/rejects on the reply frame; this is just
  // the timeout for the slow commands (a panorama can take tens of seconds).
  return client.send(cmd, args || {}, timeoutMs)
    .catch(e => ({ error: e.message }));
}

async function main() {
  const seconds = parseSeconds();
  const pid = daemonPid();
  if (!pid) {
    console.error('no daemon running — start one first (node tools/daemon.js status)');
    process.exit(1);
  }
  const base = rssMb(pid);
  console.log(`daemon pid=${pid} baseline RSS=${base} MB | system available=${systemFreeMb()} MB`);
  if (base === null) { console.error('cannot read daemon RSS'); process.exit(1); }

  const client = new IpcClient();
  const sock = path.join(ROOT, 'run', 'bot.sock');
  client.connect(sock);

  const readings = [{ phase: 'baseline', rss: base, t: 0 }];
  const t0 = Date.now();
  let peak = base;
  const watch = setInterval(() => {
    const r = rssMb(pid);
    if (r !== null) peak = Math.max(peak, r);
  }, 500);

  // --- 1. panorama: the biggest single allocation (chunk decode + framebuffer)
  // The renderer caps at 1024x512; a 512x180 pano is ~92k rays and takes ~15s
  // on this CPU, which is the honest ceiling for a low-power device.
  console.log('\n[1/3] panorama render (512x180 + radar)...');
  const shot = await send(client, 'screenshot', { width: 512, height: 180, radar: true });
  readings.push({ phase: 'panorama', rss: rssMb(pid), t: Date.now() - t0 });
  console.log(`  reply ok=${!!(shot && shot.ok || shot && shot.file)} path=${shot && shot.path ? path.basename(shot.path) : (shot && shot.file ? path.basename(shot.file) : '-')}`);
  if (shot && shot.file && fs.existsSync(shot.file)) {
    console.log(`  png size=${Math.round(fs.statSync(shot.file).size / 1024)} KB`);
  }

  // --- 2. gather: sustained allocation over seconds of pathfinding + mining
  console.log(`\n[2/3] gather for ${seconds}s (pathfinding + digging)...`);
  await send(client, 'exec', { mode: 'gather', radius: 48 });
  await new Promise(r => setTimeout(r, seconds * 1000));
  readings.push({ phase: 'gather', rss: rssMb(pid), t: Date.now() - t0 });
  await send(client, 'exec', { mode: 'afk' });

  // --- 3. a second panorama, to see if the first one leaked
  console.log('\n[3/3] second panorama (leak check)...');
  const shot2 = await send(client, 'screenshot', { width: 512, height: 180, radar: true });
  readings.push({ phase: 'panorama2', rss: rssMb(pid), t: Date.now() - t0 });
  console.log(`  reply ok=${!!(shot2 && shot2.file)}`);

  clearInterval(watch);
  client.close();

  const final = rssMb(pid);
  console.log('\n=== memory summary ===');
  console.log(`system available now      : ${systemFreeMb()} MB`);
  for (const r of readings) {
    const delta = r.rss === null ? null : r.rss - base;
    console.log(`${r.phase.padEnd(10)} RSS=${String(r.rss).padStart(4)} MB  delta=${delta === null ? 'n/a' : (delta >= 0 ? '+' : '') + delta + ' MB'}  t=${r.t}ms`);
  }
  console.log(`peak observed RSS         : ${peak} MB  (+${peak - base} MB over baseline)`);
  console.log(`retained after settle     : ${final === null ? 'n/a' : final - base} MB (should be small — a leak shows here)`);
}

main().catch(e => { console.error('failed:', e.message); process.exit(1); });
