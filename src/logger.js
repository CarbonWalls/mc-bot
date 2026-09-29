'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ts(date = new Date()) {
  return date.toISOString();
}

class Logger extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.level = LEVELS[opts.level] || LEVELS.info;
    this.file = opts.file || null;
    this.jsonl = opts.jsonl || null;
    this.statusFile = opts.statusFile || null;
    this.consoleEnabled = opts.console !== false;
    this._ensure(this.file);
    this._ensure(this.jsonl);
  }

  _ensure(p) {
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
    } catch (_) { /* ignore */ }
  }

  _write(level, msg, fields) {
    if (LEVELS[level] < this.level) return;
    const rec = Object.assign({ ts: ts(), level, msg }, fields || {});
    const line = `${rec.ts} ${level.toUpperCase().padEnd(5)} ${msg}` +
      (fields && Object.keys(fields).length
        ? ' ' + Object.entries(fields)
            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(' ')
        : '');
    if (this.consoleEnabled) console.log(line);
    // emitted for the TUI (and any other live consumer); the file writers below
    // stay the source of truth on disk
    this.emit('log', rec);
    if (this.file) {
      try { fs.appendFileSync(this.file, line + '\n'); } catch (_) { /* ignore */ }
    }
    if (this.jsonl) {
      try { fs.appendFileSync(this.jsonl, JSON.stringify(rec) + '\n'); } catch (_) { /* ignore */ }
    }
  }

  debug(msg, fields) { this._write('debug', msg, fields); }
  info(msg, fields) { this._write('info', msg, fields); }
  warn(msg, fields) { this._write('warn', msg, fields); }
  error(msg, fields) { this._write('error', msg, fields); }

  status(obj) {
    if (!this.statusFile) return;
    try {
      this._ensure(this.statusFile);
      fs.writeFileSync(this.statusFile, JSON.stringify(Object.assign({ ts: ts() }, obj), null, 2));
    } catch (_) { /* ignore */ }
  }
}

module.exports = { Logger, LEVELS };
