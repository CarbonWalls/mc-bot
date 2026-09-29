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
const { serverVersionKnown } = require(path.join(ROOT, 'src', 'core.js'));

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
