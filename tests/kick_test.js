/**
 * Kick classification and the decision to stop reconnecting.
 *
 * Why this exists: the daemon treated every kick as a transient failure —
 * log it, wait, connect again. That is correct for a lag blip and wrong for a
 * ban, where retrying is the thing that turns a temporary block permanent.
 *
 * This was not hypothetical. Against the live 4of5 server the bot was answered
 * four times in 40 seconds with
 *   {"translate":"multiplayer.disconnect.banned.reason",
 *    "with":["You have been idle for too long. This violates our terms of
 *            service: aternos.org/tos"]}
 * and it reconnected each time on its own backoff. With the default
 * reconnect.maxAttempts the loop would have run 25 times per target.
 *
 * The tests below cover three things:
 *   1. classifyKick's patterns, including the locale-CODE forms mineflayer
 *      actually delivers (a naive substring match on prose misses them)
 *   2. that a ban sets the flag that makes scheduleReconnect refuse
 *   3. that a *successful spawn clears it*, because a lifted ban must not
 *      require a process restart
 *
 * Also covered: logged_in_new must NOT stop. That is a double-login blip which
 * happens when a daemon reconnects before its previous session times out, and
 * treating it as a ban would kill the bot during ordinary operation. It is
 * pinned here because classifying it wrong looked reasonable at first.
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { classifyKick } = require(path.join(ROOT, 'src', 'core.js'));

/** Build the JSON chat component mineflayer passes to `kicked`. */
function tr(translate, withArgs) {
  return JSON.stringify(withArgs ? { translate, with: withArgs } : { translate });
}

function register({ test, testAsync }) {

  /* ---------------- classification ---------------- */
  test('a real Aternos idle ban is classified as a stop', () => {
    // Verbatim from logs captured on 4of5.aternos.me.
    const reason = tr('multiplayer.disconnect.banned.reason',
      ['You have been idle for too long. This violates our terms of service: aternos.org/tos']);
    const k = classifyKick(reason);
    assert.strictEqual(k.kind, 'idle_ban');
    assert.strictEqual(k.stop, true, 'an idle ban must stop reconnecting');
    assert.match(k.action, /antiIdle|movement|active mode/i, 'and name the knob to turn');
  });

  test('ban variants stop; prose and locale codes both match', () => {
    const stopCases = [
      ['You are BANNED from this server', 'ban'],
      ['Permanently banned', 'ban'],
      [tr('multiplayer.disconnect.banned'), 'ban'],
      [tr('multiplayer.disconnect.banned.invalid_reply'), 'ban'],
      ['ip ban', 'ban'],
      ['blacklisted', 'ban']
    ];
    for (const [reason, kind] of stopCases) {
      const k = classifyKick(typeof reason === 'string' ? reason : reason);
      assert.strictEqual(k.kind, kind, `expected ${kind} for ${String(reason).slice(0, 45)}`);
      assert.strictEqual(k.stop, true, `must stop for ${String(reason).slice(0, 45)}`);
    }
  });

  test('a double login is a blip, not a ban', () => {
    // The dangerous misclassification: logged_in_new reads like a rejection, but
    // it is what happens when a reconnect races the old session's timeout.
    // Stopping there bricks the bot during ordinary operation.
    for (const reason of [
      tr('multiplayer.disconnect.logged_in_new'),
      'You logged in from another location'
    ]) {
      const k = classifyKick(reason);
      assert.strictEqual(k.stop, false, `must NOT stop for ${String(reason).slice(0, 40)}`);
      assert.strictEqual(k.kind, 'transient');
    }
  });

  test('server full and whitelist wait longer instead of stopping', () => {
    for (const reason of [
      tr('multiplayer.disconnect.server_full'),
      tr('multiplayer.disconnect.not_whitelisted'),
      'The server is full',
      'Whitelist is enabled'
    ]) {
      const k = classifyKick(reason);
      assert.strictEqual(k.stop, false, 'transient rejection must retry');
      assert.strictEqual(k.kind, 'denied');
      assert.ok(k.holdMs >= 30000, `a full server should not be polled every 6s (got ${k.holdMs})`);
    }
  });

  test('ordinary disconnects stay transient', () => {
    for (const reason of [
      tr('disconnect.timeout'),
      tr('disconnect.genericReason', ['Kicked for no reason']),
      tr('multiplayer.disconnect.outdated_client'),
      'server closed'
    ]) {
      const k = classifyKick(reason);
      assert.strictEqual(k.stop, false, `must retry: ${String(reason).slice(0, 40)}`);
      assert.strictEqual(k.kind, 'transient');
      assert.strictEqual(k.holdMs, 0, 'a blip must not widen the backoff');
    }
  });

  test('null, empty and nonsense do not crash or stop', () => {
    for (const reason of [null, undefined, '', 'blah blah', '{}', '[]', 12345]) {
      const k = classifyKick(reason);
      assert.ok(k && typeof k.stop === 'boolean', `classifyKick(${reason}) returned ${JSON.stringify(k)}`);
      assert.strictEqual(k.stop, false, 'an unrecognised kick must not silently kill retries');
    }
  });

  test('classification survives a chat component nested in extra', () => {
    // Some servers send the reason as a formatted component tree rather than
    // translate/with, and the ban text is in `extra[].text`.
    const reason = JSON.stringify({
      text: '', extra: [{ text: 'You are ' }, { text: 'banned', color: 'red' }]
    });
    assert.strictEqual(classifyKick(reason).stop, true);
  });

  /* ---------------- the daemon actually acts on it ---------------- */
  /**
   * Release the core's timers without calling shutdown(). shutdown() quits the
   * bot, and the fake bot emits 'end' synchronously, which reaches shutdown's
   * finish() -> process.exit(0) and would kill the whole test runner mid-suite.
   */
  function teardown(core) {
    core.shuttingDown = true;
    for (const t of core.killTimers || []) { try { clearInterval(t); clearTimeout(t); } catch (_) {} }
    core.killTimers = new Set();
    if (core.reconnectTimer) { clearTimeout(core.reconnectTimer); core.reconnectTimer = null; }
  }

  function makeCore() {
    const { BotCore } = require(path.join(ROOT, 'src', 'core.js'));
    const { loadConfig } = require(path.join(ROOT, 'src', 'config.js'));
    const cfg = loadConfig([]);
    cfg.logging = { level: 'error', file: null, jsonl: null, statusFile: null };
    cfg.reconnect.enabled = true;
    cfg.reconnect.initialDelayMs = 10;
    const logs = [];
    const core = new BotCore({
      config: cfg,
      logger: {
        on: () => {}, info: (m, f) => logs.push(['info', m]), warn: (m, f) => logs.push(['warn', m, f]),
        error: (m, f) => logs.push(['error', m, f]), debug: () => {}, status: () => {}, level: 'error'
      },
      ipcPath: path.join(ROOT, 'run', `kick-test-${process.pid}.sock`)
    });
    // A fake bot that behaves like the mineflayer object core.onConnected expects.
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    bot.username = 'KickTestBot';
    bot.entity = { position: { x: 0, y: 64, z: 0, clone() { return this; }, distanceTo() { return 0; } }, yaw: 0, pitch: 0 };
    bot.health = 20; bot.food = 20;
    bot.game = { dimension: 'overworld' };
    bot.players = {}; bot.entities = {};
    bot._client = { end() { bot.emit('end', 'kicked'); }, on: () => {}, write: () => {} };
    bot.quit = () => bot._client.end();
    bot.on = EventEmitter.prototype.on.bind(bot);
    bot.once = EventEmitter.prototype.once.bind(bot);
    bot.removeListener = EventEmitter.prototype.removeListener.bind(bot);
    return { core, bot, logs };
  }

  test('a ban kick sets the flag that makes scheduleReconnect refuse', () => {
    const { core, bot, logs } = makeCore();
    core.stats.state = 'spawned';
    core.onConnected(bot);

    bot.emit('kicked', JSON.stringify({
      translate: 'multiplayer.disconnect.banned.reason',
      with: ['You have been idle for too long. This violates our terms of service']
    }));
    assert.strictEqual(core.banFatal, true, 'the kicked handler must record the verdict');
    assert.strictEqual(core.stats.state, 'banned');
    // snapshot() reads stats.kickKind for `mc status`; the kicked handler must
    // persist the classification on stats, not merely forward it to the file.
    assert.strictEqual(core.stats.kickKind, 'idle_ban',
      'the kick classification must be stored where the status snapshot can find it');

    // Now prove the retry is refused: the call runs and returns without ever
    // arming the timer that would fire the next connect().
    core.reconnectTimer = null;
    core.scheduleReconnect('socketClosed');
    assert.strictEqual(core.reconnectTimer, null,
      'a ban must not arm a reconnect timer - this is what makes 694 connects impossible');
    assert.ok(logs.some(l => l[0] === 'error' && /banned|banned or rejected/i.test(l[1])),
      'the refusal must be logged, not silent');
    // The whole chain, not just the fields: kicked -> stats -> snapshot(), which
    // is exactly what `mc status` consumes. A verdict that lives only in the log
    // is invisible to every tool the operator actually runs.
    const snap = core.snapshot();
    assert.strictEqual(snap.banned, true, 'snapshot() must carry the ban');
    assert.strictEqual(snap.kickKind, 'idle_ban', 'and name the kind of kick');
    assert.match(String(snap.lastKickReason), /idle for too long/, 'with the server\'s own reason');
    teardown(core);
  });

  test('versionFatal and banFatal are independent verdicts', () => {
    const { core, bot } = makeCore();
    core.onConnected(bot);
    // an unsupported version stops for a different reason and says so
    core.versionFatal = true;
    core.reconnectTimer = null;
    core.scheduleReconnect('handshake failed');
    assert.strictEqual(core.reconnectTimer, null, 'versionFatal must not retry');
    assert.strictEqual(core.banFatal, false, 'and must not be reported as a ban');
    core.versionFatal = false;
    teardown(core);
    void bot;
  });

  testAsync('a successful spawn clears the ban flag (a lifted ban needs no restart)', async () => {
    const { core, bot } = makeCore();
    core.onConnected(bot);
    bot.emit('kicked', 'You are banned');
    assert.strictEqual(core.banFatal, true);
    core.banFatal = false;                       // what the spawn handler does
    assert.strictEqual(core.banFatal, false);
    // And the real path: fire a spawn and confirm the handler clears it.
    core.banFatal = true;
    core.stats.state = 'banned';
    bot.emit('spawn');
    await new Promise(r => setImmediate(r));
    assert.strictEqual(core.banFatal, false, 'spawn must clear a stale ban verdict');
    teardown(core);
  });

  test('mc status exposes the ban so an operator is not left guessing', () => {
    // A banned daemon looks healthy from the outside: the process runs, the
    // socket answers, nothing moves. Without this the failure reads as "the bot
    // is broken".
    const src = require('fs').readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    assert.match(src, /banned: !!this\.banFatal/, 'snapshot() must report the ban');
    assert.match(src, /kickKind/, 'and which kind of kick caused it');
    const cli = require('fs').readFileSync(path.join(ROOT, 'bin', 'mc.js'), 'utf8');
    assert.match(cli, /banned/, 'the CLI must surface it');
  });
}

module.exports = { register };
