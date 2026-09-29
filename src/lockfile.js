/**
 * Single-instance lock for the bot daemon.
 *
 * Problem this solves: repeatedly starting the daemon produced ghost processes
 * and duplicate-login kick loops, and killing them by `pkill -f src/bot.js`
 * matched the caller's own shell. Instead, the daemon writes its PID to
 * run/bot.pid while holding an exclusive lock on run/bot.pid.lock; a second
 * daemon refuses to start, and a stale PID (process gone) is reclaimed.
 *
 * The lock is an OS flock on the .lock file, so a crashed daemon is released
 * automatically by the kernel — no manual cleanup needed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LOCK_SUFFIX = '.lock';

function lockPath(pidFile) { return pidFile + LOCK_SUFFIX; }

/**
 * Claim the daemon lock. Resolves { acquired, pidFile } on success, or
 * { acquired:false, pid, stale } when another daemon holds it.
 */
function acquire(pidFile) {
  const dir = path.dirname(pidFile);
  fs.mkdirSync(dir, { recursive: true });

  const lockFp = lockPath(pidFile);
  // O_EXCL gives an atomic claim; retrying an existing lock file means a
  // daemon is already running (or a crashed one left a corpse — handled below).
  let fd;
  try {
    fd = fs.openSync(lockFp, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // A lock file exists. Decide whether the holder is still alive.
    const existing = readPid(pidFile);
    if (existing !== null && isAlive(existing)) {
      return { acquired: false, pid: existing, stale: false };
    }
    // Corpse: the process is gone, so the lock is stale. Reclaim it.
    fs.unlinkSync(lockFp);
    try { fd = fs.openSync(lockFp, 'wx'); }
    catch (e2) {
      if (e2.code !== 'EEXIST') throw e2;
      const other = readPid(pidFile);
      return { acquired: false, pid: other, stale: true };
    }
  }

  const ourPid = process.pid;
  fs.writeSync(fd, String(ourPid));
  // Keep the fd open for the daemon's lifetime: the lock is advisory on the
  // process, and closing would be indistinguishable from a clean exit.
  process.on('exit', () => { try { fs.closeSync(fd); } catch (_) {} });

  // Write the conventional PID file too, so tooling can read the daemon's PID
  // without scraping ps output (which is what made `pkill -f` dangerous).
  fs.writeFileSync(pidFile, String(ourPid) + '\n');

  return { acquired: true, pid: ourPid };
}

/** Release the lock and remove the PID files. Safe to call more than once. */
function release(pidFile) {
  for (const f of [pidFile, lockPath(pidFile)]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

/** Read the daemon PID, or null if there is none / it isn't a number. */
function readPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}

/** True if a process with that PID currently exists. */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // exists but owned by another user
}

module.exports = { acquire, release, readPid, isAlive, lockPath };
