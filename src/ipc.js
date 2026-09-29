'use strict';

/**
 * Line-delimited JSON IPC over a UNIX socket.
 *
 * The bot runs as a headless daemon; the TUI (and anything else) attaches to
 * it through this socket. Requests carry an `id` and get a matching reply;
 * the server also pushes unrequested `event` frames to every connected client
 * (log lines, state changes, radar frames, screenshot progress).
 *
 * Protocol
 *   client -> server : {"id":1,"cmd":"status","args":{...}}
 *   server -> client : {"id":1,"ok":true,"data":{...}}  |  {"id":1,"ok":false,"error":"..."}
 *   server -> client : {"type":"event","name":"log","data":{...}}
 */

const net = require('net');
const fs = require('fs');

const FRAME_MAX = 64 * 1024 * 1024;   // radar/screenshot previews are small, but be generous

function readFrames(buffer, emit) {
  let nl;
  while ((nl = buffer.indexOf(10)) !== -1) {
    const line = buffer.slice(0, nl).toString('utf8');
    buffer = buffer.slice(nl + 1);
    const s = line.trim();
    if (!s) continue;
    if (s.length > FRAME_MAX) continue;
    try { emit(JSON.parse(s)); } catch (_) { /* malformed frame: skip */ }
  }
  return buffer;
}

/**
 * Server side.
 *
 * @param {string} socketPath
 * @param {function} handler  async (cmd, args) => data ; throw to reply with error
 */
class IpcServer {
  constructor(socketPath, handler) {
    this.path = socketPath;
    this.handler = handler;
    this.server = null;
    this.clients = new Set();
  }

  async start() {
    try { fs.unlinkSync(this.path); } catch (_) { /* no stale socket */ }
    await fs.promises.mkdir(require('path').dirname(this.path), { recursive: true }).catch(() => {});
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.clients.add(socket);
        socket.heartbeat = true;
        socket.setNoDelay(true);
        socket.buf = Buffer.alloc(0);
        socket.on('data', (d) => {
          socket.buf = readFrames(Buffer.concat([socket.buf, d]), async (msg) => {
            if (!msg || !msg.cmd) return;
            try {
              const data = await this.handler(msg.cmd, msg.args || {}, socket);
              this._write(socket, { id: msg.id, ok: true, data });
            } catch (e) {
              this._write(socket, { id: msg.id, ok: false, error: e && e.message ? e.message : String(e) });
            }
          });
        });
        socket.on('error', () => {});
        socket.on('close', () => { this.clients.delete(socket); });
      });
      server.once('error', reject);
      server.listen(this.path, () => {
        server.removeListener('error', reject);
        this.server = server;
        try { fs.chmodSync(this.path, 0o600); } catch (_) {}
        resolve();
      });
    });
  }

  _write(socket, obj) {
    if (!socket || socket.destroyed) return;
    socket.write(JSON.stringify(obj) + '\n');
  }

  /** Push an event frame to every attached client. */
  broadcast(name, data) {
    if (!this.clients.size) return;
    const frame = JSON.stringify({ type: 'event', name, data }) + '\n';
    for (const socket of this.clients) {
      try { if (!socket.destroyed) socket.write(frame); } catch (_) {}
    }
  }

  stop() {
    for (const socket of this.clients) { try { socket.end(); } catch (_) {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
  }
}

/**
 * Client side.
 *
 * await client.send('status')            -> data
 * client.onEvent('log', (data) => ...)   -> event subscription
 */
class IpcClient {
  constructor() {
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this._nextId = 1;
    this._pending = new Map();
    this._eventHandlers = new Map();
    this._closeHandlers = [];
  }

  connect(socketPath, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => resolve());
      socket.setNoDelay(true);
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new Error('IPC connect timeout'));
      });
      socket.once('connect', () => socket.setTimeout(0));
      socket.on('data', (d) => {
        this.buf = readFrames(Buffer.concat([this.buf, d]), (msg) => this._dispatch(msg));
      });
      socket.on('error', (e) => {
        if (!this.socket) reject(e);
      });
      socket.on('close', () => {
        this.socket = null;
        for (const h of this._closeHandlers) { try { h(); } catch (_) {} }
        // reject any in-flight requests
        for (const [id, p] of this._pending) {
          p.reject(new Error('connection closed'));
          this._pending.delete(id);
        }
      });
      this.socket = socket;
    });
  }

  _dispatch(msg) {
    if (msg.type === 'event') {
      const hs = this._eventHandlers.get(msg.name);
      if (hs) for (const h of hs) { try { h(msg.data || {}); } catch (_) {} }
      const all = this._eventHandlers.get('*');
      if (all) for (const h of all) { try { h(msg); } catch (_) {} }
      return;
    }
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error || 'unknown error'));
  }

  send(cmd, args = {}, timeoutMs = 20000) {
    if (!this.socket) return Promise.reject(new Error('not connected'));
    const id = this._nextId++;
    const line = JSON.stringify({ id, cmd, args }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`IPC timeout: ${cmd}`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.socket.write(line);
    });
  }

  onEvent(name, cb) {
    if (!this._eventHandlers.has(name)) this._eventHandlers.set(name, new Set());
    this._eventHandlers.get(name).add(cb);
  }

  onClose(cb) { this._closeHandlers.push(cb); }

  close() {
    if (this.socket) { try { this.socket.end(); } catch (_) {} this.socket = null; }
  }

  get connected() { return !!this.socket && !this.socket.destroyed; }
}

module.exports = { IpcServer, IpcClient };
