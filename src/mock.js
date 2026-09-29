'use strict';

/**
 * Offline demo mode: a generated world and a fake bot implementing the subset
 * of the mineflayer API that Actor / renderers / BotCore use.
 *
 * It exists so the whole stack — TUI, 360 panorama, radar, wander/gather,
 * anti-stuck watchdog — can be exercised without a server, and so the
 * behaviour engine can be developed and tested on a phone with no network.
 *
 *   node src/tui.js --demo
 *   node src/bot.js --demo --mode wander
 */

const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { pathfinder } = require('mineflayer-pathfinder');

const WORLD_MIN_Y = 0;
const WORLD_MAX_Y = 127;
const HALF = 72;              // world spans [-HALF, HALF] on x and z

// Deterministic 32-bit hash -> [0,1). Uses the xxhash32 finalizer, which
// avalanches every input bit; a naive XOR-shift finalizer can collapse to
// half the output range and silently erase world features.
function h2(x, z) {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

const EMPTY_BLOCKS = new Set(['air', 'water', 'lava', 'tall_grass', 'poppy', 'dandelion', 'torch']);

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

class MockWorld {
  constructor() {
    this.blocks = new Map();
    this.generate();
  }

  key(x, y, z) { return `${x},${y},${z}`; }

  set(x, y, z, name) {
    if (name === 'air' || name == null) this.blocks.delete(this.key(x, y, z));
    else this.blocks.set(this.key(x, y, z), name);
  }

  has(x, y, z) { return this.blocks.has(this.key(x, y, z)); }

  getBlock(x, y, z) {
    if (x < -HALF || x > HALF || z < -HALF || z > HALF || y < WORLD_MIN_Y || y > WORLD_MAX_Y) return null;
    const name = this.blocks.get(this.key(Math.floor(x), Math.floor(y), Math.floor(z)));
    if (!name) return null;
    return {
      name,
      position: new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)),
      boundingBox: EMPTY_BLOCKS.has(name) ? 'empty' : 'block',
      type: 1
    };
  }

  remove(x, y, z) { this.blocks.delete(this.key(Math.floor(x), Math.floor(y), Math.floor(z))); }

  /** Surface height at (x,z): highest non-empty block. */
  surfaceY(x, z) {
    for (let y = WORLD_MAX_Y; y >= WORLD_MIN_Y; y--) {
      const b = this.getBlock(x, y, z);
      if (b && b.boundingBox !== 'empty') return y;
    }
    return null;
  }

  generate() {
    const lakeCx = 26, lakeCz = -18;
    for (let x = -HALF; x <= HALF; x++) {
      for (let z = -HALF; z <= HALF; z++) {
        // rolling hills from layered sines
        const hill = Math.sin(x * 0.09) * 4 + Math.cos(z * 0.11) * 4 +
          Math.sin((x + z) * 0.05) * 3 + h2(x, z) * 2;
        let y = Math.round(66 + hill);

        const dlake = Math.sqrt((x - lakeCx) ** 2 + (z - lakeCz) ** 2);
        const beach = dlake < 19;
        const water = dlake < 13;

        const depth = 6 + Math.floor(h2(x + 7, z + 3) * 4);
        const WATER_LEVEL = 64;
        if (water) {
          // a real lake: shallow at the rim, deep in the middle, water plane at 64
          const shoreDepth = clamp((13 - dlake) * 0.9, 0, 14);
          const floor = Math.max(50, Math.min(y, WATER_LEVEL - 1) - Math.floor(shoreDepth));
          this.set(x, floor, z, 'sand');
          for (let yy = floor + 1; yy <= WATER_LEVEL; yy++) this.set(x, yy, z, 'water');
          for (let dy = 1; dy <= depth; dy++) {
            const yy = floor - dy;
            this.set(x, yy, z, yy > floor - 3 ? 'sand' : (dy < 5 ? 'dirt' : 'stone'));
          }
          this.set(x, WORLD_MIN_Y, z, 'bedrock');
          continue;
        }
        // beach: sand rim sitting just at the waterline
        const top = beach ? Math.min(y, WATER_LEVEL - 1) : y;

        for (let dy = 0; dy <= depth; dy++) {
          const yy = top - dy;
          let name;
          if (dy === 0) name = beach ? 'sand' : (yy < 64 ? 'sand' : 'grass_block');
          else if (dy <= 3) name = beach ? 'sand' : 'dirt';
          else {
            name = 'stone';
            const rr = h2(x * 3, yy * 7 + z);
            if (yy < 40 && rr > 0.97) name = 'diamond_ore';
            else if (yy < 52 && rr > 0.94) name = 'gold_ore';
            else if (rr > 0.9) name = 'coal_ore';
            else if (rr > 0.87) name = 'iron_ore';
            else if (rr > 0.85) name = 'granite';
          }
          this.set(x, yy, z, name);
        }
        // bedrock floor
        this.set(x, WORLD_MIN_Y, z, 'bedrock');

        // vegetation
        const r = h2(x * 13 + 5, z * 9 + 2);
        if (r > 0.985) {
          this.tree(x, top + 1, z, r > 0.995 ? 'birch' : 'oak');
        } else if (r > 0.975) {
          this.set(x, top + 1, z, r > 0.98 ? 'tall_grass' : (r > 0.977 ? 'poppy' : 'dandelion'));
        }
      }
    }
    // a landmark tower so the panorama has a silhouette
    for (let y = 67; y <= 92; y++) {
      for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        this.set(-34 + dx, y, -38 + dz, y > 88 ? 'glowstone' : 'stone_bricks');
      }
    }
    for (let y = 67; y <= 76; y++) this.set(-32, y, -38, 'ladder');
    // a little plank house
    for (let x = 44; x <= 50; x++) for (let z = 40; z <= 45; z++) {
      this.set(x, 67, z, 'oak_planks');
      if (x === 44 || x === 50 || z === 40 || z === 45) for (let y = 68; y <= 70; y++) this.set(x, y, z, 'oak_planks');
      this.set(x, 71, z, 'oak_planks');
    }
    this.set(47, 68, 40, 'glass'); this.set(47, 69, 40, 'glass');
  }

  tree(x, y, z, kind) {
    const log = kind === 'birch' ? 'birch_log' : 'oak_log';
    const leaf = kind === 'birch' ? 'birch_leaves' : 'oak_leaves';
    const h = 4 + Math.floor(h2(x, z) * 3);
    for (let i = 0; i < h; i++) this.set(x, y + i, z, log);
    const top = y + h;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2 && dy > 1) continue;
      if (dx === 0 && dz === 0 && dy < 2) continue;
      if (this.has(x + dx, top + dy, z + dz)) continue;
      this.set(x + dx, top + dy, z + dz, leaf);
    }
  }
}

class MockInventory {
  constructor(items) { this._items = items || []; }
  items() { return this._items.slice(); }
  slots() { return this._items; }
  /** Test helper: add an item as if it had been picked up. */
  give(name, count = 1) {
    const it = this._items.find(i => i.name === name);
    if (it) it.count += count;
    else this._items.push({ name, count, stackSize: 64 });
  }
}

// 2x2 inventory recipes the mock knows: exactly the vanilla shape the task
// chain relies on (1 log -> 4 planks, 2 planks -> 4 sticks, 3 planks + 2 sticks
// -> 1 wooden pickaxe).
const MOCK_RECIPES = {
  oak_planks: { inputs: [{ name: 'oak_log', count: 1 }], result: { name: 'oak_planks', count: 4 } },
  stick: { inputs: [{ name: 'oak_planks', count: 2 }], result: { name: 'stick', count: 4 } },
  wooden_pickaxe: {
    inputs: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
    result: { name: 'wooden_pickaxe', count: 1 }
  }
};

class MockBot extends EventEmitter {
  static MOCK_RECIPES = MOCK_RECIPES;

  constructor(world, opts = {}) {
    super();
    this._isMock = true;
    this.world = world;
    this.username = opts.username || 'AFK_Bot';
    this.game = { dimension: 'minecraft:overworld', height: WORLD_MAX_Y + 1, gameMode: 'survival' };
    this.health = 20;
    this.food = 20;
    this.foodSaturation = 5;
    this.registry = makeMockRegistry();
    this.entity = {
      position: new Vec3(0, 0, 0),
      velocity: new Vec3(0, 0, 0),
      yaw: 0, pitch: 0, eyeHeight: 1.62,
      health: 20
    };
    this.supportsFeature = () => false;
    this.inventory = new MockInventory([
      { name: 'bread', stackSize: 64, count: 12 },
      { name: 'diamond_axe', stackSize: 1, count: 1 },
      { name: 'diamond_pickaxe', stackSize: 1, count: 1 },
      { name: 'oak_log', stackSize: 64, count: 8 }
    ]);
    this.players = {};
    this.entities = {};
    this._digTime = 0;
    this._spawned = false;

    // --- fake pathfinder: mirrors the REAL mineflayer-pathfinder surface.
    // The real plugin stores state in closure variables and exposes only
    //   setGoal / setMovements / goto / stop / isMoving / isMining / isBuilding
    //   + tuning fields (thinkTimeout, tickTimeout, searchRadius, ...)
    // It has NO `goal` property and NO `isPathing`, and it EMITS on the bot
    // object (goal_reached / goal_updated / path_reset / path_stop / path_update).
    // The mock reproduces exactly that split, so the actor is exercised the
    // same way it is against a live server. src/api_contract.json is the
    // recorded source of truth for this shape.
    const self = this;
    this.pathfinder = new EventEmitter();
    this.pathfinder._goal = null;          // private, like the real closure var
    this.pathfinder.thinkTimeout = 5000;
    this.pathfinder.tickTimeout = 40;
    this.pathfinder.searchRadius = -1;
    this.pathfinder.enablePathShortcut = false;
    this.pathfinder.LOSWhenPlacingBlocks = true;
    this.pathfinder.setMovements = () => {};
    // isMoving/isMining/isBuilding are the real plugin's movement indicators.
    // `isMoving` reports *actual movement*, not merely "has a goal": the real
    // plugin returns false while it is still computing a path. Tests set
    // `_moving` to model that distinction (see tests/stuck_test.js).
    this.pathfinder._moving = false;
    this.pathfinder.isMoving = () => this.pathfinder._moving;
    this.pathfinder.isMining = () => false;
    this.pathfinder.isBuilding = () => false;
    this.pathfinder.stop = () => { this.pathfinder.setGoal(null); };
    // Path-query helpers the real plugin exposes (used by gather's tool choice
    // and by higher-level planners). Present so nothing that works live is
    // silently absent from the mock.
    this.pathfinder.getPathTo = () => null;          // returns a Path or null
    this.pathfinder.getPathFromTo = () => null;      // explicit start + end
    // `goto` is the promise-returning driver the real plugin recommends.
    this.pathfinder.goto = async (goal) => {
      this.pathfinder.setGoal(goal, false);
      return true;
    };
    this.pathfinder.bestHarvestTool = (block) => {
      // real plugin: finds the fastest tool for the block; returns a nullable
      // inventory reference. Mock returns null = 'use bare hands'.
      return null;
    };
    this.pathfinder.setGoal = (goal, dynamic) => {
      if (!goal) { this.pathfinder._goal = null; this.pathfinder._moving = false; this.emit('path_stop'); return; }
      this.pathfinder._goal = goal;
      this.pathfinder._dynamic = dynamic;
      // The mock's physics loop clears this once the goal is reached, matching
      // the real plugin's isMoving().
      this.pathfinder._moving = true;
      this.emit('goal_updated', goal, dynamic);
    };

    // a wandering zombie so the survival layer has something to react to
    const zom = {
      id: 9001,
      // mineflayer classifies via `kind` = "Hostile mobs" (a PHRASE, not
      // 'hostile') and `displayName` = "Zombie" (mobType is deprecated).
      name: 'zombie', username: 'zombie', displayName: 'Zombie',
      kind: 'Hostile mobs', isValid: true, health: 20,
      position: new Vec3(8, 0, 6), velocity: new Vec3(0, 0, 0)
    };
    this.entities[9001] = zom;
    this.players['Steve'] = { entity: null }; // offline until sim

    // spawn after a short delay, mimicking the real handshake
    setTimeout(() => this._spawn(), 400);
    // mob + physics tick
    setInterval(() => this._tick(), 120);
  }

  _spawn() {
    if (this._spawned) return;
    this._spawned = true;
    const y = this.world.surfaceY(0, 0);
    this.entity.position.set(0.5, y + 1, 0.5);
    this.players['Steve'] = { entity: { position: new Vec3(6, y + 1, -4), username: 'Steve' } };
    this.emit('spawn');
  }

  _tick() {
    if (!this._spawned) return;
    const now = Date.now();
    const e = this.entity;

    // walk toward the current goal
    const goal = this.pathfinder._goal;
    if (goal) {
      const t = goalTarget(goal);
      if (t) {
        const speed = 4.6;                                   // blocks per second
        const dt = 0.12;
        const dx = t.x - e.position.x, dz = t.z - e.position.z;
        const dist = Math.hypot(dx, dz);
        const range = goal.range || 1;
        if (dist <= range) {
          this.pathfinder._goal = null;
          this.pathfinder._moving = false;
          this.emit('goal_reached', goal);
          e.velocity.set(0, 0, 0);
        } else {
          this.pathfinder._moving = true;                    // actually walking now
          const step = Math.min(dist, speed * dt);
          e.velocity.set(dx / dist * speed, 0, dz / dist * speed);
          e.position.x += dx / dist * step;
          e.position.z += dz / dist * step;
          e.yaw = Math.atan2(-dx, dz);
        }
      }
      // clamp to ground
      const sy = this.world.surfaceY(Math.floor(e.position.x), Math.floor(e.position.z));
      if (sy != null) e.position.y = sy + 1;
    } else {
      this.pathfinder._moving = false;
      e.velocity.set(0, 0, 0);
    }

    // zombie wanders toward the bot sometimes
    const zom = this.entities[9001];
    if (zom) {
      const d = zom.position.distanceTo(e.position);
      if (d < 12 && d > 1.6) {
        const dx = e.position.x - zom.position.x, dz = e.position.z - zom.position.z;
        const l = Math.hypot(dx, dz) || 1;
        zom.position.x += dx / l * 0.05;
        zom.position.z += dz / l * 0.05;
        const sy = this.world.surfaceY(Math.floor(zom.position.x), Math.floor(zom.position.z));
        if (sy != null) zom.position.y = sy + 1;
      }
      // it bites
      if (d < 1.8 && now - (this._lastBite || 0) > 2500) {
        this._lastBite = now;
        this.health = Math.max(0, +(this.health - 1.5).toFixed(1));
        this.entity.health = this.health;
        this.emit('health');
        if (this.health === 0) this.emit('death');
      }
    }

    // slow passive regeneration when well fed
    if (this.food >= 18 && now - (this._lastRegen || 0) > 4000 && this.health < 20) {
      this._lastRegen = now;
      this.health = Math.min(20, +(this.health + 1).toFixed(1));
      this.entity.health = this.health;
      this.emit('health');
    }
  }

  /* --- mineflayer-ish API used by Actor --- */

  blockAt(pos) { return this.world.getBlock(pos.x, pos.y, pos.z); }

  findBlocks({ matching, maxDistance = 64, count = 16, minDistance = 1 }) {
    const out = [];
    const eye = this.entity.position;
    for (const [key, name] of this.blocksIterator()) {
      const [x, y, z] = key.split(',').map(Number);
      const block = { name, position: new Vec3(x, y, z) };
      if (typeof matching === 'function' ? !matching(block) : true) continue;
      const d = Math.hypot(x - eye.x, y - eye.y, z - eye.z);
      if (d > maxDistance || d < minDistance) continue;
      out.push(new Vec3(x, y, z));
      if (out.length >= count * 3) break;
    }
    out.sort((a, b) => a.distanceTo(eye) - b.distanceTo(eye));
    return out.slice(0, count);
  }

  *blocksIterator() { yield* this.world.blocks; }

  async dig(block, forceLook) {
    if (!block || !block.position) return;
    const p = block.position;
    await new Promise(r => setTimeout(r, 250));
    this.world.remove(p.x, p.y, p.z);
    this.emit('diggingCompleted', block);
  }
  stopDigging() {}

  // Crafting surface, matching mineflayer's craft.js: recipesFor/recipesAll
  // and craft all live on the BOT (not the registry). The mock implements the
  // 2x2 inventory recipes the project actually uses, so the task queue can be
  // tested end to end without a server.
  recipesFor(item, metadata, minResultCount, craftingTable) {
    if (!item) return [];
    const name = item.name || item;
    const r = MockBot.MOCK_RECIPES[name];
    if (!r) return [];
    // only return the recipe if the ingredients are actually present
    const have = (n) => this.inventory.items().reduce((s, i) => s + (i.name === n ? i.count : 0), 0);
    for (const ing of r.inputs) {
      if (have(ing.name) < ing.count * (minResultCount || 1)) return [];
    }
    return [r];
  }
  recipesAll(item) { const r = item && MockBot.MOCK_RECIPES[item.name || item]; return r ? [r] : []; }
  async craft(recipe, count = 1) {
    if (!recipe) throw new Error('no recipe');
    const inv = this.inventory;
    for (const ing of recipe.inputs) {
      const it = inv.items().find(i => i.name === ing.name);
      if (!it || it.count < ing.count * count) throw new Error(`missing ingredient ${ing.name}`);
      it.count -= ing.count * count;
    }
    inv._items = inv._items.filter(i => i.count > 0);
    const out = inv._items.find(i => i.name === recipe.result.name);
    if (out) out.count += recipe.result.count * count;
    else inv._items.push({ name: recipe.result.name, count: recipe.result.count * count, stackSize: 64 });
    this.emit('inventoryUpdate');
  }

  async equip(item, dest) { this._equipped = item && item.name; }
  async consume() {
    if (this._equipped === 'bread' || this._equipped === 'apple') this.food = 20;
    this.emit('health');
  }
  activateItem() {}
  deactivateItem() {}
  async attack(entity) {
    if (entity && entity.health != null) {
      entity.health -= 4;
      if (entity.health <= 0) { entity.isValid = false; delete this.entities[entity.id]; }
    }
  }
  async look(yaw, pitch, force) { this.entity.yaw = yaw; this.entity.pitch = pitch; }
  async lookAt(pos, force) { this.entity.yaw = Math.atan2(-(pos.x - this.entity.position.x), (pos.z - this.entity.position.z)); }
  setControlState(state, on) {}
  jump() {}
  respawn() {
    this.health = 20; this.food = 20;
    this.emit('respawn');
    setTimeout(() => this._spawn(), 100);
  }
  quit() { this._clientEnd('quit'); }
  _clientEnd(reason) {
    this._spawned = false;
    this.pathfinder._goal = null;
    this.emit('end', reason);
  }

  /* --- test helpers --- */
  simulateKick(reason) { this.emit('kicked', reason || 'simulated kick'); }
  simulateDisconnect() { this._clientEnd('simulated disconnect'); }
  simulateChat(from, msg) { this.emit('chat', from, msg); }
}

function goalTarget(goal) {
  if (!goal) return null;
  if (goal.entity && goal.entity.position) return goal.entity.position;
  if (goal.x != null && goal.z != null) return goal;
  if (goal.pos) return goal.pos;
  return null;
}

/**
 * A permissive stand-in for prismarine-registry: any `xxxByName` lookup returns
 * a container that answers every key with `{ name }`. Real mineflayer-pathfinder
 * `Movements` reads several registry tables at construction; without this it
 * throws on the mock.
 */
function makeMockRegistry() {
  const container = () => new Proxy({}, { get: (t, k) => (typeof k === 'string' ? { name: k } : undefined) });
  return new Proxy(
    { foodsByName: { bread: 1, cooked_beef: 1, apple: 1, baked_potato: 1, cooked_porkchop: 1 } },
    {
      get: (target, prop) =>
        (prop in target) ? target[prop] :
        (typeof prop === 'string' && prop.endsWith('ByName')) ? container() :
        undefined
    }
  );
}

/** Create a mock bot + world that BotCore can use in place of mineflayer. */
function createMockBot(opts) {
  const world = new MockWorld();
  return new MockBot(world, opts);
}

module.exports = { MockWorld, MockBot, createMockBot, WORLD_MIN_Y, WORLD_MAX_Y };
