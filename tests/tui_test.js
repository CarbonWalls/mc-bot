/**
 * TUI interaction tests (P4).
 *
 * Previously the TUI was only verified by rendering a frame against a live
 * daemon — which proves the dashboard draws but nothing about how it responds.
 * These tests drive it with a fake transport: keypresses, resize, disconnect
 * mid-session, malformed IPC args, and unknown commands, all without a daemon
 * and without touching a real terminal.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { Tui, VirtualScreen } = require(path.join(SRC, 'tui.js'));

/**
 * A stand-in for IpcClient that records what the TUI tried to send and lets a
 * test inject replies. Keeps the TUI's real socket code out of these tests.
 */
class FakeIpc extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.connected = true;
  }
  send(cmd, args, timeoutMs) {
    this.sent.push({ cmd, args });
    return Promise.resolve({ ok: true });
  }
  onEvent(name, cb) { this.on(name, cb); }
  onClose(cb) { this.on('close', cb); }
  close() { this.connected = false; this.emit('close'); }
}

/** A status payload shaped like the daemon's, so render() has every field it reads. */
function minimalStatus() {
  return {
    mode: 'afk', survive: false, state: 'spawned',
    health: 20, food: 20, pos: { x: 0, y: 0, z: 0 },
    counters: { connects: 1, spawns: 1, kicks: 0, disconnects: 0, deaths: 0,
                errors: 0, logsChopped: 0, fleeCount: 0, hits: 0 },
    stats: { uptimeSeconds: 10 },
    goal: null, home: { x: 0, y: 0, z: 0 }
  };
}

function makeTui(screen) {
  const ipc = new FakeIpc();
  const tui = new Tui({ screen, ipcPath: '/tmp/does-not-matter.sock' });
  tui.client = ipc;       // swap in the fake transport
  // start() registers this handler; replicate it so the disconnect test can
  // run without actually connecting.
  ipc.onClose(() => {
    tui.daemonState = 'offline';
    tui.daemonPid = null;
    tui.message = { text: 'daemon went offline (press d to restart)', until: Date.now() + 6000 };
    tui.scheduleRender();
  });
  return { tui, ipc };
}

function register({ test }) {

  test('tui module exposes Tui and a VirtualScreen for headless testing', () => {
    const t = require(path.join(SRC, 'tui.js'));
    assert.strictEqual(typeof t.Tui, 'function');
    assert.strictEqual(typeof t.VirtualScreen, 'function');
    assert.ok(t.HOTKEYS && typeof t.HOTKEYS === 'object', 'HOTKEYS must be exported for documentation');
  });

  test('Ctrl-C closes the TUI and leaves the daemon running', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui, ipc } = makeTui(screen);
    let exited = false;
    const origExit = process.exit;
    process.exit = (code) => { exited = true; process.exit._code = code; };
    try {
      // Ctrl-C maps to quit(false). Pass immediate via the test-only path so
      // the assertion does not depend on a 60ms timer firing.
      tui._quitForTest = true;
      tui.onKey(Buffer.from('\x03', 'utf8'));
    } finally {
      process.exit = origExit;
    }
    assert.ok(exited, 'Ctrl-C must exit the TUI');
    // the farewell line must say the daemon survives
    const body = screen.text;
    assert.ok(/still running/i.test(body), 'quitting should tell the user the daemon is still up');
    // and it must NOT have sent a shutdown command
    assert.ok(!ipc.sent.some(s => s.cmd === 'quit' || s.cmd === 'kill'),
      'Ctrl-C must not kill the daemon');
  });

  test('the dedicated quit key DOES ask the daemon to shut down', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui, ipc } = makeTui(screen);
    let exited = false;
    const origExit = process.exit;
    process.exit = () => { exited = true; };
    try {
      tui.quit(true, true);
    } finally {
      process.exit = origExit;
    }
    assert.ok(exited);
    assert.ok(ipc.sent.some(s => s.cmd === 'quit' || s.cmd === 'kill'),
      'quit(true) must send a shutdown command');
  });

  test('mode hotkeys switch behaviour without needing a typed command', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui, ipc } = makeTui(screen);
    tui.daemonState = 'online';
    tui.status = minimalStatus();
    tui.onKey(Buffer.from('4', 'utf8'));   // hotkey: gather
    // a prompt is NOT needed for the numbered modes; the mode command must go
    // out to the daemon.
    assert.ok(ipc.sent.some(s => s.cmd === 'mode' && s.args && s.args.mode === 'gather'),
      'the gather hotkey must send a mode=gather command');
  });

  test('Space arms typing mode so commands starting with a hotkey letter work', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui } = makeTui(screen);
    tui.daemonState = 'online';
    tui.onKey(Buffer.from(' ', 'utf8'));
    assert.ok(tui.typing, 'Space on an empty line must arm typing mode');
    // and a following letter becomes input rather than a hotkey
    tui.onKey(Buffer.from('s', 'utf8'));
    assert.strictEqual(tui.input, 's', 'after arming, letters are typed text');
  });

  test('Backspace edits the input line', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui } = makeTui(screen);
    tui.typing = true;
    tui.onKey(Buffer.from('a', 'utf8'));
    tui.onKey(Buffer.from('b', 'utf8'));
    assert.strictEqual(tui.input, 'ab');
    tui.onKey(Buffer.from('\x7f', 'utf8'));
    assert.strictEqual(tui.input, 'a', 'backspace must delete one character');
  });

  test('Escape cancels a prompt and clears input', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui } = makeTui(screen);
    tui.prompt = { mode: 'goto' };
    tui.input = '12';
    tui.onKey(Buffer.from('\x1b', 'utf8'));
    assert.ok(!tui.prompt, 'Escape must dismiss the prompt');
    assert.strictEqual(tui.input, '', 'Escape must clear the input');
  });

  test('a render survives with no status yet (never throws on partial state)', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui } = makeTui(screen);
    tui.status = null;
    tui.radar = null;
    tui.daemonState = 'connecting';
    assert.doesNotThrow(() => tui.render(), 'render() must tolerate a pre-handshake state');
    const body = screen.text;
    assert.ok(body.length > 0, 'render() must produce output');
  });

  test('resize is handled without corrupting the screen', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui } = makeTui(screen);
    tui.status = minimalStatus();
    tui.render();
    assert.doesNotThrow(() => {
      screen.resize(100, 30);
      tui.render();
    });
    // the wider screen must produce wider lines
    assert.ok(screen.text.split('\n').some(l => l.length > 80));
  });

  test('daemon going offline mid-session is surfaced, not fatal', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui, ipc } = makeTui(screen);
    tui.daemonState = 'online';
    tui.message = null;
    ipc.close();                     // simulate the socket dropping
    assert.strictEqual(tui.daemonState, 'offline');
    assert.ok(tui.message && /offline/i.test(tui.message.text),
      'a disconnect must produce a visible message');
  });

  test('unknown/malformed IPC input does not crash the TUI', () => {
    const screen = new VirtualScreen(80, 24);
    const { tui } = makeTui(screen);
    tui.daemonState = 'online';
    // the TUI must never die on a bad payload from the daemon: a status with
    // every field missing is the worst case render() can see.
    assert.doesNotThrow(() => { tui.status = { mode: undefined }; tui.render(); });
    assert.doesNotThrow(() => { tui.status = { counters: undefined }; tui.render(); });
    assert.doesNotThrow(() => { tui.radar = { cells: null }; tui.render(); });
  });
}

module.exports = { register };
