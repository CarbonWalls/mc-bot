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

// --- the events this project's behaviour code subscribes to ------------------
// Perception (src/perceive.js) listens for entity damage signals, and PvP
// depends on them entirely: if mineflayer renames `entityHurt` or stops passing
// the attacker, the bot silently loses every real health signal and reverts to
// arithmetic — which is the exact bug the user reported ("it runs away even when
// it thinks it won"). Recording which event names the INSTALLED packages
// actually emit turns that from a silent regression into a test failure.
const entSrc = read('node_modules/mineflayer/lib/plugins/entities.js') || '';
const healthSrc = read('node_modules/mineflayer/lib/plugins/health.js') || '';
const emitted = uniqSorted([
  ...[...entSrc.matchAll(/bot\.emit\('([\w]+)'/g)].map(m => m[1]),
  ...[...healthSrc.matchAll(/bot\.emit\('([\w]+)'/g)].map(m => m[1])
]);
// animation / status ids that mineflayer maps onto event names, read from the
// installed source rather than from memory of the protocol
const animMap = (entSrc.match(/const animationEvents = \{([\s\S]*?)\n\}/) || [])[1] || '';
const statusMap = (entSrc.match(/const entityStatusEvents = \{([\s\S]*?)\n\}/) || [])[1] || '';
const mapNames = (body) => uniqSorted([...body.matchAll(/:\s*'([\w]+)'/g)].map(m => m[1]));
// Events reached through the id->name maps are emitted as bot.emit(eventName, ...)
// with a VARIABLE, so a regex on literal names misses them. Union all three
// sources; otherwise the contract claims mineflayer never emits entitySwingArm,
// which is false and would fail the test that guards perception.
const allEvents = uniqSorted([...emitted, ...mapNames(animMap), ...mapNames(statusMap)]);
contract.events = {
  _source: 'mineflayer/lib/plugins/entities.js + health.js — bot.emit(...) plus the animation/status id maps',
  emitted: allEvents,
  literalEmits: emitted,
  animationEvents: mapNames(animMap),
  statusEvents: mapNames(statusMap),
  // The ones src/perceive.js relies on. If any disappears, perception degrades
  // to estimates and the PvP outcomes become guesses again.
  required: [
    'health', 'death', 'respawn', 'entityHurt', 'entitySwingArm', 'entityDead',
    'entityGone', 'entitySpawn', 'entityUpdate', 'itemDrop',
    'playerJoined', 'playerLeft', 'playerUpdated'
  ],
  requiredLowLevel: ['animation'],
  damageEventHasSource: /damage_event[\s\S]{0,400}sourceCauseId/.test(entSrc)
    ? 'entities.js passes (entity, source) to entityHurt on 1.20+, so "I hurt them" is confirmable'
    : 'no damage_event source: confirmed hits can only be inferred from animation'
};

// --- player gamemode: the field that answers "is this opponent even damageable" --
contract.playerInfo = {
  _source: 'mineflayer/lib/plugins/entities.js player_info handlers',
  playerField: /player\.gamemode\s*=\s*item\.gamemode/.test(entSrc) ? 'gamemode (number 0..3)' : 'MISSING — gamemode is not read from player_info in this build',
  tabListUpdated: /update_game_mode/.test(entSrc) ? 'update_game_mode handled' : 'update_game_mode NOT handled',
  botGameMode: 'bot.game.gameMode is a NAME string ("survival"|"creative"|...) via parseGameMode'
};

// --- movement controls: what the terrain-aware controller assumes ------------
const physSrc = read('node_modules/mineflayer/lib/plugins/physics.js') || '';
contract.controls = {
  _source: 'mineflayer/lib/plugins/physics.js',
  setControlState: /bot\.setControlState\s*=/.test(physSrc),
  getControlState: /bot\.getControlState\s*=/.test(physSrc),
  clearControlStates: /bot\.clearControlStates\s*=/.test(physSrc),
  names: uniqSorted([...physSrc.matchAll(/^\s{4}(forward|back|left|right|jump|sprint|sneak):/gm)].map(m => m[1])),
  assertsOnBadName: /assert\.ok\(control in controlState/.test(physSrc),
  _note: 'setControlState throws on an unknown control name, so every call site must be inside movement.set() (try/catch) or use a verified name.'
};

// --- pathfinder jump planning: the hard 1.2 limit behind "won't climb" --------
const mvSrc = read('node_modules/mineflayer-pathfinder/lib/movements.js') || '';
contract.movements = {
  _source: 'mineflayer-pathfinder/lib/movements.js',
  // `if (blockC.height - block0.height > 1.2) return` — the guard needs the
  // closing paren matched, otherwise this records null and the contract silently
  // loses the number that justifies climbOut existing at all.
  // The guard reads `if (blockC.height - block0.height > 1.2) return`, so the
  // closing paren sits between the number and the keyword; omitting it from the
  // pattern makes this record null, which quietly deletes the justification for
  // climbOut from the contract.
  jumpHeightHardLimit: [...mvSrc.matchAll(/height - \w+\.height > ([\d.]+)\s*\)\s*return/g)].map(m => Number(m[1])).sort((a, b) => a - b)[0] || null,
  maxDropDownDefault: (mvSrc.match(/this\.maxDropDown = ([\d.]+)/) || [])[1] || null,
  allow1by1towers: /this\.allow1by1towers = true/.test(mvSrc),
  knobs: uniqSorted([...mvSrc.matchAll(/this\.(canDig|digCost|placeCost|liquidCost|allowSprinting|allowParkour|allowFreeMotion|maxDropDown|allow1by1towers) =/g)].map(m => m[1])),
  _note: 'There is NO maxJumpHeight knob: a climb taller than the hard limit cannot be PLANNED, only executed. That asymmetry (fall up to maxDropDown, climb ~1) is why hole escape is handled by src/movement.js climbOut and not by the pathfinder.'
};

// --- prismarine-physics: the authority on the yaw convention -----------------
const ppSrc = read('node_modules/prismarine-physics/index.js') || '';
const applyHeading = (ppSrc.match(/function applyHeading[\s\S]*?\n  \}/) || [])[0] || '';
contract.physics = {
  _source: 'prismarine-physics/index.js applyHeading + mineflayer lookAt',
  forwardFromYaw: '(-sin yaw, -cos yaw)',
  rightFromYaw: '(cos yaw, -sin yaw)',
  strafeFormula: /vel\.x -= strafe \* cos \+ forward \* sin/.test(applyHeading) ? 'verified in installed source' : 'CHANGED — re-derive the vectors before trusting movement.js',
  lookAtFormula: /Math\.atan2\(-delta\.x, -delta\.z\)/.test(physSrc) ? 'yaw = atan2(-dx, -dz), matches forwardFromYaw' : 'CHANGED',
  gravityIsScalar: /gravity: [\d.]+/.test(ppSrc),
  _note: 'src/movement.js basis() must keep matching these. A sign flip here is invisible except as a bot that strafes into walls.'
};

// Export for the test suite (require); print when run as a script.
module.exports = contract;
if (require.main === module) {
  contract._generatedAt = new Date().toISOString();
  console.log(JSON.stringify(contract, null, 2) + '\n');
}
