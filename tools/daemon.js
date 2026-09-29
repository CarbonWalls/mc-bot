#!/usr/bin/env node
/**
 * Daemon lifecycle helper.
 *
 * Replaces the `pkill -f src/bot.js` pattern that kept matching the caller's
 * own shell (exit 143) and orphaning duplicate daemons. The daemon writes its
 * PID to run/bot.pid, so this tool can target that exact process.
 *
 *   node tools/daemon.js status   # is a daemon running, and which pid?
 *   node tools/daemon.js stop     # SIGTERM the daemon (clean quit packet)
 *   node tools/daemon.js kill     # SIGKILL, only if stop times out
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PID_FILE = path.join(PROJECT_ROOT, 'run', 'bot.pid');

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function action() { return process.argv[2] || 'status'; }

function main() {
  const pid = readPid();
  const act = action();

  if (act === 'status') {
    if (pid === null) { console.log('no daemon running (no pid file)'); process.exit(1); }
    if (!isAlive(pid)) {
      console.log(`stale pid file: pid ${pid} is not running`);
      console.log(`  remove it: rm ${PID_FILE}`);
      process.exit(1);
    }
    console.log(`daemon running pid=${pid} pidfile=${PID_FILE}`);
    // Show the socket too, so an operator knows where the TUI connects.
    const sock = path.join(PROJECT_ROOT, 'run', 'bot.sock');
    console.log(`  ipc socket: ${sock} ${fs.existsSync(sock) ? '(present)' : '(missing)'}`);
    process.exit(0);
  }

  if (act === 'stop' || act === 'kill') {
    if (pid === null) { console.log('no daemon running'); process.exit(1); }
    if (!isAlive(pid)) { console.log(`pid ${pid} not running (stale pid file)`); process.exit(1); }
    const sig = act === 'kill' ? 'SIGKILL' : 'SIGTERM';
    try { process.kill(pid, sig); } catch (e) { console.error(`failed to signal ${pid}: ${e.message}`); process.exit(1); }
    console.log(`sent ${sig} to pid ${pid}`);
    if (act === 'stop') {
      // Give the daemon a moment to send its quit packet and release the lock.
      const deadline = Date.now() + 5000;
      const iv = setInterval(() => {
        if (!isAlive(pid) || Date.now() > deadline) {
          clearInterval(iv);
          if (isAlive(pid)) console.log('  still running after 5s — use: node tools/daemon.js kill');
          else console.log('  stopped');
          process.exit(isAlive(pid) ? 3 : 0);
        }
      }, 250);
    } else {
      process.exit(0);
    }
    return;
  }

  console.error('usage: node tools/daemon.js status|stop|kill');
  process.exit(2);
}

main();
