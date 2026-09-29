# The 26.1 → 26.2 block-palette gap

The bot renders the world from block **state IDs** the server sends, mapping them
through `minecraft-data`. When the client's data is older than the server, blocks
the server knows about resolve to nothing. This is a real caveat for the
panorama/radar, so here it is precisely rather than as a vague warning.

## The arithmetic

| | blocks | protocol |
|---|---|---|
| `minecraft-data` 3.117.0, version **26.1** | **1168** | 775 |
| target server, **26.2** | not published | 776 |

We can only characterise what 26.1 *has*, not what 26.2 *adds* — that list does
not exist in any published package. What we can say:

- **Blocks added in 1.21.x are present.** `trial_spawner`, `vault`, `crafter`,
  `heavy_core`, `copper_bulb`, `chiseled_copper`, and `copper_grate` all resolve.
  The palette is not missing a whole update family.
- **26.2-era names are absent by definition.** `breeze_rod` is the illustrative
  case: a block ID the 26.1 data simply does not have an entry for.
- **Effect on rendering is cosmetic, never fatal.** The raycaster walks the world
  by *chunk section palette index → block state ID*. An unknown ID is a lookup
  miss, which the renderer already treats as "unknown → fall back to a neutral
  colour." It cannot crash, and it cannot produce a wrong *geometry* — only an
  unrecognised texture colour.
- **Effect on pathfinding is also bounded.** Solidity for an unknown block falls
  back to the conservative default (treat as solid), which makes the bot *more*
  cautious, not less.

## What this means in practice

Against a **26.0/26.1 server** (the local rig): no gap. Rendering and movement
are accurate.

Against a **26.2 server** (the cloud target, currently unjoinable anyway for
protocol reasons): the bot would connect only once `minecraft-data` ships 26.2
data, and at that point the palette gap disappears with it. The two problems
share one fix.

## Why we did not guess at 26.2 blocks

Hand-mapping forward is how rendering bugs get baked in. The honest position is:
26.1 data is complete for 26.1, and the 26.2 delta is unknown until it ships.

## Reproduce

```bash
node -e "
const b = require('./node_modules/minecraft-data/minecraft-data/data/pc/26.1/blocks.json');
console.log('26.1 blocks:', b.length);
"
```
