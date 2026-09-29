'use strict';

/**
 * Terminal dashboard for the bot.
 *
 * Attaches to the running daemon over the IPC socket and shows live state, a
 * top-down radar of the loaded world, the goal the bot is working on, a log
 * tail, and the last 360-degree panorama. Every key sends a real command to
 * the daemon, so this is the control surface for the behaviour engine.
 *
 *   node src/tui.js                # attach to (or start) the daemon
 *   node src/tui.js --demo         # offline demo world, no server needed
 *
 * Requires a real terminal (Termux, xterm, etc.). Truecolour is used when the
 * terminal advertises it, otherwise colours are quantised to the 256 palette.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { IpcClient } = require('./ipc');
const { loadConfig } = require('./config');

const PROJECT_ROOT = path.resolve(__dirname, '..');

/* ================================================================== *
 * terminal screen abstraction
 * ================================================================== */

class Screen {
  constructor(stream) {
    this.out = stream;
    this.rows = Math.max(8, stream.rows || 24);
    this.cols = Math.max(20, stream.columns || 80);
    this.truecolor = (stream.getColorDepth ? stream.getColorDepth() : 8) >= 24;
  }

  write(s) { this.out.write(s); }
  cursorTo(x, y) { this.out.write(`\x1b[${Math.max(1, y + 1)};${Math.max(1, x + 1)}H`); }
  clear() { this.out.write('\x1b[2J'); }
  clearLine() { this.out.write('\x1b[2K'); }

  enter() {
    this.out.write('\x1b[?1049h');   // alternate screen
    this.out.write('\x1b[?25l');     // hide cursor
    if (this.out.isTTY && process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); process.stdin.resume(); } catch (_) {}
    }
  }

  leave() {
    if (this.out.isTTY && process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch (_) {}
    }
    this.out.write('\x1b[?25h');
    this.out.write('\x1b[?1049l');
  }

  // colour escape; `bg` selects background
  color(r, g, b, bg) {
    if (this.truecolor) return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`;
    const q = (c) => Math.max(0, Math.min(5, Math.round(c / 51)));
    return `\x1b[${bg ? 48 : 38};5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m`;
  }

  resize() {
    this.rows = Math.max(8, this.out.rows || this.rows);
    this.cols = Math.max(20, this.out.columns || this.cols);
  }
}

/** In-memory screen for headless tests: same interface, captures output. */
class VirtualScreen extends Screen {
  constructor(cols = 90, rows = 34, truecolor = true) {
    super({ write() {}, getColorDepth: () => (truecolor ? 24 : 8) });
    this.cols = cols; this.rows = rows; this.truecolor = truecolor;
    this.buf = [];
  }
  write(s) { this.buf.push(s); }
  cursorTo() {}
  clear() { this.buf.push('\x1b[2J'); }
  clearLine() {}
  enter() {}
  leave() {}
  get text() { return this.buf.join(''); }
}

/* ================================================================== *
 * helpers
 * ================================================================== */

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function rgb(screen, c, bg) { return screen.color(c[0], c[1], c[2], bg); }

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function pad(s, n) {
  s = String(s);
  const visual = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (visual.length >= n) return s;
  return s + ' '.repeat(n - visual.length);
}

function trunc(s, n) {
  const visual = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (visual.length <= n) return s;
  let out = '', len = 0;
  for (const ch of [...s]) {
    if (ch === '\x1b') { out += ch; continue; }
    if (len >= n - 1) break;
    out += ch; len++;
  }
  return out + '…';
}

function fmtDur(sec) {
  if (sec == null) return '-';
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
    m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/* ================================================================== *
 * the dashboard
 * ================================================================== */

const HOTKEYS = [
  ['1', 'AFK'], ['2', 'Hold'], ['3', 'Wander'], ['4', 'Gather'],
  ['5', 'Come'], ['6', 'Follow'], ['7', 'Goto'], ['8', 'Attack'],
  ['s', 'Shot360'], ['r', 'Radar'], ['+/-', 'radius'], ['e', 'Eat'],
  ['f', 'Survive'], ['d', 'daemon'], ['?', 'Help'], ['q', 'Quit']
];

class Tui {
  constructor(opts = {}) {
    this.opts = opts;
    this.cfg = opts.config || loadConfig([]);
    this.screen = opts.screen || new Screen(process.stdout);
    this.ipcPath = opts.ipcPath || path.join(PROJECT_ROOT, 'run', 'bot.sock');
    this.client = new IpcClient();
    this.status = null;
    this.radar = null;
    this.shot = null;               // last panorama preview
    this.shotProgress = null;
    this.logs = [];
    this.input = '';
    this.typing = false;          // armed by pressing Space on an empty line
    this.inputHistory = [];
    this.inputHistoryIdx = -1;
    this.prompt = null;             // {label, cmd} when asking for arguments
    this.message = null;            // transient bottom message {text, until}
    this.radarOn = opts.radarOn !== false;
    this.radarRadius = (this.cfg.render && this.cfg.render.radarRadius) || 24;
    this.radarRadiusMax = (this.cfg.render && this.cfg.render.radarRadiusMax) || 96;
    this.overlay = null;            // 'shot' panorama viewer
    this.daemonPid = null;
    this.daemonState = 'connecting';  // connecting | online | offline
    this._renderQueued = false;
    this._shuttingDown = false;
    this._timers = [];
  }

  /* ---------------------------------------------------------------- */

  async start() {
    const s = this.screen;
    if (!process.stdout.isTTY && !(this.opts.screen instanceof VirtualScreen)) {
      process.stderr.write(
        'tui: needs a real terminal.\n' +
        'Run it in Termux / a terminal emulator, e.g.  node src/tui.js\n');
      process.exit(1);
    }
    s.enter();
    s.clear();
    this.message = { text: 'connecting to daemon…', until: Date.now() + 4000 };
    this.scheduleRender();

    await this.connectOrSpawnDaemon();

    // periodic polls: status 1s, radar 1.2s
    this._timers.push(setInterval(() => this.pollStatus(), 1000));
    this._timers.push(setInterval(() => { if (this.radarOn) this.pollRadar(); }, 1200));
    this._timers.push(setInterval(() => { if (this.shotProgress || this.daemonState === 'connecting') this.scheduleRender(); }, 400));

    if (process.stdin.isTTY) {
      process.stdin.on('data', (d) => this.onKey(d));
      process.stdin.on('error', () => {});
    }
    if (process.stdout.isTTY) {
      process.stdout.on('resize', () => { this.screen.resize(); this.scheduleRender(); });
    }
    process.on('SIGINT', () => { /* Ctrl-C handled in onKey */ this.quit(false); });
    process.on('SIGTERM', () => this.quit(false));

    this.pollStatus();
    if (this.radarOn) this.pollRadar();
    this.client.onClose(() => {
      this.daemonState = 'offline';
      this.daemonPid = null;
      this.message = { text: 'daemon went offline (press d to restart)', until: Date.now() + 6000 };
      this.scheduleRender();
    });
  }

  async connectOrSpawnDaemon() {
    try {
      await this.client.connect(this.ipcPath, 1500);
      this.daemonState = 'online';
      try {
        const st = await this.client.send('status', {}, 3000);
        this.daemonPid = st && st.pid;
      } catch (_) {}
      this.message = { text: 'attached to running daemon', until: Date.now() + 2500 };
      this.loadLogs();
      return;
    } catch (_) { /* not running: start it */ }

    if (this.opts.demo) {
      this.message = { text: 'starting demo daemon…', until: Date.now() + 6000 };
    } else {
      this.message = { text: 'daemon not running, starting it…', until: Date.now() + 6000 };
    }
    await this.spawnDaemon();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        await this.client.connect(this.ipcPath, 1500);
        this.daemonState = 'online';
        try { const st = await this.client.send('status', {}, 3000); this.daemonPid = st && st.pid; } catch (_) {}
        this.message = { text: 'daemon started', until: Date.now() + 2500 };
        this.loadLogs();
        return;
      } catch (_) {}
    }
    this.daemonState = 'offline';
    this.message = { text: 'could not reach daemon (press d to retry)', until: Date.now() + 8000 };
  }

  async spawnDaemon() {
    const args = [path.join(PROJECT_ROOT, 'src', 'bot.js')];
    for (const a of process.argv.slice(2)) if (a !== '--demo' && !a.startsWith('--screen')) args.push(a);
    if (this.opts.demo) args.push('--demo');
    const logDir = path.join(PROJECT_ROOT, 'logs');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
    const out = fs.openSync(path.join(logDir, 'daemon.log'), 'a');
    const err = fs.openSync(path.join(logDir, 'daemon.log'), 'a');
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', out, err]
    });
    this.daemonPid = child.pid;
    child.unref();
  }

  async loadLogs() {
    try {
      const r = await this.client.send('logs', { count: 120 }, 4000);
      if (r && Array.isArray(r.lines)) { this.logs = r.lines; this.scheduleRender(); }
    } catch (_) {}
  }

  async pollStatus() {
    if (!this.client.connected) return;
    try {
      this.status = await this.client.send('status', {}, 4000);
      this.daemonPid = this.status && this.status.pid;
      this.scheduleRender();
    } catch (e) {
      this.flash('status: ' + (e.message || e));
    }
  }

  async pollRadar() {
    if (!this.client.connected) return;
    const box = this.radarBox();
    if (!box) return;
    try {
      this.radar = await this.client.send('radar', {
        radius: this.radarRadius,
        previewW: Math.max(8, box.w - 2),
        previewH: Math.max(4, (box.h - 2) * 2)
      }, 8000);
      this.scheduleRender();
    } catch (e) {
      this.flash('radar: ' + (e.message || e));
    }
  }

  flash(text) {
    this.message = { text, until: Date.now() + 4000 };
    this.scheduleRender();
  }

  scheduleRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    setImmediate(() => { this._renderQueued = false; if (!this._shuttingDown) this.render(); });
  }

  /* ---------------------------------------------------------------- *
   * input
   * ---------------------------------------------------------------- */

  onKey(data) {
    const s = data.toString('utf8');
    // Ctrl-C / Ctrl-D: leave the TUI (daemon keeps running)
    if (s === '\x03' || s === '\x04') { this.quit(false); return; }

    if (this.overlay) {
      this.overlay = null;
      this.scheduleRender();
      return;
    }

    // escape: cancel prompt / clear input
    if (s === '\x1b' || s === '\x1b\x1b') {
      if (this.prompt) { this.prompt = null; this.input = ''; }
      else if (this.input) this.input = '';
      this.typing = false;
      this.scheduleRender();
      return;
    }

    if (s === '\r' || s === '\n') { this.submitInput(); return; }
    if (s === '\x7f' || s === '\x08') {
      if (this.input.length) this.input = [...this.input].slice(0, -1).join('');
      this.scheduleRender();
      return;
    }
    if (s === '\x1b[A') { // up: history
      if (this.inputHistory.length) {
        this.inputHistoryIdx = clamp(this.inputHistoryIdx + 1, 0, this.inputHistory.length - 1);
        this.input = this.inputHistory[this.inputHistory.length - 1 - this.inputHistoryIdx] || '';
        this.scheduleRender();
      }
      return;
    }
    if (s === '\x1b[B') { // down: history
      if (this.inputHistory.length) {
        this.inputHistoryIdx = clamp(this.inputHistoryIdx - 1, -1, this.inputHistory.length - 1);
        this.input = this.inputHistoryIdx < 0 ? '' : this.inputHistory[this.inputHistory.length - 1 - this.inputHistoryIdx];
        this.scheduleRender();
      }
      return;
    }

    // printable
    if (/^[\x20-\x7e\u00a0-\uffff]$/.test(s)) {
      // Space with an empty line arms text-input mode so a command that begins
      // with a hotkey letter ('s', 'r', 'f', ...) can still be typed.
      if (!this.prompt && !this.typing && this.input === '' && s === ' ') {
        this.typing = true;
        this.scheduleRender();
        return;
      }
      if (!this.prompt && !this.typing && this.input === '') {
        if (this.hotkey(s) !== null) return;
      }
      this.input += s;
      this.scheduleRender();
      return;
    }
    // multi-char sequences (arrows etc.) land here; ignore
  }

  hotkey(ch) {
    const modeFor = {
      '1': 'afk', '2': 'hold', '3': 'wander', '4': 'gather',
      '5': 'come', '6': 'follow', '7': 'goto', '8': 'attack'
    };
    if (modeFor[ch]) {
      if (modeFor[ch] === 'follow' || modeFor[ch] === 'goto' || modeFor[ch] === 'attack') {
        this.prompt = { mode: modeFor[ch] };
        if (modeFor[ch] === 'follow') this.input = this.status && this.status.players && this.status.players[0] ? this.status.players[0].name : '';
        this.scheduleRender();
        return true;
      }
      this.sendMode(modeFor[ch], []);
      return true;
    }
    switch (ch) {
      case 's': this.takeScreenshot(); return true;
      case 'r': this.radarOn = !this.radarOn; if (this.radarOn) this.pollRadar(); else this.radar = null; this.flash('radar ' + (this.radarOn ? 'on' : 'off')); return true;
      case '+': case '=': this.radarRadius = clamp(this.radarRadius + 4, 4, this.radarRadiusMax); this.flash('radar radius ' + this.radarRadius); this.pollRadar(); return true;
      case '-': case '_': this.radarRadius = clamp(this.radarRadius - 4, 4, this.radarRadiusMax); this.flash('radar radius ' + this.radarRadius); this.pollRadar(); return true;
      case 'e': this.sendExec('eat'); return true;
      case 'f': this.sendExec('survive on').then(() => setTimeout(() => this.pollStatus(), 300)); this.flash('survive toggled'); return true;
      case 'd': this.daemonState = 'connecting'; this.connectOrSpawnDaemon(); return true;
      case 'q': this.quit(false); return true;
      case 'Q': this.quit(true); return true;
      case '?': this.showHelp(); return true;
    }
    return null;
  }

  submitInput() {
    const line = this.input.trim();
    if (!line) { this.prompt = null; this.typing = false; this.scheduleRender(); return; }
    this.inputHistory.push(line);
    if (this.inputHistory.length > 100) this.inputHistory.shift();
    this.inputHistoryIdx = -1;
    if (this.prompt) {
      const mode = this.prompt.mode;
      this.prompt = null;
      this.input = '';
      this.typing = false;
      this.sendMode(mode, line.split(/\s+/));
      return;
    }
    this.input = '';
    this.typing = false;
    this.sendExec(line);
  }

  async sendMode(mode, args) {
    if (!this.client.connected) { this.flash('daemon offline'); return; }
    try {
      const r = await this.client.send('mode', { mode, args }, 10000);
      this.flash(r.msg || (mode + ' ok'));
      setTimeout(() => this.pollStatus(), 400);
    } catch (e) {
      this.flash((e.message || e));
      setTimeout(() => this.pollStatus(), 400);
    }
  }

  async sendExec(line) {
    if (!this.client.connected) { this.flash('daemon offline'); return; }
    try {
      const r = await this.client.send('exec', { line }, 10000);
      this.flash(r.msg || 'ok');
      setTimeout(() => this.pollStatus(), 400);
    } catch (e) {
      this.flash(String(e.message || e));
    }
  }

  async takeScreenshot() {
    if (!this.client.connected) { this.flash('daemon offline'); return; }
    const box = this.shotBox();
    this.flash('rendering 360°…');
    try {
      const r = await this.client.send('screenshot', {
        width: (this.cfg.render && this.cfg.render.panoWidth) || 256,
        height: (this.cfg.render && this.cfg.render.panoHeight) || 72,
        radius: (this.cfg.render && this.cfg.render.panoRange) || 128,
        previewW: Math.max(16, box.w - 4),
        previewH: Math.max(6, (box.h - 4) * 2)
      }, 90000);
      this.shot = r;
      this.overlay = 'shot';
      this.flash(`saved ${path.basename(r.file)} (${(r.bytes / 1024).toFixed(0)} KB)`);
      this.scheduleRender();
    } catch (e) {
      this.flash('shot: ' + String(e.message || e));
    }
  }

  showHelp() {
    this.overlay = 'help';
    this.scheduleRender();
  }

  quit(killDaemon, immediate = false) {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    for (const t of this._timers) clearInterval(t);
    if (killDaemon && this.client.connected) {
      try { this.client.send('quit', {}, 2000).catch(() => {}); } catch (_) {}
    }    const leave = () => {
      try { this.client.close(); } catch (_) {}
      this.screen.clear();
      this.screen.cursorTo(0, 0);
      this.screen.write(
        'AFK bot TUI closed. ' + (killDaemon ? 'Daemon was asked to shut down.' : 'Daemon is still running.') + '\n\r\n\r');
      this.screen.leave();
      process.exit(0);
    };
    // The small delay lets the farewell line reach the terminal before exit.
    // `_quitForTest` / `immediate` skip it, which is what lets the test suite
    // verify shutdown semantics without depending on timer ordering.
    if (immediate || this._quitForTest) leave();
    else setTimeout(leave, killDaemon ? 400 : 60);
  }

  /* ---------------------------------------------------------------- *
   * layout
   * ---------------------------------------------------------------- */

  layout() {
    const s = this.screen;
    const header = 1;
    const footer = 3;               // command bar + input + message line
    const body = Math.max(6, s.rows - header - footer);
    const leftW = clamp(Math.round(s.cols * 0.34), 22, 40);
    return { header, footer, body, leftW, rightW: s.cols - leftW - 1, bodyTop: header };
  }

  radarBox() {
    const L = this.layout();
    const h = clamp(Math.round(L.body * 0.42), 5, L.body - 6);
    return { x: L.leftW + 1, y: L.bodyTop, w: L.rightW, h };
  }

  logBox() {
    const r = this.radarBox();
    const L = this.layout();
    return { x: r.x, y: r.y + r.h, w: r.w, h: L.body - r.h };
  }

  shotBox() {
    const s = this.screen;
    const w = Math.min(s.cols - 8, 120);
    const h = Math.min(s.rows - 6, 44);
    return { x: Math.floor((s.cols - w) / 2), y: Math.floor((s.rows - h) / 2), w, h };
  }

  /* ---------------------------------------------------------------- *
   * rendering
   * ---------------------------------------------------------------- */

  render() {
    const s = this.screen;
    const L = this.layout();
    s.clear();

    this.renderHeader(L);
    this.renderLeft(L);
    this.renderRadar();
    this.renderLogs();
    this.renderFooter(L);

    if (this.overlay === 'shot') this.renderShotOverlay();
    else if (this.overlay === 'help') this.renderHelpOverlay();

    s.cursorTo(0, s.rows);
    if (process.stdout.isTTY) s.write('');
  }

  renderHeader(L) {
    const s = this.screen;
    s.cursorTo(0, 0);
    const title = ' AFK Minecraft Bot';
    const right = [
      this.daemonState === 'online' ? (this.daemonPid ? `daemon ${this.daemonPid}` : 'daemon online') : 'daemon offline',
      this.status ? `${this.status.target}` : '',
      this.status ? `state:${this.status.state}` : 'state:unknown'
    ].filter(Boolean).join(' · ');
    const gap = Math.max(1, s.cols - title.length - right.length - 2);
    const bar = `${BOLD}${title}${RESET}` + ' '.repeat(gap) + DIM + right + RESET;
    s.write(trunc(bar, s.cols));
  }

  box(x, y, w, h, title) {
    const s = this.screen;
    const top = '┌' + '─'.repeat(w - 2) + '┐';
    s.cursorTo(x, y);
    s.write(DIM + top + RESET);
    if (title) {
      s.cursorTo(x + 2, y);
      s.write(BOLD + trunc(title, w - 4) + RESET);
    }
    for (let row = 1; row < h - 1; row++) {
      s.cursorTo(x, y + row);
      s.write(DIM + '│' + RESET + ' '.repeat(w - 2) + DIM + '│' + RESET);
    }
    s.cursorTo(x, y + h - 1);
    s.write(DIM + '└' + '─'.repeat(w - 2) + '┘' + RESET);
  }

  /** Write text inside a box, clipped to the box width. */
  put(x, y, text, w) {
    const s = this.screen;
    s.cursorTo(x + 1, y);
    s.write(trunc(pad(text, w - 2), w - 2));
  }

  renderLeft(L) {
    const s = this.screen;
    const st = this.status;
    this.box(0, L.bodyTop, L.leftW, L.body, 'STATE');
    let y = L.bodyTop + 1;
    const w = L.leftW;

    const row = (label, value, color) => {
      if (y > L.bodyTop + L.body - 2) return;
      this.put(0, y, `${DIM}${label.padEnd(8)}${RESET}${color || ''}${value}${RESET}`, w);
      y++;
    };

    // A short sparkline of recent health and hunger. A single "20/20" reading
    // hides the shape of a fight — flickering damage, slow starvation — that a
    // trend makes obvious in the same screen space.
    const spark = (vals, max = 20) => {
      const bars = [];
      for (const v of vals) {
        if (v == null) { bars.push(DIM + '·'); continue; }
        const f = Math.max(0, Math.min(1, v / max));
        bars.push(f > 0.66 ? '\x1b[32m' + '█' : f > 0.33 ? '\x1b[33m' + '▌' : '\x1b[31m' + '▌');
      }
      return bars.join(RESET) + RESET;
    };

    row('state', st ? st.state : '-', st && st.state === 'spawned' ? '\x1b[32m' : '\x1b[33m');
    row('uptime', fmtDur(st ? st.uptimeSeconds : null));
    row('pos', st && st.pos ? `${st.pos.x} ${st.pos.y} ${st.pos.z}` : '-');
    row('yaw', st && st.yaw != null ? st.yaw.toFixed(1) + '°' : '-');
    const hp = st && st.health != null ? st.health : null;
    const food = st && st.food != null ? st.food : null;
    row('health', hp != null ? `${hp}/20` : '-', hp != null && hp < 10 ? '\x1b[31m' : '\x1b[32m');
    row('food', food != null ? `${food}/20` : '-', food != null && food < 8 ? '\x1b[33m' : '\x1b[32m');
    // Draw the trends only once there is more than one sample. The history is
    // appended here rather than above so hp/food are defined.
    const hpHist = (this._hpHist || []);
    const foodHist = (this._foodHist || []);
    if (hp != null) { hpHist.push(hp); if (hpHist.length > 20) hpHist.shift(); this._hpHist = hpHist; }
    if (food != null) { foodHist.push(food); if (foodHist.length > 20) foodHist.shift(); this._foodHist = foodHist; }
    if (hpHist.length > 2) row('trend', spark(hpHist));
    if (foodHist.length > 2) row('hunger', spark(foodHist));
    row('dim', st && st.dimension ? String(st.dimension).replace('minecraft:', '') : '-');
    if (st) {
      // counters may be absent if a status payload arrives mid-handshake.
      const c = st.counters || {};
      row('con', `${c.connects != null ? c.connects : '-'} · spawn ${c.spawns != null ? c.spawns : '-'} · kick ${c.kicks != null ? c.kicks : '-'}`);
      row('err', String(c.errors != null ? c.errors : '-'));
    }

    y++; // blank line
    this.put(0, y, BOLD + 'GOAL' + RESET, w); y++;
    const a = st && st.actor ? st.actor : null;
    row('mode', a ? a.mode : '-', a && a.mode !== 'afk' ? '\x1b[36m' : DIM);
    row('goal', a && a.goal ? a.goal : (a ? '—' : '-'));
    row('stuck', a ? String(a.stuckAttempts) : '-');
    row('survive', a ? (a.survive ? 'on' : 'off') : '-', a && a.survive ? '\x1b[32m' : DIM);
    row('home', a && a.home ? `${a.home.x} ${a.home.y} ${a.home.z}` : '-');

    // Inventory panel: logs gathered, tool wear, and food on hand. Each line
    // is only drawn when there is something to show, so an empty inventory
    // costs no screen space.
    const inv = st && st.inventory ? st.inventory : null;
    if (inv) {
      const names = Object.keys(inv.items || {}).sort();
      if (names.length || inv.foodCount > 0) {
        y++;
        this.put(0, y, BOLD + 'INV' + RESET, w); y++;
        const logs = names.filter(n => /log$|stem$/.test(n));
        const others = names.filter(n => !/log$|stem$/.test(n));
        for (const n of logs.slice(0, 4)) {
          if (y > L.bodyTop + L.body - 2) break;
          this.put(0, y, ` ${n.replace('_log', '')} ${BOLD}${inv.items[n]}${RESET}`, w); y++;
        }
        for (const t of (inv.tools || []).slice(0, 2)) {
          if (y > L.bodyTop + L.body - 2) break;
          const worn = t.durability <= t.max * 0.25;
          this.put(0, y, ` ${t.name.replace('diamond_', '').replace('iron_', '')} ${worn ? '\x1b[31m' : '\x1b[32m'}${t.durability}/${t.max}${RESET}`, w); y++;
        }
        for (const n of others.slice(0, 3)) {
          if (y > L.bodyTop + L.body - 2) break;
          this.put(0, y, ` ${n} ${DIM}${inv.items[n]}${RESET}`, w); y++;
        }
        if (inv.foodCount > 0) {
          if (y <= L.bodyTop + L.body - 2) {
            this.put(0, y, ` food ${inv.foodCount}`, w); y++;
          }
        }
      }
    }

    if (y < L.bodyTop + L.body - 2 && st && st.players && st.players.length) {
      y++;
      this.put(0, y, BOLD + 'NEARBY' + RESET, w); y++;
      for (const p of st.players.slice(0, 3)) {
        if (y > L.bodyTop + L.body - 2) break;
        this.put(0, y, ` ${p.name} ${DIM}${p.dist}m${RESET}`, w); y++;
      }
    }

    if (y < L.bodyTop + L.body - 2 && st && st.metrics) {
      y++;
      this.put(0, y, `${DIM}rss ${st.metrics.rssMb}M heap ${st.metrics.heapMb}M cpu ${st.metrics.cpuUserS}s${RESET}`, w);
      y++;
    }
  }

  renderRadar() {
    const s = this.screen;
    const box = this.radarBox();
    if (!this.radarOn) {
      this.box(box.x, box.y, box.w, box.h, 'RADAR (off — press r)');
      this.put(box.x, box.y + Math.floor(box.h / 2), DIM + 'press r to enable' + RESET, box.w);
      return;
    }
    this.box(box.x, box.y, box.w, box.h, `RADAR  r=${this.radarRadius}  ${this.radar ? 'tick' : '…'}`);
    if (!this.radar) {
      this.put(box.x, box.y + Math.floor(box.h / 2), DIM + 'waiting for world…' + RESET, box.w);
      return;
    }
    const pv = this.radar.preview;
    const innerW = box.w - 2;
    const innerH = box.h - 2;
    if (!pv || !pv.data) return;

    const colW = Math.min(pv.width, innerW);
    const rows = Math.min(Math.ceil(pv.height / 2), innerH);
    const xOff = Math.floor((innerW - colW) / 2);

    for (let r = 0; r < rows; r++) {
      const py0 = Math.floor(r * pv.height / rows);
      const py1 = Math.min(pv.height - 1, Math.floor((r + 1) * pv.height / rows));
      s.cursorTo(box.x + 1 + xOff, box.y + 1 + r);
      let line = '';
      for (let c = 0; c < colW; c++) {
        const px = Math.floor(c * pv.width / colW);
        const top = pixel(pv, px, py0);
        const bot = pixel(pv, px, py1);
        line += rgb(s, top, true) + rgb(s, bot, false) + '▀';
      }
      s.write(line + RESET);
    }

    // entity markers + bot, in text overlay coordinates
    const cx = xOff + Math.floor(colW / 2);
    const cy = Math.floor(rows / 2);
    if (this.radar.entities) {
      for (const e of this.radar.entities) {
        const ex = clamp(cx + Math.round((e.dx / this.radarRadius) * (colW / 2)), 0, colW - 1);
        const ey = clamp(cy + Math.round((e.dz / this.radarRadius) * (rows / 2) * 2) / 2, 0, rows - 1);
        s.cursorTo(box.x + 1 + ex, box.y + 1 + Math.round(ey));
        s.write(e.kind === 'player' ? '\x1b[34m◉' : (e.kind === 'hostile' ? '\x1b[31m✦' : '\x1b[33m•'));
      }
    }
    // bot at centre + facing arrow
    s.cursorTo(box.x + 1 + cx, box.y + 1 + cy);
    const yaw = this.radar.yaw || 0;
    const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
    const ai = clamp(Math.round(((yaw / (Math.PI * 2)) % 1 + 1) % 1 * 8), 0, 7);
    s.write('\x1b[93m' + arrows[ai] + RESET);
  }

  renderLogs() {
    const s = this.screen;
    const box = this.logBox();
    const L = this.layout();
    this.box(box.x, box.y, box.w, box.h, 'LOG');
    const innerH = box.h - 2;
    const lines = this.logs.slice(-innerH);
    const levelColor = { debug: '\x1b[90m', info: '', warn: '\x1b[33m', error: '\x1b[31m' };
    for (let i = 0; i < lines.length; i++) {
      const rec = lines[i];
      const ts = (rec.ts || '').slice(11, 19);
      const fields = rec.fields ? ' ' + Object.entries(rec.fields)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '';
      const txt = `${DIM}${ts}${RESET} ${levelColor[rec.level] || ''}${rec.msg || ''}${RESET}${DIM}${trunc(fields, box.w - 20)}${RESET}`;
      s.cursorTo(box.x + 1, box.y + 1 + i);
      s.write(trunc(pad(txt, box.w - 2), box.w - 2));
    }
    if (this.shotProgress) {
      const p = Math.round(100 * this.shotProgress.done / Math.max(1, this.shotProgress.total));
      s.cursorTo(box.x + 1, box.y + 1);
      s.write(`\x1b[36mrendering 360° [${'█'.repeat(Math.round(p / 5))}${'░'.repeat(20 - Math.round(p / 5))}] ${p}%${RESET}`);
    }
  }

  renderFooter(L) {
    const s = this.screen;
    const y = s.rows - 2;
    s.cursorTo(0, y);
    const bar = HOTKEYS.map(([k, label]) => `${DIM}${k}:${RESET}${label}`).join(' ') +
      `${DIM}  · Space=type a command · ?=help${RESET}`;
    s.write(trunc(bar, s.cols));

    s.cursorTo(0, y + 1);
    let promptLabel = '';
    if (this.prompt) {
      const usage = this.prompt.mode === 'goto' ? '<x> <z> | <x> <y> <z>' :
        this.prompt.mode === 'follow' ? '<player> [range]' : '<player or mob>';
      promptLabel = `${this.prompt.mode} ${usage}: `;
    }
    const inputLine = `${BOLD}${promptLabel}${RESET}${this.input}${DIM}█${RESET}`;
    s.write(trunc(pad(inputLine, s.cols), s.cols));

    // transient message line (last row of footer)
    if (this.message && Date.now() < this.message.until) {
      s.cursorTo(0, s.rows);
      s.write(trunc('\x1b[36m' + this.message.text + RESET, s.cols));
    }
  }

  renderShotOverlay() {
    const s = this.screen;
    const box = this.shotBox();
    s.cursorTo(box.x, box.y);
    for (let row = 0; row < box.h; row++) {
      s.cursorTo(box.x, box.y + row);
      s.write('\x1b[40m' + ' '.repeat(box.w) + RESET);
    }
    this.box(box.x, box.y, box.w, box.h, '360° PANORAMA — any key to close');
    if (!this.shot || !this.shot.preview) return;
    const pv = this.shot.preview;
    const innerW = box.w - 4;
    const innerH = box.h - 4;
    const colW = Math.min(pv.width, innerW);
    const rows = Math.min(Math.ceil(pv.height / 2), innerH);
    const xOff = Math.floor((innerW - colW) / 2);
    for (let r = 0; r < rows; r++) {
      const py0 = Math.floor(r * pv.height / rows);
      const py1 = Math.min(pv.height - 1, Math.floor((r + 1) * pv.height / rows));
      s.cursorTo(box.x + 2 + xOff, box.y + 2 + r);
      let line = '';
      for (let c = 0; c < colW; c++) {
        const px = Math.floor(c * pv.width / colW);
        line += rgb(s, pixel(pv, px, py0), true) + rgb(s, pixel(pv, px, py1), false) + '▀';
      }
      s.write(line + RESET);
    }
    this.put(box.x, box.y + box.h - 2, `${DIM}${this.shot.width}×${this.shot.height} · ${(this.shot.bytes / 1024).toFixed(0)} KB · ${this.shot.file}${RESET}`, box.w);
  }

  renderHelpOverlay() {
    const s = this.screen;
    const box = this.shotBox();
    s.cursorTo(box.x, box.y);
    for (let row = 0; row < box.h; row++) {
      s.cursorTo(box.x, box.y + row);
      s.write('\x1b[44m' + ' '.repeat(box.w) + RESET);
    }
    this.box(box.x, box.y, box.w, box.h, 'COMMANDS — any key to close');
    const lines = [
      'Movement & goals',
      '  1 afk          2 hold         3 wander      4 gather wood',
      '  5 come home    6 follow <p>   7 goto x z    8 attack <name>',
      '',
      'Camera',
      '  s  render a 360° panorama to screenshots/ (shown here too)',
      '  r  toggle radar    +/-  zoom radar in/out',
      '',
      'Survival layer (opt-in)',
      '  e  eat now          f  toggle auto-eat / flee / hit-back',
      '',
      'Text commands (type at the prompt, Enter to run)',
      '  goto 120 -300   follow Steve 3   wander 80   gather 120',
      '  come   home 120 64 -40   eat   survive on   afk   help',
      '',
      'Other',
      '  d  (re)start daemon   q  quit TUI (daemon stays)   Q  quit both',
      '  ↑/↓ command history   Esc  clear input   Ctrl-C  leave TUI',
      '',
      'The daemon runs headless as src/bot.js; this TUI just attaches to it.'
    ];
    for (let i = 0; i < lines.length && i < box.h - 3; i++) {
      this.put(box.x, box.y + 1 + i, lines[i], box.w);
    }
  }
}

function pixel(pv, x, y) {
  const i = (y * pv.width + x) * 3;
  return [pv.data[i] || 0, pv.data[i + 1] || 0, pv.data[i + 2] || 0];
}

/* ================================================================== *
 * entry point
 * ================================================================== */

async function main() {
  const argv = process.argv.slice(2);
  const demo = argv.includes('--demo');
  const cfg = loadConfig(argv.filter(a => !['--demo'].includes(a)));
  const tui = new Tui({ config: cfg, demo, ipcPath: path.join(PROJECT_ROOT, 'run', 'bot.sock') });
  await tui.start();
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('tui: ' + (e && e.message ? e.message : e) + '\n');
    process.exit(1);
  });
}

module.exports = { Tui, Screen, VirtualScreen, HOTKEYS };
