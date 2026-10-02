#!/usr/bin/env node
'use strict';

/**
 * Re-record a raw status-response packet to tests/fixtures/.
 *
 * tests/status_packet_test.js is pinned to real bytes captured from a live
 * Aternos server, because the bug it guards (a status JSON length that needs two
 * varint bytes, not one) was invisible to every synthetic packet small enough to
 * fit in one. That fixture cannot be re-created by hand, so this is the tool the
 * test's failure message points at.
 *
 *   node tools/record_status.js <host> <port> [name]
 *   node tools/record_status.js betahhd.aternos.me 49851 betahhd
 *
 * It performs exactly one read-only status handshake - the same two packets
 * src/probe.py sends - and writes the raw response bytes. Nothing is decoded
 * here beyond a sanity check, because the point of the fixture is the bytes, not
 * an interpretation of them.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tests', 'fixtures');

function varint(n) {
  const bytes = [];
  let v = n >>> 0;
  for (;;) {
    const b = v & 0x7F;
    v >>>= 7;
    if (!v) { bytes.push(b); break; }
    bytes.push(b | 0x80);
  }
  return Buffer.from(bytes);
}

function record(host, port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const socket = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      // A proxy that accepts and then goes quiet is itself a result worth
      // knowing about, but it is not a packet we can pin a test to.
      reject(new Error(buf.length ? 'timed out with a partial packet' : 'timed out with no response'));
    }, timeoutMs);
    socket.on('error', (e) => { clearTimeout(timer); socket.destroy(); reject(e); });
    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const handshake = Buffer.concat([
        varint(0x00),
        varint(-1),                          // protocol -1: "just the status"
        varint(hostBuf.length), hostBuf,
        Buffer.from([(port >> 8) & 0xFF, port & 0xFF]),
        varint(1)                            // next state: status
      ]);
      socket.write(Buffer.concat([varint(handshake.length), handshake]));
      socket.write(Buffer.from([0x01, 0x00]));   // status request
    });
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // Ask core whether the buffer is a complete packet, so this tool uses the
      // same parser the daemon does rather than a second, diverging copy.
      const { parseStatusPacket } = require(path.join(ROOT, 'src', 'core.js'));
      const parsed = parseStatusPacket(buf);
      if (parsed === 'need-more') return;
      if (!parsed) { clearTimeout(timer); socket.destroy(); reject(new Error('response did not parse as a status packet')); return; }
      clearTimeout(timer);
      socket.destroy();
      resolve({ buf, parsed });
    });
  });
}

async function main() {
  const [host, portArg, name] = process.argv.slice(2);
  if (!host || !portArg) {
    console.error('usage: node tools/record_status.js <host> <port> [fixture-name]');
    process.exit(2);
  }
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`bad port: ${portArg}`);
    process.exit(2);
  }
  console.log(`pinging ${host}:${port} ...`);
  let out;
  try {
    out = await record(host, port);
  } catch (e) {
    console.error(`failed: ${e.message}`);
    console.error('the server may be stopped (Aternos sleeps an empty box) - start it, or run: node bin/mc.js targets');
    process.exit(1);
  }
  const v = out.parsed.version || {};
  console.log(`  version ${v.name} (protocol ${v.protocol}), players ${out.parsed.players && out.parsed.players.online}/${out.parsed.players && out.parsed.players.max}`);
  const jsonLen = Buffer.byteLength(JSON.stringify(out.parsed));
  console.log(`  ${out.buf.length} raw bytes; JSON length ${jsonLen} ${jsonLen > 127 ? '(>127, so its varint is 2+ bytes: the case the test needs)' : '(<=127: a 1-byte length, which would NOT exercise the bug)'}`);
  const slug = (name || host).replace(/[^A-Za-z0-9._-]+/g, '_');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `status_response_${slug}.bin`);
  fs.writeFileSync(file, out.buf);
  console.log(`  wrote ${path.relative(ROOT, file)}`);
  if (slug !== '4of5') {
    console.log('\nNote: status_packet_test.js is pinned to status_response_4of5.bin.');
    console.log('To pin a new fixture, point the test at it deliberately - do not');
    console.log('overwrite the captured bytes just because a newer one exists.');
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { record };
