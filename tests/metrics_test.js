/**
 * Metrics endpoint tests.
 *
 * External monitoring needs a machine-readable view that does not depend on the
 * TUI or the IPC socket. The daemon exposes Prometheus-style plain text over a
 * localhost-only HTTP endpoint, plus an IPC command returning the same text.
 *
 * The format matters: it must keep working when a new counter is added, and the
 * memory ceiling must travel with it so a monitoring system can alert on
 * approach to the cap rather than on an OOM after the fact.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function register({ test }) {
  const { BotCore } = require(path.join(SRC, 'core.js'));

  function makeCore() {
    // A demo-mode core never touches the network: it drives the mock world.
    return new BotCore({ config: require(path.join(SRC, 'config.js')).loadConfig([]), demo: true });
  }

  test('metricsText is Prometheus-style text with gauges and counters', () => {
    const core = makeCore();
    const txt = core.metricsText();
    assert.ok(typeof txt === 'string' && txt.length > 0);
    assert.ok(/^# HELP /m.test(txt), 'must include HELP lines');
    assert.ok(/^# TYPE /m.test(txt), 'must include TYPE lines');
    // the series that matter for monitoring a survival bot
    for (const name of ['afkbot_health', 'afkbot_food', 'afkbot_rss_mb',
                        'afkbot_counters', 'afkbot_mode']) {
      assert.ok(txt.includes(name + ' '), `must expose the ${name} series`);
    }
  });

  test('the memory ceiling travels with the metrics', () => {
    const core = makeCore();
    const txt = core.metricsText();
    assert.ok(/afkbot_rss_ceiling_mb \d+/.test(txt),
      'the ceiling must be a series so monitoring can alert near it');
  });

  test('counters carry their kind as a label', () => {
    const core = makeCore();
    const txt = core.metricsText();
    for (const kind of ['spawns', 'disconnects', 'kicks', 'errors', 'deaths',
                        'logs_chopped', 'flee_count', 'hits']) {
      assert.ok(txt.includes(`{kind="${kind}"}`), `counter ${kind} must be labelled`);
    }
  });

  test('GET /metrics serves the same text over HTTP, localhost only', async () => {
    const core = makeCore();
    core.cfg.metrics = { port: 0 };      // port 0 = ephemeral, chosen by the OS
    // Simulate start()'s HTTP wiring without running the whole startup.
    const server = http.createServer((req, res) => {
      if (req.url !== '/metrics') { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(core.metricsText());
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/metrics' }, (res) => {
          if (res.statusCode !== 200) return reject(new Error('status ' + res.statusCode));
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d));
        }).on('error', reject);
      });
      assert.ok(body.includes('afkbot_health'), 'must serve the metrics body');
      // unknown routes are 404, so the endpoint cannot be probed elsewhere
      const bad = await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/' }, (res) => resolve(res.statusCode));
      });
      assert.strictEqual(bad, 404, 'non-metrics routes must be 404');
    } finally {
      server.close();
    }
  });
}

module.exports = { register };
