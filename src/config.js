'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  host: 'weasel.aternos.host',
  port: 44640,
  username: 'AFK_Bot',
  version: 'auto',
  auth: 'offline',
  checkTimeoutMs: 45000,
  connectTimeoutMs: 60000,
  reconnect: {
    enabled: true,
    initialDelayMs: 5000,
    maxDelayMs: 120000,
    multiplier: 1.75,
    jitterMs: 2000
  },
  antiIdle: {
    enabled: true,
    intervalMs: 90000,
    maxYawDeltaDeg: 12,
    movement: false
  },
  behaviors: {
    // Passive by default: the bot stays inert unless a mode is requested.
    mode: 'afk',
    startArgs: [],
    survive: {
      enabled: false,     // opt-in reactive layer (auto-eat / flee / hit back)
      eatAt: 16,
      fleeHealth: 10,
      nightFleeRadius: 12,   // at night, flee a hostile this close even at full health
      attack: true,
      autoRespawn: true
    },
    stuckTimeoutMs: 6000,   // no movement for this long while pathing => unstick
    maxStuckAttempts: 4,    // give up and go AFK after this many stalls
    goalTimeoutMs: 300000,  // hard cap on any single goal
    canDig: true,           // let the pathfinder dig through obstacles
    allowSprinting: true,
    gotoRange: 3,
    home: null,             // {x,y,z}; defaults to the first spawn point
    wander: { radius: 64, minDelayMs: 2500 },
    gather: { radius: 96, maxLogs: 128 },
    follow: { range: 3, reach: 6 }
  },
  render: {
    panoWidth: 256,
    panoHeight: 72,
    panoRange: 128,
    radarRadius: 24,
    radarRadiusMax: 96
  },
  // Optional: a localhost-only HTTP endpoint for external monitoring.
  // metrics: { port: 9199 },
  logging: {
    level: 'info',
    file: 'logs/bot.log',
    jsonl: 'logs/bot.jsonl',
    statusFile: 'logs/status.json'
  }
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!over || typeof over !== 'object') return out;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig(argv = process.argv.slice(2)) {
  let configPath = path.resolve(__dirname, '..', 'config', 'config.json');
  const envPath = process.env.BOT_CONFIG;
  if (envPath) configPath = path.resolve(envPath);
  const idx = argv.indexOf('--config');
  if (idx !== -1 && argv[idx + 1]) configPath = path.resolve(argv[idx + 1]);

  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    throw new Error(`config not found: ${configPath}`);
  }

  // CLI overrides: --host h --port p --username u --duration seconds
  const cfg = deepMerge(DEFAULTS, fileCfg);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (args.host) cfg.host = args.host;
  if (args.port) cfg.port = parseInt(args.port, 10);
  if (args.username) cfg.username = args.username;
  if (args.version) cfg.version = args.version;
  if (args.duration) cfg.durationSeconds = parseInt(args.duration, 10);
  if (args.mode) {
    cfg.behaviors = cfg.behaviors || {};
    cfg.behaviors.mode = args.mode;
  }
  // --anti-idle-movement on|off — some servers kick on position, not view angle
  if (args['anti-idle-movement']) {
    cfg.antiIdle = cfg.antiIdle || {};
    cfg.antiIdle.movement = ['on', 'true', '1', 'yes'].includes(String(args['anti-idle-movement']).toLowerCase());
  }
  // --home x y z
  const homeIdx = argv.indexOf('--home');
  if (homeIdx !== -1 && argv[homeIdx + 3] !== undefined) {
    const [hx, hy, hz] = argv.slice(homeIdx + 1, homeIdx + 4).map(Number);
    if ([hx, hy, hz].every(Number.isFinite)) {
      cfg.behaviors = cfg.behaviors || {};
      cfg.behaviors.home = { x: hx, y: hy, z: hz };
    }
  }
  cfg._configPath = configPath;
  cfg._args = args;
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, deepMerge };
