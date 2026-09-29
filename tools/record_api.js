#!/usr/bin/env node
/**
 * Regenerate src/api_contract.json by introspecting the INSTALLED packages.
 *
 * The whole point is that this is mechanical, not hand-written: it scans the
 * real mineflayer-pathfinder and mineflayer plugin sources for the surface the
 * bot relies on, so the recorded contract can never silently drift from
 * reality. Run it after upgrading either package:
 *
 *   node tools/record_api.js > src/api_contract.json
 *
 * Then review the diff — any change here is exactly the kind of thing that
 * previously produced "works in the mock, breaks on a live server".
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  const f = path.join(ROOT, rel);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function uniqSorted(matches) {
  return [...new Set(matches)].sort();
}

// --- mineflayer-pathfinder -------------------------------------------------
const pf = read('node_modules/mineflayer-pathfinder/index.js');

// A name is a METHOD only if the plugin ever *calls* it as `bot.pathfinder.X(`;
// anything else it references is a tuning FIELD (e.g. `= true`, `= 5000`).
function classifyPf(src) {
  const methods = new Set();
  const fields = new Set();
  const names = new Set();
  for (const m of src.matchAll(/bot\.pathfinder\.([a-zA-Z_]\w*)/g)) names.add(m[1]);
  for (const n of names) {
    // A FIELD is a literal assignment (true/false/number/string). Anything else
    // assigned is a function (arrow or declared) => a METHOD. This keeps
    // `goto = async (goal) => {...}` in methods and `thinkTimeout = 5000` in fields.
    const isLiteral = new RegExp('bot\\.pathfinder\\.' + n + '\\s*=\\s*(?:true|false|null|undefined|-?\\d+(?:\\.\\d+)?|[\'"`])').test(src);
    if (isLiteral) fields.add(n); else methods.add(n);
  }
  return {
    methods: [...methods].sort(),
    fields: [...fields].sort(),
    names: [...names].sort()
  };
}

const c = classifyPf(pf);

const contract = {
  _howToRegenerate: 'node tools/record_api.js > src/api_contract.json',
  pathfinder: {
    _source: 'mineflayer-pathfinder/index.js — every `bot.pathfinder.X` reference',
    methods: c.methods,
    fields: c.fields,
    forbidden: ['isPathing', 'goal'],
    _note: 'The real plugin stores goal state in closure variables; there is NO bot.pathfinder.goal and NO isPathing(). Compat shim: src/actor.js isPathingNow().',
    emitsOnBot: pf ? uniqSorted([...pf.matchAll(/bot\.emit\('([\w]+)'/g)].map(m => m[1])) : []
  },
  findBlocks: {
    returns: 'Vec3[] (positions, NOT block objects)',
    resolve: 'call bot.blockAt(pos) to get the Block'
  },
  entity: {
    kind: 'phrase, e.g. "Hostile mobs" — NOT the literal \'hostile\'',
    displayName: 'the non-deprecated replacement for mobType (e.g. "Zombie")',
    mobType: 'DEPRECATED — reading it prints a stack trace; do not use'
  }
};

// --- mineflayer crafting -------------------------------------------------
// craft.js puts recipesFor/recipesAll on the BOT, not the registry. Recording
// this keeps the mock honest about where the crafting surface actually lives.
const craft = read('node_modules/mineflayer/lib/plugins/craft.js');
if (craft) {
  contract.crafting = {
    _source: 'mineflayer/lib/plugins/craft.js',
    onBot: uniqSorted([...craft.matchAll(/bot\.([a-zA-Z_]\w*)\s*=/g)].map(m => m[1])),
    needsRegistry: ['prismarine-item', 'prismarine-recipe']
  };
}


// --- mineflayer plugins ----------------------------------------------------
const pluginDir = path.join(ROOT, 'node_modules', 'mineflayer', 'lib', 'plugins');
const botProps = new Set();
if (fs.existsSync(pluginDir)) {
  for (const file of fs.readdirSync(pluginDir)) {
    const src = fs.readFileSync(path.join(pluginDir, file), 'utf8');
    for (const m of src.matchAll(/bot\.([a-zA-Z_][\w]*)\s*=/g)) botProps.add(m[1]);
  }
}
contract.bot = {
  _source: 'mineflayer/lib/plugins/*.js — every `bot.X =` assignment',
  has: [...botProps].sort()
};

// Export for the test suite (require); print when run as a script.
module.exports = contract;
if (require.main === module) {
  contract._generatedAt = new Date().toISOString();
  console.log(JSON.stringify(contract, null, 2) + '\n');
}
