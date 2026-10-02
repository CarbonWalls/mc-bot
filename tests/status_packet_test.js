/**
 * Status-packet decoding: the bug that made the version gate never fire.
 *
 * The daemon's pre-flight ping is documented as the SOLE arbiter of "this server
 * runs a version we cannot speak". It was silently returning `null` for
 * essentially every real server, which means the gate that exists to prevent
 * reconnect-looping never ran. A captured response from 4of5.aternos.me is stored
 * at tests/fixtures/status_response_4of5.bin and is the evidence for all of this.
 *
 * The cause was one line:
 *
 *     const jsonLen = payload[1];   // "0x00 id, then varint string length"
 *
 * The comment assumed the string length fits in one byte. It is a VARINT, and the
 * server encodes it in two bytes as soon as the JSON exceeds 127 bytes - which
 * every real status MOTD does. On the captured bytes the length is 1675 encoded
 * `8b 0d`; reading one byte gives 0x8b = 139, so the slice ends mid-string,
 * JSON.parse throws, probeServer resolves null, and the daemon proceeds to a
 * handshake it should have refused outright.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { parseStatusPacket, readVarint, serverVersionKnown } = require(path.join(ROOT, 'src', 'core.js'));

const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'status_response_4of5.bin');

/** Encode a varint the way the protocol does, for building synthetic packets. */
function encVarint(n) {
  const bytes = [];
  let v = n >>> 0;
  for (;;) {
    const b = v & 0x7F;
    v >>>= 7;
    if (v === 0) { bytes.push(b); break; }
    bytes.push(b | 0x80);
  }
  return Buffer.from(bytes);
}

/** Build a complete status-response packet from a JSON string. */
function buildPacket(jsonStr) {
  const json = Buffer.from(jsonStr, 'utf8');
  const body = Buffer.concat([encVarint(0), encVarint(json.length), json]);
  return Buffer.concat([encVarint(body.length), body]);
}

function register({ test }) {

  test('the captured real status response decodes (regression: single-byte length)', () => {
    assert.ok(fs.existsSync(FIXTURE), 'fixture missing - re-record with tools/record_status.js');
    const buf = fs.readFileSync(FIXTURE);
    const parsed = parseStatusPacket(buf);
    assert.ok(parsed, 'a complete packet must parse, not return null');
    // The exact values probe.py reported for this server.
    assert.strictEqual(parsed.version.name, 'Paper 26.2');
    assert.strictEqual(parsed.version.protocol, 776);
    assert.strictEqual(parsed.players.online, 2);
  });

  test('every captured fixture decodes (not overfitted to one server)', () => {
    // Two servers, two byte layouts, one decoder. A test pinned to a single
    // capture can pass on an accident of that one response's framing, which is
    // how the original single-byte length bug survived every synthetic packet:
    // the fakes were all small enough to fit in one length byte.
    const dir = path.join(ROOT, 'tests', 'fixtures');
    const files = fs.readdirSync(dir).filter(f => /^status_response_.*\.bin$/.test(f));
    assert.ok(files.length >= 1, 'no fixtures recorded - run: node tools/record_status.js <host> <port> <name>');
    let sawWide = 0;
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      const p = parseStatusPacket(buf);
      assert.ok(p && p.version, `${f} must decode to an object with a version`);
      assert.ok(typeof p.version.protocol === 'number', `${f}: protocol must be a number`);
      assert.ok(p.version.name, `${f}: version name must be present`);
      // the property that makes these fixtures worth keeping: the JSON length
      // needs a multi-byte varint, which is exactly what broke the old reader
      const pkt = readVarint(buf, 0);
      const body = buf.slice(pkt.next, pkt.next + pkt.value);
      const id = readVarint(body, 0);
      const len = readVarint(body, id.next);
      assert.ok(len.value > 127, `${f}: JSON length ${len.value} is not >127 - this fixture would not exercise the bug`);
      assert.ok(body[id.next] !== len.value, `${f}: the first length byte must differ from the true length`);
      sawWide++;
    }
    assert.ok(sawWide >= 2,
      `expected fixtures from at least 2 servers to prove generality, got ${sawWide}`);
  });

  test('the old single-byte read would have failed on these same bytes', () => {
    // Pins the *cause*, so nobody "simplifies" the varint reader back down.
    const buf = fs.readFileSync(FIXTURE);
    const pkt = readVarint(buf, 0);
    const body = buf.slice(pkt.next, pkt.next + pkt.value);
    const id = readVarint(body, 0);
    const len = readVarint(body, id.next);
    assert.ok(len.value > 127,
      `this fixture is only meaningful if the JSON length needs 2+ varint bytes (got ${len.value})`);
    const oneByte = body[id.next];           // what the buggy code read
    assert.notStrictEqual(oneByte, len.value, 'the single-byte read must genuinely differ');
    // and the truncation it produced really is un-parseable
    assert.throws(() => JSON.parse(body.slice(id.next + 1, id.next + 1 + oneByte).toString('utf8')),
      /JSON|Unexpected|Unterminated/, 'truncated JSON must throw, which is how the bug surfaced as null');
  });

  test('an incomplete buffer asks for more bytes instead of failing', () => {
    const buf = fs.readFileSync(FIXTURE);
    assert.strictEqual(parseStatusPacket(buf.slice(0, 1)), 'need-more');
    assert.strictEqual(parseStatusPacket(buf.slice(0, 10)), 'need-more');
    assert.strictEqual(parseStatusPacket(Buffer.alloc(0)), 'need-more');
    // one byte short of the declared length is still need-more, not a parse error
    const pkt = readVarint(buf, 0);
    assert.strictEqual(parseStatusPacket(buf.slice(0, pkt.next + pkt.value - 1)), 'need-more');
    // and the full buffer is not
    assert.notStrictEqual(parseStatusPacket(buf), 'need-more');
  });

  test('a short MOTD (one-byte length) still decodes', () => {
    // The original code worked here, which is why the bug survived: small status
    // payloads (a proxy placeholder, an empty MOTD) fit in one length byte.
    const small = buildPacket(JSON.stringify({ version: { name: '1.21', protocol: 767 } }));
    const p = parseStatusPacket(small);
    assert.strictEqual(p.version.protocol, 767);
    assert.ok(small[readVarint(small, 0).next + 1] < 0x80, 'this packet uses a 1-byte length');
  });

  test('a 128-byte boundary JSON decodes (the exact cliff the bug fell off)', () => {
    for (const size of [120, 127, 128, 129, 200, 5000]) {
      const json = JSON.stringify({ version: { name: 'X', protocol: 775 }, pad: 'a'.repeat(size) });
      const p = parseStatusPacket(buildPacket(json));
      assert.ok(p, `JSON of ${json.length} bytes must decode`);
      assert.strictEqual(p.protocol_or_name || p.version.name, 'X');
    }
  });

  test('garbage and hostile packets are rejected, not crashed on', () => {
    // 0xff*4 + 0x7f decodes to 4,294,967,295: a legal varint that declares 4 GB.
    // It must be refused by the size bound, not buffered forever waiting for bytes
    // that will never arrive - an unbounded wait would hang the pre-flight probe
    // and the daemon would never connect again.
    assert.strictEqual(parseStatusPacket(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7f])), null,
      'a huge declared length must be refused, not waited on');
    // A complete packet whose declared body is too short to hold a length varint
    // + JSON: must be null (rejected), not 'need-more' (which would hang the probe
    // waiting for bytes that have all arrived).
    assert.strictEqual(parseStatusPacket(Buffer.from([0x05, 0x00, 0x00, 0x7b, 0x00, 0x00])), null, 'complete but malformed body');
    // and a genuinely truncated stream MUST stay 'need-more' rather than be rejected
    assert.strictEqual(parseStatusPacket(Buffer.from([0x40, 0x00, 0x20, 0x7b])), 'need-more', 'half a packet is not garbage');
    assert.strictEqual(parseStatusPacket(buildPacket('not json at all')), null);
    assert.strictEqual(parseStatusPacket(Buffer.from([0x00, 0x00])), null, 'zero length packet');
  });

  test('readVarint round-trips every varint width, including the 5-byte edge', () => {
    // Two separate arithmetic traps in one loop, both found by testing the
    // boundaries rather than a happy path:
    //   1. `|=` / `<<` coerce to int32, so a legal top group (0x7F at shift 28 =
    //      34,091,302,912) is read as 4,026,531,840 - high bits silently gone.
    //   2. A "shift > 28" guard placed BEFORE the continuation-bit check rejects
    //      the legitimate 5-byte encoding 80 80 80 80 01 = 268,435,456, because
    //      by the time the terminating byte is seen the shift counter is 35.
    // The second one was in the fix for the first, which is exactly why every
    // width needs a case, not just the widest.
    const enc = (n) => {
      const b = []; let v = n >>> 0;
      for (;;) { const x = v & 0x7F; v >>>= 7; if (!v) { b.push(x); break; } b.push(x | 0x80); }
      return Buffer.from(b);
    };
    for (const n of [0, 1, 127, 128, 255, 16383, 16384, 2097151, 2097152,
                     268435455, 268435456, 268435457, 0x7fffffff, 0xffffffff]) {
      const e = enc(n);
      assert.ok(e.length <= 5, `${n} must encode in at most 5 bytes (got ${e.length})`);
      const v = readVarint(e, 0);
      assert.ok(v, `readVarint(${n}) returned null - a legal varint was rejected`);
      assert.ok(Number.isFinite(v.value), `readVarint(${n}) produced NaN`);
      assert.strictEqual(v.value, n >>> 0, `round-trip failed for ${n} (${[...e].map(x => x.toString(16)).join(' ')})`);
      assert.strictEqual(v.next, e.length);
    }
    // the out-of-range case: 0x7F at shift 28 is 34,091,302,912, which is not a
    // legal protocol varint. Masking it to 4,026,531,840 would hand a hostile
    // length back to the caller looking legitimate, so it is reported NaN.
    const wide = readVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x7f]), 0);
    assert.ok(wide && Number.isNaN(wide.value),
      `an out-of-range varint must be NaN, got ${JSON.stringify(wide)}`);
    // and parseStatusPacket refuses to trust it at all
    assert.strictEqual(parseStatusPacket(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7f])), null,
      'a length that cannot be real must be rejected, not waited on');
  });

  test('an over-long varint is refused rather than trusted', () => {
    // Six continuation bytes is not a valid protocol varint. It must not be read
    // as a number (which would then index a buffer) and must not throw.
    const six = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    const v = readVarint(six, 0);
    assert.ok(v === null || !Number.isFinite(v.value) || v.value === 0,
      `over-long varint accepted as ${JSON.stringify(v)}`);
  });

  test('the decoded protocol feeds the version gate correctly', () => {
    // End to end: fixture -> protocol number -> serverVersionKnown, which is the
    // decision the whole probe exists to make.
    const parsed = parseStatusPacket(fs.readFileSync(FIXTURE));
    const verdict = serverVersionKnown(parsed.version.protocol);
    assert.strictEqual(verdict.ok, false,
      '26.2 (776) must be reported unsupported - this is the case the gate must catch');
    // and a joinable server from the same code path
    const joinable = buildPacket(JSON.stringify({ version: { name: 'Paper 1.21.11', protocol: 774 }, players: { online: 0, max: 20 } }));
    const j = parseStatusPacket(joinable);
    assert.strictEqual(serverVersionKnown(j.version.protocol).ok, true, '1.21.11 (774) must be joinable');
  });

  test('the probe path is exercised, not just the parser', () => {
    // The daemon must actually route probe results into the unsupported-version
    // decision, otherwise a correct parser is still dead code.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    assert.match(src, /const parsed = parseStatusPacket\(buf\)/, 'probeServer must use the shared parser');
    assert.match(src, /if \(parsed === 'need-more'\) return/, 'incomplete packets must keep waiting');
    // The verdict now comes from a pure function so it can be unit-tested; the
    // wiring that matters is that connect() calls it with the real gate and acts
    // on every branch.
    assert.match(src, /decideProbeAction\(version, serverVersionKnown\)/, 'the verdict must reach the gate');
    assert.match(src, /if \(decision\.kind === 'stopped'\)/, 'stopped must wait, not quit');
    assert.match(src, /if \(decision\.kind === 'unsupported'\)/, 'unsupported must be fatal');
    assert.match(src, /core\.versionFatal = true/, 'the fatal flag must actually be set on unsupported');
  });
}

module.exports = { register, buildPacket, encVarint };
