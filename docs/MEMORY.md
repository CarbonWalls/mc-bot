# Memory ceiling

The target device is an entry-level **AArch64 Android phone** (Termux/proot)
with ~700 MB of RAM in total and, in practice, **~450–480 MB available** at any
one time. The bot has to share that with the Minecraft server, so its footprint
is a design constraint, not an afterthought.

## Measured ceiling: ~106 MB peak, hard cap 220 MB

| phase | RSS | notes |
|---|---|---|
| idle daemon | **85–110 MB** | baseline, includes the loaded world + entity tables |
| 512×180 panorama | **flat** | three renders in a row stay within 1 MB — no leak |
| 35 s gather | +20 MB | server-streamed chunks as the bot walks; bounded |
| **peak observed** | **106 MB** | against Paper 26.1.2, view distance 4 |

The **220 MB** figure used in the tests is deliberately generous headroom over
the 106 MB actually observed. It is a hard cap asserted by
`tests/memory_test.js`, so a change that pushes the daemon past it fails the
suite rather than OOMing someone's phone.

## Why it cannot blow up

The two unbounded-looking paths are both capped:

- **Panorama framebuffer** is clamped before allocation in `src/core.js`
  (`takeScreenshot`): width ≤ 1024, height ≤ 512. A client asking for
  8192×4096 gets 1024×512, not a 134 MB buffer.
- **World data** is bounded by the server's view distance (4 chunks) — the
  daemon never asks for more than the server sends.

There is no texture atlas, no meshing and no full-world model: rendering is a
voxel DDA raycast over the already-loaded chunk data, so a screenshot costs CPU
time, not sustained memory.

## Reproduce

```bash
node tools/measure_memory.js --seconds=35
```

Requires a running daemon against the local test server. The tool reads the
daemon's RSS from `/proc`, runs panorama → gather → panorama, and reports the
baseline, per-phase deltas, the peak, and what is retained after settling (the
leak signal).

## Honest caveat

The panorama is **CPU-bound, not memory-bound**: a 512×180 render takes ~15 s
on this device (~92 000 rays). That is the reason the IPC screenshot timeout
defaults are generous. A 1024×512 panorama would take several minutes and is
not recommended on a phone — use the TUI's preview path instead.
