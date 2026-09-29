'use strict';

/**
 * Headless daemon entry point.
 *
 * Starts BotCore and stays in the foreground. With the default mode 'afk' it
 * behaves exactly like the original passive AFK bot: no movement, no chat, no
 * block breaking.
 *
 *   node src/bot.js                     # passive AFK daemon (the default)
 *   node src/bot.js --mode wander       # start wandering on spawn
 *   node src/bot.js --demo              # offline demo world, no server needed
 *
 * Drive a running daemon with the TUI:   node src/tui.js
 */

const { loadConfig } = require('./config');
const { BotCore } = require('./core');
const { createMockBot } = require('./mock');
const lock = require('./lockfile');
const path = require('path');

async function main() {
  const argv = process.argv.slice(2);
  const demo = argv.includes('--demo');
  const cfg = loadConfig(argv.filter(a => a !== '--demo'));

  // Single-instance guard. Without this, a second daemon would race the first
  // for the IPC socket and produce duplicate-login kick loops. (Killing those
  // by pattern-matching the command line also matched the caller's own shell,
  // so the PID file is how tooling should find the daemon instead.)
  const pidFile = path.join(__dirname, '..', 'run', 'bot.pid');
  const claim = lock.acquire(pidFile);
  if (!claim.acquired) {
    console.error(`daemon already running (pid ${claim.pid}${claim.stale ? ', stale lock reclaimed by another start' : ''})`);
    console.error(`  to stop it: kill ${claim.pid}   (or: node tools/daemon.js stop)`);
    process.exit(2);
  }

  const core = new BotCore({
    config: cfg,
    demo,
    createBot: demo ? (opts) => createMockBot({ username: opts.username }) : null,
    releaseLock: () => release()
  });

  const release = () => { try { lock.release(pidFile); } catch (_) {} };
  process.on('SIGINT', () => core.shutdown('SIGINT'));
  process.on('SIGTERM', () => core.shutdown('SIGTERM'));
  process.on('beforeExit', release);
  process.on('uncaughtException', (e) => {
    core.logger.error('uncaught exception', { error: e.message, stack: e.stack });
    try { core.stats.errors++; } catch (_) {}
    if (!core.shuttingDown) core.scheduleReconnect('uncaughtException');
  });
  process.on('unhandledRejection', (e) => {
    core.logger.error('unhandled rejection', { error: e && e.message ? e.message : String(e) });
  });

  try {
    await core.start();
  } catch (e) {
    release();
    throw e;
  }
}

main().catch((e) => {
  console.error('fatal:', e && e.message ? e.message : e);
  process.exit(1);
});
