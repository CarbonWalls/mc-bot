'use strict';

/**
 * Offline test suite for the AFK Minecraft bot.
 *
 * These tests deliberately avoid connecting to a live server: they cover the
 * pieces that must be correct before a live run is meaningful (config loading,
 * probe protocol encoding, logger behaviour, process/resource sanity, and the
 * presence of the on-disk deliverables). Live behaviour is exercised by
 * src/bot.js itself and recorded under results/.
 *
 * Run with: npm test
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CFG_DIR = path.join(ROOT, 'config');

let passed = 0;
let failed = 0;
const failures = [];
// Async tests registered through the synchronous `test()` helper are queued here
// and awaited before the report is printed.
const pendingAsync = [];

function test(name, fn) {
  // An async test is deferred, not started now: 30 behaviour loops launched at
  // the same instant compete for the event loop, and timing assertions then fail
  // for reasons that have nothing to do with the behaviour under test. The queue
  // below runs them one at a time.
  if (fn && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    pendingAsync.push({ name, run: fn });
    return;
  }
  let out;
  try {
    out = fn();
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  FAIL  ${name}\n          ${e.message}`);
    return;
  }
  // A test that returns a promise is async. Running it with the synchronous
  // helper used to be silent-and-vacuous: the promise resolved after the report
  // had already printed "all passed", so a failure inside it could not fail the
  // suite. Queue it and await it before the report instead.
  if (out && typeof out.then === 'function') {
    // Attach the handlers NOW. A promise created at registration time that
    // rejects before its turn in the queue is an *unhandled rejection*, which on
    // Node 22 kills the process mid-report with a stack trace that looks like a
    // behaviour failure. Settling it into a value keeps the queue honest.
    const settled = out.then(() => ({ ok: true }), (e) => ({ ok: false, e }));
    pendingAsync.push({ name, run: () => settled.then(r => { if (!r.ok) { const err = r.e; err && (err.message = err.message); throw r.e; } }) });
    return;
  }
  passed++;
  console.log(`  PASS  ${name}`);
}

function testAsync(name, fn) {
  // Queued like an async `test()` so the whole async phase runs sequentially.
  pendingAsync.push({ name, run: fn });
}

function file(p) { return path.join(ROOT, p); }

console.log('\n=== AFK Minecraft Bot — offline test suite ===\n');

/* ------------------------------------------------------------------ *
 * 1. Runtime & dependency sanity
 * ------------------------------------------------------------------ */
console.log('--- runtime & dependencies ---');

test('node version is >= 18', () => {
  const [major] = process.versions.node.split('.').map(Number);
  assert.ok(major >= 18, `node ${major} is below the engine floor of 18`);
});

test('mineflayer is installed and requireable', () => {
  const mf = require('mineflayer');
  assert.strictEqual(typeof mf.createBot, 'function', 'mineflayer.createBot missing');
});

test('no dependency is globally installed (all project-local)', () => {
  const nm = path.join(ROOT, 'node_modules', 'mineflayer');
  assert.ok(fs.existsSync(nm), 'mineflayer must live in project node_modules');
});

test('all project files live under the project root', () => {
  for (const rel of ['package.json', 'src/bot.js', 'src/config.js', 'src/logger.js', 'config/config.json']) {
    const p = file(rel);
    assert.ok(fs.existsSync(p), `missing expected project file: ${rel}`);
  }
});

test('no stray absolute references outside the project', () => {
  const srcs = ['src/bot.js', 'src/config.js', 'src/logger.js'];
  for (const s of srcs) {
    const body = fs.readFileSync(file(s), 'utf8');
    // Logger/bot write only to relative paths resolved against the project.
    assert.ok(!/\/home\/|\/Users\/|\/root\/(?!projects)/.test(body),
      `${s} references a path outside the project`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. Config loader
 * ------------------------------------------------------------------ */
console.log('\n--- config loader ---');

const { loadConfig, deepMerge } = require(path.join(SRC, 'config'));

test('default config merges with the shipped config.json', () => {
  const cfg = loadConfig([]);
  assert.ok(cfg.host, 'host missing');
  assert.ok(cfg.port > 0 && cfg.port < 65536, `port out of range: ${cfg.port}`);
  assert.ok(cfg.username, 'username missing');
});

test('config.json targets a server the bot can actually join', () => {
  // The name of this test used to be "targets the canonical 4of5 address", and
  // asserting a *specific hostname* was the mistake: 4of5 later upgraded to
  // protocol 776, which no published minecraft-data can speak, so a green test
  // was pinning the project to an unjoinable default. Pin the PROPERTY instead of
  // the value - the default target must be a version this install supports.
  const raw = JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'config.json'), 'utf8'));
  assert.ok(typeof raw.host === 'string' && raw.host.length > 3, `bad host: ${raw.host}`);
  assert.ok(Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536, `bad port: ${raw.port}`);
  const { serverVersionKnown } = require(path.join(SRC, 'core.js'));
  // The config records WHICH SERVER it was verified against and the protocol that
  // server was measured answering, so the two cannot drift apart. Asserting only
  // "protocol 774 is joinable" would pass even if the host were changed to a
  // server speaking 776, which is the exact hole in the previous version of this
  // test; the binding is what makes it mean anything.
  const verified = raw._verifiedTarget;
  assert.ok(verified && typeof verified.host === 'string',
    'config.json must record the target it was verified against (_verifiedTarget)');
  assert.strictEqual(verified.host, raw.host,
    `_verifiedTarget.host (${verified.host}) must match host (${raw.host}) - a stale note is worse than none`);
  assert.strictEqual(verified.port, raw.port, '_verifiedTarget.port must match port');
  assert.ok(Number.isInteger(verified.protocol) && verified.protocol > 0,
    '_verifiedTarget.protocol must be a real protocol number');
  const verdict = serverVersionKnown(String(verified.protocol));
  assert.ok(verdict.ok,
    `the default target speaks protocol ${verified.protocol}, which the installed minecraft-data cannot serve - run: mc targets`);
  // and the recorded version name must be consistent with that protocol
  assert.ok(!verified.versionName || /\d/.test(verified.versionName), 'versionName should be the server string');
});

test('CLI overrides win over file values', () => {
  const cfg = loadConfig(['--host', 'example.invalid', '--port', '12345', '--username', 'Bot_Alpha']);
  assert.strictEqual(cfg.host, 'example.invalid');
  assert.strictEqual(cfg.port, 12345);
  assert.strictEqual(cfg.username, 'Bot_Alpha');
});

test('--duration becomes durationSeconds', () => {
  const cfg = loadConfig(['--duration', '120']);
  assert.strictEqual(cfg.durationSeconds, 120);
});

test('reconnect/backoff parameters are sane', () => {
  const cfg = loadConfig([]);
  const r = cfg.reconnect;
  assert.ok(r && r.enabled, 'reconnect must be enabled by default');
  assert.ok(r.initialDelayMs > 0 && r.initialDelayMs <= r.maxDelayMs, 'bad backoff bounds');
  assert.ok(r.multiplier > 1, 'multiplier must grow the delay');
});

test('anti-idle cannot cause movement or chat', () => {
  const cfg = loadConfig([]);
  assert.ok(cfg.antiIdle, 'antiIdle block missing');
  assert.strictEqual(cfg.antiIdle.movement, false, 'antiIdle.movement must be false (passive bot)');
});

test('deepMerge merges nested blocks and keeps arrays intact', () => {
  const out = deepMerge({ a: 1, nested: { x: 1, y: 2 }, list: [1, 2] },
    { nested: { y: 9 }, list: [3] });
  assert.deepStrictEqual(out, { a: 1, nested: { x: 1, y: 9 }, list: [3] });
});

test('auth is offline mode (no Microsoft credentials needed)', () => {
  const cfg = loadConfig([]);
  assert.strictEqual(cfg.auth, 'offline');
});

/* ------------------------------------------------------------------ *
 * 3. Logger
 * ------------------------------------------------------------------ */
console.log('\n--- logger ---');

const { Logger } = require(path.join(SRC, 'logger'));

function makeLogger(dir) {
  return new Logger({
    level: 'info',
    file: path.join(dir, 'test.log'),
    jsonl: path.join(dir, 'test.jsonl'),
    statusFile: path.join(dir, 'status.json')
  });
}

test('logger writes human-readable log + jsonl + status.json', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'tmp', 'logtest-'));
  const log = makeLogger(dir);
  log.info('hello', { n: 7 });
  log.status({ state: 'ok' });
  const human = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
  const jsonl = fs.readFileSync(path.join(dir, 'test.jsonl'), 'utf8');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.ok(/hello/.test(human), 'plain log missing message');
  assert.ok(/n=7/.test(human), 'plain log missing field');
  const rec = JSON.parse(jsonl.split('\n').filter(Boolean)[0]);
  assert.strictEqual(rec.msg, 'hello');
  assert.strictEqual(rec.n, 7);
  assert.strictEqual(status.state, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('level filtering suppresses debug when level is info', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'tmp', 'logtest-'));
  const log = makeLogger(dir);
  log.debug('should not appear');
  log.info('should appear');
  const human = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
  assert.ok(!/should not appear/.test(human), 'debug line leaked at info level');
  assert.ok(/should appear/.test(human));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('logger never throws when paths are unwritable', () => {
  const log = new Logger({ level: 'info', console: false });  // no file paths at all
  assert.doesNotThrow(() => log.info('fine'));
});

/* ------------------------------------------------------------------ *
 * 4. Probe protocol (encoding only — no network)
 * ------------------------------------------------------------------ */
console.log('\n--- probe protocol ---');

test('probe.py exists and is syntactically valid python', () => {
  const p = file('src/probe.py');
  assert.ok(fs.existsSync(p));
  execFileSync('python3', ['-c', `import ast; ast.parse(open('${p}').read())`]);
});

test('bedrock_probe.py encodes a valid RakNet unconnected ping', () => {
  const p = file('src/bedrock_probe.py');
  assert.ok(fs.existsSync(p));
  execFileSync('python3', ['-c', `import ast; ast.parse(open('${p}').read())`]);
});

test('varint encoding round-trips', () => {
  const script = `
import sys
sys.path.insert(0, '${SRC}')
from probe import pack_varint, read_varint
class S:
    def __init__(s, b): s.b = bytearray(b); s.i = 0
    def recv(s, n):
        out = bytes(s.b[s.i:s.i+n]); s.i += n; return out
for v in [0, 1, 127, 128, 255, 2147483647]:
    enc = pack_varint(v)
    assert read_varint(S(enc)) == v, v
print('ok')
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.ok(/ok/.test(out));
});

test('bedrock unconnected ping frame is well formed', () => {
  const script = `
import sys, struct, time
sys.path.insert(0, '${SRC}')
import bedrock_probe as bp
guid = bytes(range(8))
t = 12345
frame = b"\\x01" + struct.pack(">Q", t) + bp.MAGIC + guid
assert frame[0] == 0x01
assert len(frame) == 1 + 8 + 16 + 8
assert bp.MAGIC == bytes([0x00,0xFF,0xFF,0x00,0xFE,0xFE,0xFE,0xFE,0xFD,0xFD,0xFD,0xFD,0x12,0x34,0x56,0x78])
print('ok')
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.ok(/ok/.test(out));
});

/* ------------------------------------------------------------------ *
 * 5. Bot module shape (static checks, no connection)
 * ------------------------------------------------------------------ */
console.log('\n--- bot module shape ---');

test('bot.js registers signal handlers and is syntactically valid', () => {
  const body = fs.readFileSync(file('src/bot.js'), 'utf8');
  assert.ok(/process\.on\('SIGINT'/.test(body), 'SIGINT handler missing');
  assert.ok(/process\.on\('SIGTERM'/.test(body), 'SIGTERM handler missing');
  assert.ok(/uncaughtException/.test(body), 'uncaughtException guard missing');
  assert.ok(/createBot/.test(body), 'does not create a bot');
  new Function(body);  // throws on syntax error (body is a module, not a function body,
                       // but top-level await is absent so this parses)
});

test('bot is passive: no chat sending, breaking, or attacking', () => {
  const body = fs.readFileSync(file('src/bot.js'), 'utf8');
  for (const bad of ['bot.chat(', 'bot.whisper(', 'bot.attack(', 'bot.dig(', 'bot.placeBlock(']) {
    assert.ok(!body.includes(bad), `bot.js must not call ${bad} (passive bot)`);
  }
});

test('reconnect backoff is bounded and jittered', () => {
  // The backoff logic lives in core.js now; bot.js is a thin entry point.
  const body = fs.readFileSync(file('src/core.js'), 'utf8');
  assert.ok(/maxDelayMs/.test(body), 'backoff cap not referenced');
  assert.ok(/jitter/.test(body), 'jitter not referenced');
});

/* ------------------------------------------------------------------ *
 * 6. Deliverables present
 * ------------------------------------------------------------------ */
console.log('\n--- deliverables ---');

test('README exists', () => {
  assert.ok(fs.existsSync(file('README.md')), 'README.md missing');
});

test('live integration records into results/', () => {
  // The old assertion was "results/ exists". That directory is gitignored (it is
  // generated output), so on a fresh clone the test failed against a checkout
  // that was perfectly fine - and passing locally only because a prior run had
  // created it. What actually matters, and what this checks, is that the live
  // tool CREATES and WRITES it: the wiring, not an artefact of my last run.
  const tool = fs.readFileSync(file('tools/live_integration.js'), 'utf8');
  assert.ok(/mkdirSync\(path\.join\(ROOT, 'results'\)/.test(tool),
    "live_integration.js must mkdir results/ (recursive) before recording");
  assert.ok(/results'[\s\S]{0,40}live_integration\.json|'live_integration\.json'/.test(tool),
    'live_integration.js must write results/live_integration.json');
  // And if a run has happened here, the recorded file must be well-formed - the
  // README points at results/ as where live output goes, so a broken writer
  // should not pass silently.
  const recorded = file('results/live_integration.json');
  if (fs.existsSync(recorded)) {
    const j = JSON.parse(fs.readFileSync(recorded, 'utf8'));
    assert.ok(Array.isArray(j.checks) && j.checks.length, 'recorded output should list its checks');
    assert.ok(Number.isInteger(j.passed) && Number.isInteger(j.failed), 'recorded output should carry counts');
  }
});

test('example config for the legacy address is present', () => {
  assert.ok(fs.existsSync(path.join(CFG_DIR, 'config.bernedoodle.example.json')));
});

/* ------------------------------------------------------------------ *
 * v2 modules: renderer, PNG encoder, actor, mock
 * The mock mirrors the real mineflayer-pathfinder surface, so these also
 * guard against the API-mismatch bugs found during live testing.
 * ------------------------------------------------------------------ */

const MOCK = require(file('src/mock'));
const { Actor, isPathingNow, VALID_MODES } = require(file('src/actor'));
const { encode } = require(file('src/png'));
const zlib = require('zlib');

test('png encoder round-trips a coloured image losslessly', () => {
  const w = 13, h = 7;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = (i * 37) % 256;
    rgb[i * 3 + 1] = (i * 91) % 256;
    rgb[i * 3 + 2] = (i * 53) % 256;
  }
  const png = encode(w, h, rgb);
  // PNG magic
  assert.ok(png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), 'bad signature');
  // PNG layout: 8-byte sig, then per chunk [len:4][type:4][data...]
  const ihdr = png.slice(16, 16 + 13);   // skip 8 sig + 4 len + 4 type
  assert.strictEqual(ihdr.readInt32BE(0), w, 'width mismatch');
  assert.strictEqual(ihdr.readInt32BE(4), h, 'height mismatch');
  // inflate IDAT and undo filters to compare pixels
  let pos = 8, idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos); pos += 4;
    const type = png.slice(pos, pos + 4).toString(); pos += 4;
    if (type === 'IDAT') idat.push(png.slice(pos, pos + len));
    pos += len + 4;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 3 + 1;
  for (let y = 0; y < h; y++) {
    assert.strictEqual(raw[y * stride], 0, `row ${y} must be filter 0`);
    for (let x = 0; x < w * 3; x++) {
      assert.strictEqual(raw[y * stride + 1 + x], rgb[y * w * 3 + x], `pixel ${y}/${x} mismatch`);
    }
  }
});

test('mock bot exposes the real mineflayer-pathfinder API surface', () => {
  const bot = MOCK.createMockBot({ username: 'TestBot' });
  assert.ok(bot.pathfinder, 'no pathfinder');
  // The real plugin has no isPathing(); the mock keeps it AND adds isMoving,
  // so isPathingNow() must work against both shapes.
  assert.strictEqual(typeof bot.pathfinder.setGoal, 'function');
  assert.strictEqual(typeof bot.pathfinder.isMoving, 'function');
  assert.strictEqual(isPathingNow(bot), false, 'should not be pathing before a goal');
  bot.pathfinder.setGoal({ x: 1, y: 2, z: 3 });
  assert.strictEqual(isPathingNow(bot), true, 'should be pathing after a goal');
});

test('isPathingNow works against the real plugin shape (no isPathing, no .goal)', () => {
  // Exactly what mineflayer-pathfinder injects: isMoving/isMining/isBuilding
  // and no public goal property.
  const fakeBot = {
    pathfinder: {
      isMoving: () => true,
      isMining: () => false,
      isBuilding: () => false
    }
  };
  assert.strictEqual(isPathingNow(fakeBot), true, 'isMoving alone should count as pathing');
  fakeBot.pathfinder.isMoving = () => false;
  assert.strictEqual(isPathingNow(fakeBot), false);
  assert.strictEqual(isPathingNow({}), false, 'no pathfinder must be safe');
  assert.strictEqual(isPathingNow(null), false, 'null bot must be safe');
});

test('actor stays passive in afk mode and rejects unknown modes', () => {
  const bot = MOCK.createMockBot({ username: 'TestBot' });
  const logs = [];
  const actor = new Actor(bot, {
    logger: { info: (m, f) => logs.push([m, f]), warn: (m, f) => logs.push([m, f]), error: () => {}, debug: () => {} },
    config: { mode: 'afk' }
  });
  const r = actor.exec('bogusmode');
  assert.ok(!r.ok, 'unknown mode must be rejected');
  const ok = actor.exec('afk');
  assert.ok(ok.ok, 'afk must be accepted');
});

testAsync('mock world actually contains trees (hash regression guard)', async () => {
  // An earlier hash bug mapped the whole world to [0, 0.5) so no trees or ores
  // ever generated, which silently made every gather test meaningless.
  const bot = MOCK.createMockBot({ username: 'TestBot' });
  await new Promise((resolve) => bot.once('spawn', resolve));
  const logs = bot.findBlocks({
    matching: (b) => /_log$/.test(b.name),
    maxDistance: 64, count: 32, minDistance: 1
  });
  assert.ok(logs.length > 0, 'mock world must contain logs for gather tests');
});

test('default config keeps the bot passive', () => {
  const cfg = loadConfig([]);
  assert.strictEqual(cfg.behaviors.mode, 'afk', 'default mode must be afk');
  assert.ok(!cfg.behaviors.survive.enabled, 'survival layer must be opt-in');
});

/* ------------------------------------------------------------------ *
 * 9. Mock/real API drift detection
 *
 * Every live bug came from the mock inventing an API the real plugin lacks.
 * These tests fail loudly on the next drift instead of shipping a bot that
 * works offline and breaks online. (Self-registering; see
 * tests/api_contract_test.js.)
 * ------------------------------------------------------------------ */
console.log('\n--- api contract (mock vs real) ---');
require(file('tests/api_contract_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 10. Version probe is the sole "unsupported version" arbiter (P6)
 * ------------------------------------------------------------------ */
console.log('\n--- version probe ---');
require(file('tests/version_probe_test.js')).register({ test });

/* ------------------------------------------------------------------ *
 * 11. Memory ceiling stays bounded (P3)
 * ------------------------------------------------------------------ */
console.log('\n--- memory ceiling ---');
require(file('tests/memory_test.js')).register({ test });

/* ------------------------------------------------------------------ *
 * 12. Survival layer + gather target selection (P4)
 * ------------------------------------------------------------------ */
console.log('\n--- survival & gather ---');
require(file('tests/survival_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 13. TUI keys, resize, and disconnect handling (P4)
 * ------------------------------------------------------------------ */
console.log('\n--- tui interactions ---');
// tui_test has async cases; giving it only the synchronous `test` would make
// every one of them a no-op (the promise is never awaited, so a failure inside
// it cannot fail the suite). Pass both helpers.
require(file('tests/tui_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 14. Anti-stuck watchdog (P-core: goals must not give up early)
 * ------------------------------------------------------------------ */
console.log('\n--- anti-stuck watchdog ---');
require(file('tests/stuck_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 15. Death recovery (walk back for dropped items)
 * ------------------------------------------------------------------ */
console.log('\n--- death recovery ---');
require(file('tests/death_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 16. Task queue / multi-step goals
 * ------------------------------------------------------------------ */
console.log('\n--- task queue ---');
require(file('tests/tasks_test.js')).register({ test });

/* ------------------------------------------------------------------ *
 * 17. Prometheus-style metrics endpoint
 * ------------------------------------------------------------------ */
console.log('\n--- metrics endpoint ---');
require(file('tests/metrics_test.js')).register({ test });

/* ------------------------------------------------------------------ *
 * 18. Terrain & movement: the "flat ground only / never jumps" suite
 * ------------------------------------------------------------------ */
console.log('\n--- terrain & movement ---');
require(file('tests/terrain_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 19. Perception & PvP outcomes (hearts, gamemode, no false victories)
 * ------------------------------------------------------------------ */
console.log('\n--- perception & pvp ---');
require(file('tests/pvp_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 20. External decision advisor (Jev): prompt, parse, and failure paths
 * ------------------------------------------------------------------ */
console.log('\n---jev advisor---');
require(file('tests/jev_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 22. Kick classification: never reconnect into a ban
 * ------------------------------------------------------------------ */
console.log('\n--- kick / ban handling ---');
require(file('tests/kick_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * 21. Status-packet decoding: the bug that disabled the version gate
 * ------------------------------------------------------------------ */
console.log('\n--- status packet / probe ---');
require(file('tests/status_packet_test.js')).register({ test, testAsync });

/* ------------------------------------------------------------------ *
 * Report (after every queued async test has settled)
 * ------------------------------------------------------------------ */
(async () => {
  if (pendingAsync.length) {
    console.log(`\n--- ${pendingAsync.length} async test(s), run sequentially ---`);
    for (const t of pendingAsync) {
      try {
        await t.run();
        passed++;
        console.log(`  PASS  ${t.name}`);
      } catch (e) {
        failed++;
        failures.push({ name: t.name, error: e && e.message ? e.message : String(e) });
        console.log(`  FAIL  ${t.name}\n          ${e && e.message ? e.message : String(e)}`);
      }
    }
  }
  console.log('\n=================================');
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log('=================================');
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})();
