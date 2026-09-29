'use strict';

/**
 * Block -> RGB colour lookup used by the panorama and radar renderers.
 *
 * No texture files are needed: every block maps to a single representative
 * colour. Well-known blocks use a hand-picked palette; everything else falls
 * back to a deterministic colour derived from the block name, so an unknown
 * block always renders the same colour on every machine.
 */

// 16 dye colours (Java edition order)
const DYES = {
  white: [249, 249, 249], light_gray: [157, 157, 165], gray: [71, 71, 79],
  black: [31, 31, 35], brown: [127, 86, 54], red: [178, 49, 44],
  orange: [222, 111, 26], yellow: [229, 190, 46], lime: [106, 187, 46],
  green: [83, 123, 46], cyan: [37, 142, 151], light_blue: [58, 175, 217],
  blue: [53, 88, 187], purple: [167, 80, 196], magenta: [206, 92, 178],
  pink: [233, 138, 178]
};

const PAL = {
  // ground
  grass_block: [108, 158, 71], dirt: [134, 96, 63], coarse_dirt: [122, 85, 54],
  podzol: [110, 85, 58], mycelium: [126, 100, 116], moss_block: [87, 110, 74],
  grass_path: [150, 122, 74], farmland: [122, 88, 58],
  sand: [219, 207, 163], red_sand: [190, 112, 62],
  gravel: [128, 126, 130], clay: [158, 156, 160],
  // stone
  stone: [127, 127, 127], andesite: [125, 124, 123], granite: [163, 123, 108],
  diorite: [214, 214, 210], cobblestone: [117, 117, 117],
  mossy_cobblestone: [101, 116, 95], stone_bricks: [121, 121, 121],
  cracked_stone_bricks: [109, 109, 109], mossy_stone_bricks: [104, 117, 96],
  granite_bricks: [155, 116, 102], andesite_bricks: [116, 115, 114],
  diorite_bricks: [199, 199, 195], deepslate: [74, 74, 78],
  cobbled_deepslate: [79, 77, 82], deepslate_bricks: [83, 81, 86],
  tuff: [130, 124, 116], calcite: [247, 247, 242], dripstone_block: [148, 128, 100],
  pointed_dripstone: [156, 134, 105], smooth_basalt: [92, 92, 99],
  basalt: [82, 82, 88], blackstone: [69, 66, 71], end_stone: [222, 219, 191],
  bedrock: [61, 61, 65], obsidian: [21, 16, 32],
  // ores (bare + deepslate variants tinted darker)
  coal_ore: [113, 111, 113], iron_ore: [178, 148, 122], copper_ore: [166, 126, 92],
  gold_ore: [158, 136, 54], diamond_ore: [124, 205, 216], emerald_ore: [108, 190, 108],
  lapis_ore: [44, 84, 176], redstone_ore: [159, 54, 45], nether_quartz_ore: [200, 178, 158],
  nether_gold_ore: [196, 152, 86], ancient_debris: [134, 92, 66],
  coal_block: [22, 22, 24], iron_block: [216, 216, 216], gold_block: [244, 208, 72],
  diamond_block: [122, 240, 248], emerald_block: [58, 214, 96], lapis_block: [42, 78, 166],
  redstone_block: [157, 43, 34], copper_block: [176, 116, 74],
  // wood
  oak_log: [104, 74, 44], birch_log: [167, 139, 102], spruce_log: [63, 44, 28],
  jungle_log: [89, 59, 31], acacia_log: [138, 77, 47], dark_oak_log: [62, 42, 26],
  mangrove_log: [96, 42, 35], cherry_log: [160, 106, 108], bamboo: [158, 172, 94],
  oak_planks: [162, 131, 74], birch_planks: [186, 157, 104], spruce_planks: [122, 90, 56],
  jungle_planks: [136, 102, 57], acacia_planks: [166, 104, 64], dark_oak_planks: [96, 67, 42],
  mangrove_planks: [110, 60, 50], cherry_planks: [196, 138, 132],
  // leaves (slightly darker than "grass" so forests read as forests)
  oak_leaves: [71, 117, 55], birch_leaves: [96, 135, 63], spruce_leaves: [61, 89, 62],
  jungle_leaves: [66, 105, 47], acacia_leaves: [94, 113, 45], dark_oak_leaves: [53, 80, 44],
  mangrove_leaves: [73, 99, 50], cherry_leaves: [126, 158, 86], azalea_leaves: [92, 122, 78],
  flowering_azalea_leaves: [116, 143, 92],
  // fluids
  water: [58, 102, 196], lava: [214, 108, 32], bubble_column: [88, 130, 200],
  // ice & snow
  ice: [146, 186, 244], packed_ice: [132, 168, 228], blue_ice: [112, 152, 220],
  frosted_ice: [168, 204, 248], snow_block: [244, 247, 250], snow: [244, 247, 250],
  // desert / mesa
  sandstone: [214, 198, 152], red_sandstone: [186, 105, 58],
  cut_sandstone: [209, 193, 147], chiseled_sandstone: [216, 200, 154],
  smooth_sandstone: [218, 202, 156], terracotta: [158, 97, 70],
  // nether
  netherrack: [115, 48, 42], soul_sand: [78, 61, 48], soul_soil: [86, 69, 56],
  glowstone: [166, 128, 50], nether_bricks: [53, 40, 36],
  red_nether_bricks: [77, 47, 42], nether_wart_block: [125, 46, 62],
  warped_wart_block: [54, 92, 96], magma_block: [148, 74, 32],
  quartz_block: [235, 230, 214], smooth_quartz: [232, 228, 213],
  // vegetation / decorative (kept muted so they do not dominate)
  cactus: [88, 140, 72], pumpkin: [206, 124, 33], carved_pumpkin: [196, 116, 28],
  jack_o_lantern: [214, 148, 42], melon: [125, 174, 66], hay_block: [196, 168, 76],
  wheat: [196, 168, 76], carrots: [212, 128, 52], potatoes: [158, 122, 64],
  beetroots: [122, 42, 58], melon_stem: [122, 158, 62], pumpkin_stem: [132, 168, 72],
  sugar_cane: [168, 196, 116], kelp: [96, 130, 90], kelp_plant: [86, 120, 84],
  sea_grass: [102, 148, 92], tall_seagrass: [96, 142, 88], sea_lantern: [158, 198, 178],
  coral_block: [180, 120, 120], tube_coral_block: [110, 150, 196],
  // lights
  torch: [255, 186, 90], lantern: [222, 176, 92], shroomlight: [216, 138, 92],
  end_rod: [248, 248, 240], sea_pickle: [146, 196, 118], froglight: [184, 220, 130],
  // utility
  crafting_table: [162, 121, 66], furnace: [136, 136, 136], blast_furnace: [136, 136, 136],
  smoker: [136, 136, 136], anvil: [78, 78, 82], enchanting_table: [96, 84, 142],
  bookshelf: [150, 118, 68], chest: [148, 108, 62], ender_chest: [96, 76, 96],
  barrel: [158, 122, 74], loom: [158, 122, 74], cartography_table: [158, 122, 74],
  grindstone: [136, 136, 136], stonecutter: [140, 140, 140], smithing_table: [110, 110, 116],
  cauldron: [96, 96, 100], brewing_stand: [120, 118, 122], beacon: [108, 220, 220],
  conduit: [150, 200, 210], respawn_anchor: [128, 60, 90], lodestone: [130, 130, 134],
  spawner: [60, 62, 70], jukebox: [150, 114, 64], note_block: [150, 114, 64],
  // rails & redstone (subtle)
  rail: [150, 134, 96], powered_rail: [198, 160, 62], detector_rail: [176, 168, 164],
  redstone_wire: [168, 44, 36], repeater: [176, 132, 88], comparator: [188, 150, 92],
  piston: [172, 172, 172], sticky_piston: [150, 150, 132], observer: [152, 152, 152],
  dispenser: [140, 140, 140], dropper: [140, 140, 140], hopper: [120, 120, 120],
  // glass
  glass: [212, 224, 230], glass_pane: [206, 218, 226], tinted_glass: [44, 48, 54],
  // misc building
  bricks: [150, 96, 78], nether_brick_fence: [70, 52, 48], brick_stairs: [150, 96, 78],
  iron_bars: [160, 160, 160], chain: [150, 150, 152], iron_block_legacy: [200, 200, 200],
  bookshelf_legacy: [150, 118, 68], ladder: [160, 124, 72], scaffold: [180, 170, 140],
  // candles, thatch
  hay: [196, 168, 76], dried_kelp_block: [62, 80, 54], bone_block: [226, 224, 210],
  // entity-ish / world gen
  portal: [54, 26, 94], end_portal: [30, 30, 40], end_gateway: [40, 40, 60],
  fire: [226, 120, 32], soul_fire: [90, 140, 190], lightning_rod: [168, 170, 176],
  // ore-deepslate tints
  deepslate_coal_ore: [86, 85, 88], deepslate_iron_ore: [126, 106, 92],
  deepslate_copper_ore: [122, 94, 72], deepslate_gold_ore: [120, 105, 60],
  deepslate_diamond_ore: [88, 148, 158], deepslate_emerald_ore: [80, 138, 84],
  deepslate_lapis_ore: [42, 66, 128], deepslate_redstone_ore: [112, 44, 40]
};

function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToRgb(h, s, l) {
  h /= 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = hue2rgb(h + 1 / 3); g = hue2rgb(h); b = hue2rgb(h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function dyeOf(name) {
  for (const dye of Object.keys(DYES)) {
    if (name.endsWith('_' + dye) || name.startsWith(dye + '_')) return DYES[dye];
  }
  return null;
}

const DYEABLE = /(wool|concrete|concrete_powder|terracotta|glazed_terracotta|carpet|stained_glass|stained_glass_pane|banner|wall_banner|bed|candle|candle_cake|shulker_box|bulletin)$/;
const STRIPPED = /^stripped_/;

// Blocks that should be ignored by the panorama raycaster even if the version's
// block data lacks a boundingBox field.
const PASS_THROUGH = new Set([
  'air', 'cave_air', 'void_air',
  'tall_grass', 'grass', 'fern', 'large_fern', 'dead_bush', 'vine', 'glow_lichen',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac', 'rose_bush',
  'peony', 'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch',
  'redstone_wire', 'wheat_seeds', 'beetroots', 'potatoes', 'carrots',
  'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule',
  'sugar_cane', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass',
  'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'ladder', 'cobweb', 'snow', 'carpet'
]);

/**
 * Representative colour for a block name. Always returns a fresh [r,g,b].
 */
function colorFor(name) {
  if (!name) return [40, 40, 40];
  let c = PAL[name];
  if (c) return [c[0], c[1], c[2]];
  if (STRIPPED.test(name)) { c = PAL[name.replace(STRIPPED, '')]; if (c) return [c[0] + 14, c[1] + 10, c[2] + 6]; }
  if (DYEABLE.test(name)) { const d = dyeOf(name); if (d) return [d[0], d[1], d[2]]; }
  const h = hashName(name);
  // Muted, earthy fallback: low saturation, mid lightness, hue from name hash.
  return hslToRgb(h % 360, 0.30, 0.44);
}

/**
 * True when a block is visually/physically "empty" and a ray should pass it.
 * Uses the block's `boundingBox` metadata when available, else the name list.
 */
// Blocks that are passable (empty collision) but must still be painted by the
// renderer — otherwise lakes and lava lakes would be invisible.
const VISIBLE_FLUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);

function isEmptyBlock(block) {
  if (!block) return true;
  const name = block.name;
  if (PASS_THROUGH.has(name)) return true;
  if (VISIBLE_FLUIDS.has(name)) return false;   // fluids are passable but visible
  if (block.boundingBox) return block.boundingBox === 'empty';
  if (Array.isArray(block.shapes) && block.shapes.length === 0) return true;
  return false;
}

/** Multiply a colour by a scalar (lighting). */
function shade(c, f) {
  return [
    Math.max(0, Math.min(255, Math.round(c[0] * f))),
    Math.max(0, Math.min(255, Math.round(c[1] * f))),
    Math.max(0, Math.min(255, Math.round(c[2] * f)))
  ];
}

/** Linear blend of two colours, t in [0,1] (0 => a, 1 => b). */
function blend(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

module.exports = { colorFor, isEmptyBlock, shade, blend, DYES, PAL };
