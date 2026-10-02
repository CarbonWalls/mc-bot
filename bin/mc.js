#!/usr/bin/env node
'use strict';

/**
 * `mc` — the one command for everything this bot does.
 *
 * It exists because this project used to be driven by
 *   bash ./pvp.sh "pvp ENC_7376484R hard"
 * which is three layers of quoting between you and the thing you meant to say
 * (and pvp.sh has since been deleted). Here it is one word per argument:
 *
 *   mc pvp Steve hard          start a fight
 *   mc pvp Steve stop          disengage
 *   mc hearts Steve            what the server actually says about them
 *   mc status                  health/hearts/mode/position/last result
 *   mc goto 100 64 -20         walk there (steps are jumped, cliffs are avoided)
 *
 * No shell is involved: this talks to the daemon's UNIX socket directly. Run
 * `mc --help` for the full list, `mc doctor` for a self-test, and `mc demo` to
 * try everything against the offline world with no server.
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOCK = process.env.MC_SOCK || path.join(ROOT, 'run', 'bot.sock');
const PIDFILE = path.join(ROOT, 'run', 'bot.pid');

const TIERNAMES = { rookie: 0, easy: 0.25, medium: 0.5, vet: 0.75, veteran: 0.75, hard: 1, max: 1 };

/* ------------------------------------------------------------------ *
 * transport: one request, one answer, no dependencies
 * ------------------------------------------------------------------ */

function request(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK, () => {
      s.write(JSON.stringify({ id: 1, cmd, args: args || {} }) + '\n');
    });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`timeout after ${timeoutMs || 8000}ms — is the daemon running? (mc start)`));
    }, timeoutMs || 8000);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let n;
      while ((n = buf.indexOf(10)) !== -1) {
        const line = buf.slice(0, n).toString('utf8'); buf = buf.slice(n + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.id === 1) {
          clearTimeout(timer);
          s.destroy();
          if (m.ok) resolve(m.data);
          else reject(new Error(m.error || 'unknown error'));
        }
      }
    });
    s.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error('daemon is not running — try: mc start') : e); });
  });
}

/** Ask for the raw exec line and print whatever came back. */
async function exec(line, timeoutMs) {
  const d = await request('exec', { line }, timeoutMs);
  return d;
}

/**
 * `mc pvp <player> [tier] --explain`
 *
 * Render the advisor prompt from the daemon's *live* state and print it. Nothing
 * is sent to the endpoint, and no fight is started: this is the tool for the
 * question "why did the AI pick that?", which cannot be answered without seeing
 * the exact sentence and weights it was given.
 */
async function explainPrompt(a) {
  const { buildFightPrompt, PVP_ACTIONS } = require(path.join(ROOT, 'src', 'jev.js'));
  const name = a[0];
  if (!name) return usage('pvp');
  const tierTok = a[1];
  const tier = tierTok == null ? 0.5 : (TIERNAMES[String(tierTok).toLowerCase()] != null ? TIERNAMES[String(tierTok).toLowerCase()] : parseFloat(tierTok) || 0.5);
  const st = await request('status', {});
  const ob = await request('observe', { name }).catch(() => null);
  const me = (st.players || []).find(p => p.name === name) || null;
  const a_ = st.actor || {};
  // Prefer the real held item; fall back to the best weapon actually in the
  // inventory, because a bot that has a sword in its pack but not in its hand
  // hits like a fist, and --explain must say so rather than flatter the reader.
  const invItems = st.inventory && st.inventory.items ? Object.keys(st.inventory.items) : [];
  const selfWeaponName = (a_.heldItem && a_.heldItem.name) ||
    invItems.find(n => /sword|axe/.test(n)) ||
    (invItems.length ? 'fist' : null);
  const ctx = {
    gameName: name, botName: st.username, distance: me ? me.dist : null, tier,
    self: {
      hp: st.health, hearts: st.hearts, food: st.food, gamemode: st.gamemode,
      weapon: selfWeaponName,
      weaponDamage: weaponTable()[selfWeaponName] || 1,
      armor: null
    },
    target: {
      hpEstimate: ob && ob.data && ob.data.vitals ? ob.data.vitals.health : null,
      hpSource: ob && ob.data && ob.data.vitals ? ob.data.vitals.source : 'none',
      gamemode: ob && ob.data ? ob.data.gamemode : null,
      hitsTaken: ob && ob.data && ob.data.vitals ? Math.round(ob.data.vitals.damageSeen) : 0,
      missed: ob && ob.data && ob.data.vitals ? ob.data.vitals.missedAttacks : 0
    },
    world: Object.assign({}, a_.ground ? { nearCliff: (a_.ground.aheadDrop > 2 || a_.ground.exitRise > 1) } : {}, { timeOfDay: null }),
    rules: { engagement: 'explaining the prompt a live duel would use' }
  };
  const { state, questions } = buildFightPrompt(ctx);
  const lines = [];
  lines.push(`${C.bold}state${C.off} ${C.dim}(sent to the endpoint, ${state.length} chars)${C.off}`);
  lines.push('  ' + state);
  lines.push('');
  lines.push(`${C.bold}action weights${C.off} ${C.dim}(priors: they bias the answer, they do not force it)${C.off}`);
  const crit = questions.action.criteria;
  const maxW = Math.max(...PVP_ACTIONS.map(k => crit[k] || 0));
  for (const k of PVP_ACTIONS) {
    const w = crit[k] || 0;
    const bar = '#'.repeat(Math.round((w / maxW) * 24));
    lines.push(`  ${k.padEnd(11)} ${String(w.toFixed(2)).padStart(5)}  ${C.y}${bar}${C.off}`);
  }
  lines.push('');
  lines.push(`${C.dim}score questions: aggression [timid careful balanced assertive savage], risk [negligible low moderate high lethal]${C.off}`);
  if (!me) lines.push(`${C.y}note:${C.off} the daemon cannot currently see ${name} — distance is unknown, so a live prompt would differ.`);
  if (ob && ob.data) lines.push(`${C.dim}observed: gamemode=${ob.data.gamemode} killable=${ob.data.killable} vitals=${ob.data.vitals ? ob.data.vitals.source : 'none'}${C.off}`);
  lines.push(`${C.dim}nothing was sent and no fight started. To actually enable the advisor: mc ai assist | mc ai force${C.off}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * output
 * ------------------------------------------------------------------ */

const C = process.stdout.isTTY && !process.env.NO_COLOR ? {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', dim: '\x1b[2m',
  bold: '\x1b[1m', off: '\x1b[0m'
} : { r: '', g: '', y: '', b: '', dim: '', bold: '', off: '' };

/** Hearts, the way the game draws them: full, half, empty out of ten. */
function heartBar(hp) {
  if (hp == null || !Number.isFinite(hp)) return `${C.dim}??${C.off}`;
  const halves = Math.max(0, Math.min(20, Math.round(hp)));
  let out = '';
  for (let i = 0; i < 10; i++) {
    const v = halves - i * 2;
    if (v >= 2) out += `${C.r}\u2764${C.off}`;
    else if (v === 1) out += `${C.r}\u2665${C.off}`;
    else out += `${C.dim}\u2661${C.off}`;
  }
  return `${out} ${C.dim}${hp.toFixed(1)} hp${C.off}`;
}

// 15 columns: 'ACTION NEEDED' and 'minecraft-data' are both 15 chars, and a
// narrower pad silently ran the label into its value ('minecraft-datav3.117.0').
function hline(k, v) { return `  ${C.dim}${k.padEnd(16)}${C.off}${v}`; }

/* ------------------------------------------------------------------ *
 * commands
 * ------------------------------------------------------------------ */

const COMMANDS = {
  /* ---- lifecycle ------------------------------------------------- */
  start: {
    help: 'start the daemon (foreground: mc start -f)',
    usage: 'mc start [-f|--foreground] [--demo] [--mode wander] [--host h] [--port p]',
    run: async (a) => {
      const fg = a.includes('-f') || a.includes('--foreground');
      const rest = a.filter(x => x !== '-f' && x !== '--foreground');
      const args = [path.join(ROOT, 'src', 'bot.js'), ...rest];
      if (fg) {
        const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
        return new Promise(res => child.on('exit', c => res(`daemon exited (${c})`)));
      }
      if (fs.existsSync(SOCK)) {
        try { await request('ping', {}, 1500); return `${C.y}already running${C.off} — mc status / mc stop`;
        } catch (_) { /* stale socket: the daemon replaces it on start */ }
      }
      fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
      const out = fs.openSync(path.join(ROOT, 'logs', 'mc.out'), 'a');
      const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
      child.unref();
      // bot.js owns the pid file (its single-instance lock); do not race it by
      // writing our own copy, just wait for the real one to appear.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 150));
        if (fs.existsSync(PIDFILE)) break;
      }
      let pid = null;
      try { pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim()); } catch (_) { pid = child.pid; }
      return `daemon started (pid ${pid}); log: logs/mc.out\n  ${C.dim}next: mc status, mc gather, mc pvp <player> hard${C.off}`;
    }
  },
  stop: {
    help: 'stop the daemon cleanly',
    usage: 'mc stop [--force]',
    run: async (a) => {
      if (a.includes('--force')) return runTool(['tools', 'daemon.js'], ['kill']);
      try { await request('quit', {}, 3000); } catch (_) { /* already gone */ }
      return runTool(['tools', 'daemon.js'], ['stop']);
    }
  },
  status: {
    help: 'state of the bot and the last fight',
    usage: 'mc status',
    run: async () => {
      const st = await request('status', {});
      const a = st.actor || {};
      const lines = [];
      lines.push(`${C.bold}bot${C.off}`);
      lines.push(hline('state', `${st.state} ${C.dim}(${st.target}, ${st.version})${C.off}` +
        (st.demo ? ` ${C.b}[DEMO world]${C.off}` : '')));
      if (st.banned) {
        lines.push(hline('verdict', `${C.r}BANNED by the server${C.off} ${C.dim}(${st.kickKind || 'ban'})${C.off}`));
        lines.push(hline('  reason', String(st.lastKickReason || '').replace(/[\n\s]+/g, ' ').slice(0, 90)));
        lines.push(hline('  next', 'the ban must be lifted server-side, then: mc start'));
      } else if (st.state === 'waiting_for_server') {
        lines.push(hline('waiting', `${C.y}server appears stopped${C.off} ${C.dim}(ping said "Offline" / a non-version protocol)${C.off} — waiting for it to start, retrying normally`));
      } else if (st.state === 'unsupported_version') {
        lines.push(hline('verdict', `${C.r}this server's version is not in the installed minecraft-data${C.off}`));
        lines.push(hline('  next', 'mc targets — shows which known server is joinable right now'));
      }
      lines.push(hline('health', heartBar(st.health)));
      lines.push(hline('food', st.food != null ? `${st.food}/20 ${st.food < 8 ? C.r + 'starving' : ''}${C.off}` : '?'));
      lines.push(hline('gamemode', (a.gamemode || '?') + (a.gamemode === 'creative' ? ` ${C.y}(no damage possible to/from creative players)${C.off}` : '')));
      lines.push(hline('position', st.pos ? `${st.pos.x}, ${st.pos.y}, ${st.pos.z}` : '?'));
      if (a.ground) {
        lines.push(hline('ground', `surface ${a.ground.surface} ${C.dim}ahead rise ${a.ground.aheadRise} drop ${a.ground.aheadDrop} · ${a.ground.onGround ? 'on ground' : 'airborne'}${C.off}`));
      }
      lines.push(hline('mode', `${st.mode}${a.goal ? ` -> ${a.goal}` : ''}${st.survive ? ' [survive]' : ''}${a.ai && a.ai !== 'off' ? ` [ai ${a.ai}]` : ''}`));
      lines.push(hline('home', st.home ? `${st.home.x} ${st.home.y} ${st.home.z}` : 'unset'));
      lines.push(hline('counters', Object.entries(st.counters || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'));
      if (st.players && st.players.length) {
        lines.push(`${C.bold}players${C.off}`);
        for (const p of st.players) lines.push(hline(p.name, `${p.dist} blocks  ${C.dim}${p.pos.x},${p.pos.y},${p.pos.z}${C.off}`));
      }
      const pv = a.pvp;
      if (pv && (pv.running || pv.result)) {
        lines.push(`${C.bold}pvp${C.off}`);
        lines.push(hline('target', `${pv.target} (tier ${pv.tier})${pv.running ? ' ' + C.g + 'FIGHTING' : C.off + ' ' + (pv.result || '')}${C.off}`));
        if (pv.resultReason) lines.push(hline('reason', pv.resultReason));
        lines.push(hline('opponent', `${pv.opponent.healthEstimate} hp est ${C.dim}(${pv.opponent.estimateHearts} hearts, ${pv.opponent.observedSource})${C.off} · gamemode ${pv.opponent.gamemode}`));
        lines.push(hline('our swings', `${pv.counts.swings} · confirmed ${pv.counts.confirmedHits} · no effect ${pv.counts.swingsWithNoEffect}`));
        lines.push(hline('they hit us', `${pv.counts.hitsTakenByUs}`));
        if (pv.ai) lines.push(hline('ai', `${pv.ai.mode}: ${pv.ai.last ? pv.ai.last.action + ` (conf ${pv.ai.last.confidence})` : 'no answer yet'}`));
      }
      return lines.join('\n');
    }
  },
  doctor: {
    help: 'self-test: can we see the server, the daemon, the terrain?',
    usage: 'mc doctor [--demo]',
    run: async (a) => {
      const out = [];
      out.push(`${C.bold}doctor${C.off}`);
      out.push(hline('node', process.version));
      for (const [label, file] of [['mineflayer', 'node_modules/mineflayer/package.json'], ['pathfinder', 'node_modules/mineflayer-pathfinder/package.json'], ['minecraft-data', 'node_modules/minecraft-data/package.json']]) {
        try { out.push(hline(label, `v${JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')).version}`)); }
        catch (_) { out.push(hline(label, `${C.r}missing — npm install${C.off}`)); }
      }
      out.push(hline('daemon', fs.existsSync(SOCK) ? `${C.g}socket present${C.off}` : `${C.y}not running${C.off}`));
      if (fs.existsSync(PIDFILE)) {
        const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
        let alive = false; try { process.kill(pid, 0); alive = true; } catch (_) {}
        out.push(hline('pid', `${pid} ${alive ? '(alive)' : C.r + '(stale — mc stop will clean it)' + C.off}`));
      }
      try {
        const st = await request('status', {}, 3000);
        out.push(hline('state', st.state + (st.banned ? ` ${C.r}(banned: ${st.kickKind})${C.off}` : '')));
        out.push(hline('health', heartBar(st.health)));
        const a = st.actor || {};
        if (a.ground) out.push(hline('terrain', `surface ${a.ground.surface}, ahead rise ${a.ground.aheadRise}, exit climb ${a.ground.exitRise ?? 'n/a'}`));
        if (st.state === 'banned') out.push(hline('ACTION NEEDED', `${C.r}banned by the server${C.off} — ${st.lastKickReason ? String(st.lastKickReason).replace(/[\n\s]+/g, ' ').slice(0, 70) : 'see logs'}`));
        // Warn about the trap this daemon walked into twice: Aternos bans an
        // account it decides is idling, and a look-only anti-idle nudge does not
        // always satisfy the threshold. If the bot is in afk with movement
        // disabled on a live server, say so before the ban happens.
        if (st.state === 'spawned' && a.mode === 'afk' && !st.banned && !st.demo) {
          const cfg = require(path.join(ROOT, 'src', 'config.js')).loadConfig([]);
          if (cfg.antiIdle && !cfg.antiIdle.movement) {
            out.push(hline('risk', C.y + 'afk + antiIdle.movement=false' + C.off + ' ' + C.dim +
              '\u2014 some Aternos servers ban idle clients; start with --anti-idle-movement on, or run: mc wander 24' + C.off));
          }
        }
        if (a.mode === 'afk' && !st.players.length) out.push(hline('hint', 'idle. try: mc demo, or mc gather'));
        if (st.state === 'unsupported_version' || st.state === 'waiting_for_server') {
          out.push(hline('target', 'run: mc targets — shows which known server is joinable right now'));
        }
      } catch (e) { out.push(hline('daemon rpc', `${C.y}${e.message}${C.off}`)); }
      return out.join('\n');
    }
  },
  logs: {
    help: 'tail the daemon log',
    usage: 'mc logs [-n 40] [--errors]',
    run: async (a) => {
      const n = a.includes('-n') ? Number(a[a.indexOf('-n') + 1]) || 40 : 40;
      try {
        const d = await request('logs', { count: n });
        let lines = (d.lines || []).map(l => (l && l.msg) ? `${l.time || ''} ${l.msg}${l.level === 'warn' || l.level === 'error' ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => !['time', 'msg', 'level'].includes(k)))) : ''}` : JSON.stringify(l));
        if (a.includes('--errors')) lines = lines.filter(l => /error|warn|stuck|flee|died/i.test(l));
        return lines.join('\n') || 'no log lines yet';
      } catch (_) {
        const f = path.join(ROOT, 'logs', 'bot.log');
        if (!fs.existsSync(f)) return 'no log file yet (logs/bot.log)';
        return runShell('tail', ['-n', String(n), f]);
      }
    }
  },
  tui: {
    help: 'the terminal dashboard (radar, log tail, command line)',
    usage: 'mc tui [--demo]',
    run: (a) => runNode({ script: ['src', 'tui.js'], args: a }, { inherit: true })
  },
  demo: {
    help: 'drive the offline demo world — no server needed',
    usage: 'mc demo [command...]',
    run: async (a) => {
      // Boot a mock bot in-process and run the real behaviour engine against it,
      // so `mc demo pvp Steve hard` exercises the same code path as a live server
      // (minus the network) and prints what the bot decided and why.
      const { MockWorld, MockBot } = require(path.join(ROOT, 'src', 'mock'));
      const { Actor } = require(path.join(ROOT, 'src', 'actor'));
      const loadConfig = require(path.join(ROOT, 'src', 'config')).loadConfig;
      const cfg = loadConfig([]);
      const world = MockWorld.arena({ floorY: 70, radius: 24, stepAtZ: 10, pit: [2, 2, 3, 2] });
      const bot = new MockBot(world, { username: 'AFK_Bot', manualTicks: false });
      bot._spawn();
      const actor = new Actor(bot, {
        logger: {
          info: (m, f) => console.log(`${C.g}info ${C.off}${m}${f ? ' ' + C.dim + fmt(f) + C.off : ''}`),
          warn: (m, f) => console.log(`${C.y}warn ${C.off}${m}${f ? ' ' + C.dim + fmt(f) + C.off : ''}`),
          error: (m, f) => console.log(`${C.r}error${C.off} ${m}${f ? ' ' + C.dim + fmt(f) + C.off : ''}`),
          debug: () => {}
        },
        config: Object.assign({}, cfg.behaviors, { survive: { enabled: true, fleeHealth: 10 }, ai: 'off' })
      });
      actor.onSpawn();
      const line = a.length ? a.join(' ') : 'goto 12 12';
      console.log(`${C.bold}demo${C.off} ${C.dim}(command: ${line})${C.off}`);
      const r = actor.exec(line);
      console.log(`  ${r.ok ? C.g + 'ok' : C.r + 'fail'}${C.off}: ${r.msg}`);
      // let the sim run and report the interesting part: did it move, jump, climb?
      const start = bot.entity.position.clone();
      let jumped = 0, blocked = 0;
      const iv = setInterval(() => { if (bot._controls.jump) jumped++; if (bot._blockedAt) blocked++; }, 60);
      await new Promise(res => setTimeout(res, 6000));
      clearInterval(iv);
      const moved = bot.entity.position.distanceTo(start);
      console.log(`  ${C.dim}moved ${moved.toFixed(1)} blocks · y ${start.y.toFixed(0)} -> ${bot.entity.position.y.toFixed(0)} · jump ticks ${jumped} · blocked-at ${blocked}${C.off}`);
      console.log(`  ground: ${JSON.stringify(actor.info.ground)}`);
      actor.setMode('afk');          // release the controls before we leave
      actor.destroy();
      (bot._timers || []).forEach(t => { clearInterval(t); clearTimeout(t); });
      return `demo finished: ${moved > 1 ? C.g + 'the bot moved on uneven ground' : C.y + 'the bot did not move' + C.off}`;
    }
  },

  /* ---- behaviour: thin, quoted-free wrappers over `exec` ---------- */
  afk: { help: 'passive: stand still', usage: 'mc afk', run: () => exec('afk').then(msg) },
  hold: { help: 'stand ground but defend', usage: 'mc hold', run: () => exec('hold').then(msg) },
  come: { help: 'walk home', usage: 'mc come', run: () => exec('come').then(msg) },
  goto: {
    help: 'pathfind to a coordinate (jumps steps, avoids cliffs)',
    usage: 'mc goto <x> <z>   or   mc goto <x> <y> <z>',
    run: (a) => a.length ? exec('goto ' + a.join(' ')).then(msg) : usage('goto')
  },
  home: {
    help: 'show or set the home point',
    usage: 'mc home [x y z]',
    run: (a) => exec(['home', ...a].join(' ')).then(msg)
  },
  wander: { help: 'random walk near home', usage: 'mc wander [radius]', run: (a) => exec('wander ' + a.join(' ')).then(msg) },
  gather: { help: 'find trees and chop them', usage: 'mc gather [radius]', run: (a) => exec('gather ' + a.join(' ')).then(msg) },
  follow: { help: 'follow a player', usage: 'mc follow <player> [range]', run: (a) => a.length ? exec('follow ' + a.join(' ')).then(msg) : usage('follow') },
  attack: { help: 'fight a named mob', usage: 'mc attack <name>', run: (a) => a.length ? exec('attack ' + a[0]).then(msg) : usage('attack') },
  kill: { help: 'same as attack', usage: 'mc kill <name>', run: (a) => a.length ? exec('attack ' + a[0]).then(msg) : usage('kill') },
  eat: { help: 'eat the best food in the inventory', usage: 'mc eat', run: () => exec('eat').then(msg) },
  survive: {
    help: 'arm or disarm the survival layer',
    usage: 'mc survive [on|off]',
    run: (a) => exec('survive ' + (a[0] || '')).then(msg)
  },
  craft: { help: 'craft an item', usage: 'mc craft <item> [count]', run: (a) => a.length ? exec('craft ' + a.join(' ')).then(msg) : usage('craft') },
  pickaxe: { help: 'the whole chain: wood -> planks -> sticks -> pickaxes', usage: 'mc pickaxe [n]', run: (a) => exec('pickaxe ' + a.join(' ')).then(msg) },

  /* ---- the interesting ones -------------------------------------- */
  pvp: {
    help: 'duel a player. tiers: rookie easy medium vet hard 0..1',
    usage: 'mc pvp <player> [tier] | mc pvp <player> stop | mc pvp hp <player> <n> | mc pvp result | mc pvp <player> [tier] --explain',
    run: async (a) => {
      if (!a.length) return usage('pvp');
      // --explain prints the exact state sentence and option weights the advisor
      // would receive, using live bot facts, without sending anything. Debugging a
      // classifier whose input you cannot see is guesswork, and "the AI does
      // nothing" is almost always a question of what was actually asked.
      const explain = a.includes('--explain');
      const args = a.filter(x => x !== '--explain');
      if (explain) return explainPrompt(args);
      if (args[0] === 'result') return exec('result').then(r => (r.ok ? '' : C.r + 'no fight: ' + C.off) + r.msg +
        (r.data ? '\n' + C.dim + JSON.stringify(r.data, null, 2) + C.off : ''));
      if (args[0] === 'hp') {
        if (args.length < 3) return usage('pvp');
        return exec(`pvp ${args[1]} hp ${args[2]}`).then(msg);
      }
      if (args[0] === 'ai') return exec(`pvp _ ai ${args[1] || 'assist'}`).then(msg);
      const name = args[0];
      const tierTok = args[1];
      if (tierTok && ['stop', 'off'].includes(String(tierTok).toLowerCase())) return exec(`pvp ${name} stop`).then(msg);
      let tier = 'medium';
      if (tierTok != null) tier = TIERNAMES[String(tierTok).toLowerCase()] != null ? String(tierTok).toLowerCase() : String(tierTok);
      const r = await exec(`pvp ${name} ${tier}`);
      return msg(r);
    }
  },
  hearts: {
    help: 'read hearts: your own, or another player\'s (game mode + observed health)',
    usage: 'mc hearts [player]',
    run: (a) => exec(['hearts', ...a].join(' ')).then(msg)
  },
  result: {
    help: 'how the last duel ended, with the evidence',
    usage: 'mc result',
    run: () => exec('result').then(r => (r.ok ? '' : C.y) + r.msg + (r.ok ? C.off : C.off) +
      (r.data ? '\n' + C.dim + JSON.stringify(r.data, null, 2) + C.off : ''))
  },
  players: { help: 'who the bot can see', usage: 'mc players', run: () => exec('players').then(msg) },
  jump: { help: 'prove the jump works right now', usage: 'mc jump', run: () => exec('jump').then(msg) },
  climb: { help: 'climb out of the current hole', usage: 'mc climb', run: () => exec('climb').then(msg) },
  ai: {
    help: 'the external decision advisor',
    usage: 'mc ai [off|assist|force]',
    run: (a) => exec('ai ' + (a[0] || 'assist')).then(msg)
  },
  radar: {
    help: 'print the radar as text',
    usage: 'mc radar [radius]',
    run: async (a) => {
      const r = await request('radar', { radius: Number(a[0]) || 24, previewW: 60, previewH: 30 }, 15000);
      return renderRadarText(r);
    }
  },
  shot: {
    help: 'write a 360 panorama PNG',
    usage: 'mc shot [--width 512] [--height 144]',
    run: async (a) => {
      const width = a.includes('--width') ? Number(a[a.indexOf('--width') + 1]) : 512;
      const height = a.includes('--height') ? Number(a[a.indexOf('--height') + 1]) : 144;
      const d = await request('screenshot', { width, height }, 30000);
      return `${C.g}wrote${C.off} ${d.file} ${C.dim}(${d.width}x${d.height}, ${(d.bytes / 1024).toFixed(0)} KB)${C.off}`;
    }
  },
  targets: {
    help: 'probe every known server and say which one the bot can actually join',
    usage: 'mc targets [--save]',
    run: async (a) => {
      // Why this command exists: "which address should the config use" is not a
      // question a README can answer, because the answer changes when the server
      // owner updates Paper and when Aternos rotates an *.aternos.host name. The
      // bot can join a server only if the installed minecraft-data ships a data
      // directory for its protocol number, so the only honest answer is a probe.
      const { loadConfig } = require(path.join(ROOT, 'src', 'config.js'));
      const cfg = loadConfig([]);
      const { probeServer, serverVersionKnown } = require(path.join(ROOT, 'src', 'core.js'));
      const known = [
        { label: 'config', host: cfg.host, port: cfg.port },
        { label: 'betahhd', host: 'betahhd.aternos.me', port: 49851 },
        { label: '4of5', host: '4of5.aternos.me', port: 44640 }
      ];
      const seen = new Set();
      const list = known.filter(t => { const k = `${t.host}:${t.port}`; if (seen.has(k)) return false; seen.add(k); return true; });
      const lines = [`${C.bold}targets${C.off} ${C.dim}(minecraft-data ${require('minecraft-data/package.json').version})${C.off}`, ''];
      let best = null;
      for (const t of list) {
        let v = null;
        try { v = await probeServer(t.host, t.port, 7000); } catch (_) { v = null; }
        if (!v) { lines.push(`  ${C.dim}${t.label.padEnd(9)} ${t.host}:${t.port}  no response / unreachable${C.off}`); continue; }
        if (typeof v.protocol !== 'number' || v.protocol <= 0) {
          lines.push(`  ${C.y}${t.label.padEnd(9)} ${t.host}:${t.port}  ${v.name} — stopped (proxy answers "Offline" while the server sleeps)${C.off}`);
          continue;
        }
        const ok = serverVersionKnown(String(v.protocol));
        if (ok.ok) {
          lines.push(`  ${C.g}${t.label.padEnd(9)} ${t.host}:${t.port}  ${v.name} (protocol ${v.protocol}) — JOINABLE as ${ok.as}${C.off}`);
          if (!best) best = { host: t.host, port: t.port, protocol: v.protocol, versionName: v.name, as: ok.as };
        } else {
          lines.push(`  ${C.r}${t.label.padEnd(9)} ${t.host}:${t.port}  ${v.name} (protocol ${v.protocol}) — CANNOT JOIN: no minecraft-data for it${C.off}`);
        }
      }
      lines.push('');
      lines.push(`${C.dim}A server is joinable only when minecraft-data ships a data directory for its protocol number.${C.off}`);
      lines.push(`${C.dim}Update with: npm update minecraft-data --no-audit --no-fund${C.off}`);
      if (best) {
        lines.push('');
        lines.push(`  ${C.g}joinable now:${C.off} mc start --host ${best.host} --port ${best.port}`);
        if (a.includes('--save')) {
          try {
            const cfgPath = path.join(ROOT, 'config', 'config.json');
            const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            raw.host = best.host; raw.port = best.port;
            // Keep the provenance block in step with the target. config.json is
            // asserted against it (tests/run_tests.js checks that
            // _verifiedTarget.host/port match, and that the recorded protocol is
            // joinable), so writing host/port alone would leave a stale note
            // pointing at the previous server and turn a legitimate `--save` into
            // a red test suite.
            raw._verifiedTarget = Object.assign({}, raw._verifiedTarget, {
              host: best.host, port: best.port, protocol: best.protocol, versionName: best.versionName,
              how: 'mc targets (probeServer + minecraft-data data dir)',
              verifiedAt: new Date().toISOString()
            });
            fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
            lines.push(`  ${C.g}saved${C.off} config.json -> ${best.host}:${best.port} (protocol ${best.protocol}, as ${best.as})`);
            lines.push(`  ${C.dim}_verifiedTarget updated to match, so the config test stays honest${C.off}`);
          } catch (e) { lines.push(`  ${C.r}could not save:${C.off} ${e.message}`); }
        }
      } else {
        lines.push(`  ${C.y}nothing joinable right now${C.off} — the bot waits or stops with a reason instead of looping.`);
      }
      return lines.join('\n');
    }
  },
  help: { help: 'this list', usage: 'mc help [command]', run: (a) => a.length ? usage(a[0]) : listHelp() }
};

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/**
 * The weapon table src/pvp.js uses for its damage accounting. Read from that
 * module rather than duplicated here, so the CLI can never state a number the
 * bot itself does not use. (api_contract_test asserts this stays requireable.)
 */
function weaponTable() {
  try { return require(path.join(ROOT, 'src', 'pvp.js')).WEAPON_DAMAGE || {}; }
  catch (_) { return {}; }
}
function fmt(o) {
  try { return JSON.stringify(o); } catch (_) { return String(o); }
}
function msg(r) {
  if (typeof r === 'string') return r;
  if (r && r.msg) {
    const okFlag = r.ok === false ? C.r + 'failed ' : '';
    return okFlag + r.msg + (r.ok === false ? C.off : '');
  }
  return fmt(r);
}
function usage(name) {
  const c = COMMANDS[name];
  return `${C.y}usage:${C.off} ${c ? c.usage : 'mc ' + name}`;
}
function listHelp() {
  const rows = Object.entries(COMMANDS).map(([k, v]) => `  ${C.bold}${k.padEnd(10)}${C.off}${v.help}`);
  return [
    `${C.bold}mc${C.off} — control the Minecraft bot`,
    '',
    ...rows,
    '',
    `${C.dim}examples${C.off}`,
    '  mc start                    mc status                mc pvp Steve hard',
    '  mc pvp Steve stop           mc hearts Steve          mc goto 100 -20',
    '  mc demo                     mc doctor                mc logs --errors',
    '  mc targets                  which server can the bot join right now',
    '',
    `${C.dim}The daemon must be running for everything except start/doctor/demo/help.${C.off}`
  ].join('\n');
}

function runNode(rel, opts = {}) {
  return new Promise(res => {
    // `rel` is [scriptSegments..., ...args]: only the script path is joined
    // against ROOT. Joining the whole array looked for tools/daemon.js/stop,
    // which made `mc stop` die with MODULE_NOT_FOUND instead of stopping.
    const script = path.join(ROOT, ...rel.script);
    const args = [...rel.script.length ? [] : [], ...(rel.args || [])];
    void args;
    const child = spawn(process.execPath, [script, ...(rel.args || [])], {
      cwd: ROOT, stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    if (!opts.inherit) {
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
    }
    child.on('exit', c => res(opts.inherit ? `exited ${c}` : (out.trim() || `exited ${c}`)));
  });
}
/** Run a project tool: runTool(['tools','daemon.js'], ['stop']). */
function runTool(script, args) { return runNode({ script, args: args || [] }); }
function runShell(cmd, args) {
  return new Promise(res => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('exit', () => res(out.trim() || '(no output)'));
  });
}

/** Character-art radar, so the TUI is not required to look around. */
function renderRadarText(r) {
  const w = r.preview.width, h = r.preview.height;
  const px = r.preview.data;
  const glyphs = ' .:-=+*#%@';
  const lines = [];
  for (let y = 0; y < h; y++) {
    let l = '';
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const lum = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
      // entities override the terrain: red for mobs, cyan for players
      const ent = (r.entities || []).find(e =>
        Math.abs((e.dx / r.radius) * (w / 2) + w / 2 - x) < 1.2 &&
        Math.abs((e.dz / r.radius) * (h / 2) + h / 2 - y) < 1.2);
      if (ent) l += /player/i.test(ent.kind) ? `${C.b}P${C.off}` : `${C.r}M${C.off}`;
      else if (Math.abs(x - w / 2) < 1 && Math.abs(y - h / 2) < 1) l += `${C.g}@${C.off}`;
      else l += glyphs[Math.min(glyphs.length - 1, Math.floor(lum * (glyphs.length - 1)))];
    }
    lines.push('   ' + l);
  }
  return `${C.bold}radar${C.off} r=${r.radius} ${C.dim}(center = bot, @ = you, M = mob, P = player)${C.off}\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') { console.log(listHelp()); return 0; }
  const name = argv[0].toLowerCase();
  const alias = { 'end': 'stop', 'quit': 'stop', 'go': 'goto', 'flee': 'afk', 'fight': 'pvp', 'duel': 'pvp', 'who': 'players', 'hp': 'hearts', 'health': 'hearts' };
  const cmd = COMMANDS[name] || COMMANDS[alias[name]];
  if (!cmd) { console.error(`${C.r}unknown command: mc ${name}${C.off}\n${listHelp()}`); return 2; }
  try {
    const out = await cmd.run(argv.slice(1));
    if (out != null) console.log(typeof out === 'string' ? out : fmt(out));
    return 0;
  } catch (e) {
    console.error(`${C.r}${name} failed:${C.off} ${e.message}`);
    if (process.env.MC_DEBUG) console.error(e.stack);
    return 1;
  }
}

main().then(c => process.exit(c), (e) => { console.error(e.stack || String(e)); process.exit(1); });
