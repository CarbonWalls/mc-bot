/**
 * Version-probe correctness (P6).
 *
 * The pre-flight status ping must be the SOLE arbiter of "unsupported server
 * version". Previously it ran once per daemon (gated on _probed) while the
 * bot 'error' handler carried a competing verdict, so the two could race and
 * whichever resolved last won. Now the probe runs on every connect and the
 * error handler defers to it.
 *
 * These tests pin that behaviour without a live server: they exercise
 * serverVersionKnown() (pure, data-driven) and assert the probe decision can't
 * be reached twice by two different paths.
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { serverVersionKnown, decideProbeAction } = require(path.join(ROOT, 'src', 'core.js'));

function register({ test }) {

  test('serverVersionKnown: known protocol resolves to a real data dir', () => {
    // The version the test rig actually runs — must be served.
    const ok = serverVersionKnown('775');
    assert.ok(ok.ok, 'protocol 775 (26.1) must be supported by the installed minecraft-data');
    assert.ok(ok.as, 'a supported protocol must report the version name it maps to');
  });

  test('serverVersionKnown: 26.2 / protocol 776 is NOT supported', () => {
    // The whole reason the cloud server is unjoinable. This is a regression
    // guard: if it ever flips to supported, the cloud target is now reachable.
    const no = serverVersionKnown('776');
    assert.ok(!no.ok, 'protocol 776 must report unsupported until minecraft-data ships 26.2');
  });

  test('serverVersionKnown: garbage protocols are rejected, not crashed on', () => {
    for (const bad of ['0', '999', '', 'abc', '-1']) {
      assert.ok(!serverVersionKnown(bad).ok, `protocol ${JSON.stringify(bad)} must be rejected`);
    }
    assert.ok(!serverVersionKnown(undefined).ok, 'undefined protocol must be rejected');
    assert.ok(!serverVersionKnown(null).ok, 'null protocol must be rejected');
  });

  test('serverVersionKnown: 1.21.4 (769) and 1.21.3 (768) remain supported', () => {
    // The bot must still be able to fall back to these if a rig is pinned there.
    assert.ok(serverVersionKnown('769').ok, 'protocol 769 (1.21.4)');
    assert.ok(serverVersionKnown('768').ok, 'protocol 768 (1.21.3)');
  });

  /* ---------------- stopped vs unsupported, as a pure decision ---------------- */
  test('a stopped Aternos proxy is waited out, never marked fatal', () => {
    // Captured live: while betahhd was asleep its proxy answered the ping with
    // exactly this. The original code sent -1 into serverVersionKnown(), got
    // !ok, and quit the process as unsupported_version - so a server that merely
    // slept (Aternos does it after ~6 idle minutes) killed the bot permanently
    // instead of waiting for someone to wake it.
    const stopped = { name: '\u00a7c\u25cf Offline', protocol: -1 };
    const d = decideProbeAction(stopped, serverVersionKnown);
    assert.strictEqual(d.kind, 'stopped', '-1 is not a Minecraft version, it is the handshake marker');
    assert.ok(!('versionFatal' in d) || d.kind !== 'unsupported', 'must not be a fatal verdict');
    assert.ok(d.probeDecision.ok === false && d.probeDecision.stopped === true,
      'the decision is recorded so the error handler can still defer to it');
  });

  test('a genuinely unsupported version IS fatal', () => {
    // The reverse error: treating this as transient is what produces a
    // reconnect loop against an unjoinable server.
    const d = decideProbeAction({ name: 'Paper 26.2', protocol: 776 }, serverVersionKnown);
    assert.strictEqual(d.kind, 'unsupported');
    assert.match(d.lastError, /776.*not supported/);
    assert.match(d.hint, /minecraft-data/);
  });

  test('joinable versions proceed to connect', () => {
    for (const proto of [774, 775, 769, 768]) {
      const d = decideProbeAction({ name: 'v' + proto, protocol: proto }, serverVersionKnown);
      assert.strictEqual(d.kind, 'connect', `protocol ${proto} must be joinable`);
      assert.strictEqual(d.probeDecision.ok, true);
    }
  });

  test('anything that cannot be a protocol number is waited out, not fatal', () => {
    // The safe direction of the error: a malformed or unexpected version block
    // must never end the run, because retrying costs only a backoff interval
    // while quitting costs the session. Each of these was a live possibility.
    const junk = [
      { name: 'x', protocol: 0 },
      { name: 'x', protocol: NaN },
      { name: 'x', protocol: Infinity },
      { name: 'x', protocol: -1 },
      { name: 'x', protocol: '774' },     // a string is not a measured number
      { name: 'x', protocol: 1.5 },       // non-integer
      { name: 'x', protocol: null },
      { name: 'x' },
      {},
      null,
      undefined
    ];
    for (const v of junk) {
      const d = decideProbeAction(v, serverVersionKnown);
      assert.strictEqual(d.kind, 'stopped', `must wait, not quit, for ${JSON.stringify(v)}`);
      assert.notStrictEqual(d.kind, 'unsupported');
    }
  });

  test('the decision keeps the shape the error handler defers to', () => {
    // connect() records the decision and bot.on('error') reads _probeDecision.ok
    // to avoid a second, competing verdict. A rename here silently re-enables the
    // two-paths-race bug this suite was written to prevent.
    const core = require('fs').readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    const d = decideProbeAction({ name: 'a', protocol: 774 }, serverVersionKnown);
    assert.ok('ok' in d.probeDecision, 'probeDecision must expose .ok');
    assert.match(core, /core\._probeDecision = decision\.probeDecision/, 'connect() must store it');
    assert.match(core, /this\._probeDecision && this\._probeDecision\.ok/, 'the error handler must read it');
    assert.ok(!/core\._probeDecision = \{ name: version\.name/.test(core),
      'the inline decision should be gone; two writers means two verdicts');
  });

  /* ---------------- what the daemon DOES with each verdict ---------------- */
  function makeCore() {
    const { BotCore } = require(path.join(ROOT, 'src', 'core.js'));
    const { loadConfig } = require(path.join(ROOT, 'src', 'config.js'));
    const cfg = loadConfig([]);
    cfg.logging = { level: 'error', file: null, jsonl: null, statusFile: null };
    cfg.reconnect = { enabled: true, initialDelayMs: 10, maxDelayMs: 40, multiplier: 1.5, jitterMs: 5, maxAttempts: 3 };
    const logs = [];
    const core = new BotCore({
      config: cfg, demo: true,
      logger: { on: () => {}, info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]),
                error: (m) => logs.push(['error', m]), debug: () => {}, status: () => {}, level: 'error' }
      , ipcPath: path.join(ROOT, 'run', 'vp-test-' + process.pid + '.sock')
    });
    return { core, logs };
  }
  function teardown(core) {
    core.shuttingDown = true;
    for (const t of core.killTimers || []) { try { clearInterval(t); clearTimeout(t); } catch (_) {} }
    if (core.reconnectTimer) { clearTimeout(core.reconnectTimer); core.reconnectTimer = null; }
  }

  test('a stopped server is waited out and NEVER spends the give-up budget', () => {
    // The bug this pins: an AFK bot is supposed to keep an empty Aternos server
    // awake, but the server sleeps first (~6 min empty). With a single give-up
    // ceiling, a daemon waiting for a sleeping server would eventually exit, and
    // then nothing would be left to wake it - the bot defeats its own purpose.
    const { core, logs } = makeCore();
    for (let i = 0; i < 10; i++) {
      core.reconnectTimer = null;
      core.scheduleReconnect('server is stopped (ping protocol -1)', { waitIndefinitely: true });
      if (core.reconnectTimer) clearTimeout(core.reconnectTimer);
      core.reconnectTimer = null;
    }
    assert.ok(logs.every(l => !/giving up|never spawned/i.test(l[1])),
      'a patient wait must never reach the give-up verdict');
    assert.strictEqual(core.reconnectAttempts, 0,
      'waiting must not increment the attempt counter that the ceiling measures');
    assert.notStrictEqual(core.stats.state, 'giving_up');
    assert.strictEqual(core.stats.state, 'waiting_for_server');
    teardown(core);
  });

  test('connect() wires the stopped verdict to the patient wait', () => {
    // Without this, only the two ends of the chain are tested: decideProbeAction
    // returns 'stopped', and scheduleReconnect behaves when it is told so. The
    // middle - connect() passing the flag - was untested, and a mutation that
    // simply dropped the second argument left the whole suite green while the
    // daemon silently went back to spending budget on a sleeping server.
    const src = require('fs').readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    assert.match(src, /decision\.kind === 'stopped'/, 'connect() must branch on the verdict');
    // Note the [\s\S] spans: the call wraps onto a second line AND contains a
    // ')' inside its own string argument ("ping protocol -1"), so a [^)]* pattern
    // cannot match it no matter what the source says.
    assert.match(src, /scheduleReconnect\([\s\S]{0,160}?\{[\s\S]{0,40}?waitIndefinitely: true[\s\S]{0,40}?\)/,
      'the stopped branch must pass waitIndefinitely, or the exemption never applies');
    // and the unsupported branch must NOT - it is the case that has to stop
    // Match the branch by indentation-aware boundaries rather than an exact
    // closing-brace column: the earlier /return;\n }/ pattern only passed on a
    // differently indented file and failed on the real one.
    const stopped = src.match(/if \(decision\.kind === 'stopped'\)[\s\S]*?return;\n\s*\}/);
    assert.ok(stopped, 'connect() must have a self-contained stopped branch ending in return');
    assert.match(stopped[0], /waitIndefinitely: true/,
      'and that branch must pass the exemption flag');
    assert.ok(!/versionFatal = true/.test(stopped[0]),
      'a stopped server must not be marked fatal - that is the bug this whole path fixes');
    // the unsupported branch, by contrast, must still be the fatal one
    const unsup = src.match(/if \(decision\.kind === 'unsupported'\)[\s\S]*?return;\n\s*\}/);
    assert.ok(unsup && /versionFatal = true/.test(unsup[0]),
      'a genuinely unsupported version must still stop the run');
  });

  test('an unreachable server still hits the give-up ceiling', () => {
    // The other side of the line: a wrong address that never answers a ping must
    // still stop, or we are back to 694 connects in 24 hours. Only the proxy
    // explicitly saying "Offline" is exempt.
    const { core } = makeCore();
    for (let i = 0; i < 6; i++) {
      core.reconnectTimer = null;
      core.scheduleReconnect('socketClosed');
      if (core.reconnectTimer) clearTimeout(core.reconnectTimer);
      core.reconnectTimer = null;
    }
    assert.strictEqual(core.stats.state, 'giving_up',
      'a never-spawning unreachable target must still give up');
    teardown(core);
  });

  test('the probe is the sole arbiter — no second "unsupported" path on BotCore', () => {
    // Structural check: the class must not let bot.on('error') overrule a
    // supported probe. We assert the error handler reads _probeDecision.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    assert.ok(src.includes('_probeDecision'),
      'connect() must record a probe decision the error handler can defer to');
    // and the probe must run on EVERY connect, not just the first
    assert.ok(!/_probed/.test(src.replace(/_probeDecision|_probeAt/g, '')),
      'connect() must not gate the probe on a once-per-daemon _probed flag');
  });
}

module.exports = { register };
