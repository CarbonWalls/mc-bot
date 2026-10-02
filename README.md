# AFK Minecraft Bot

A passive-by-default Minecraft bot that can also be switched into a fully
autonomous one: walk to waypoints, wander, chop wood, come home, flee and fight
to stay alive, duel other players — all driven from a terminal UI dashboard with
a live radar and 360° panorama screenshots, or from a single CLI command, `mc`.

Built with [mineflayer](https://github.com/PrismarineJS/mineflayer). No Microsoft
or Mojang authentication is involved — the server is in offline mode, so the bot
uses a fake offline-profile username.

**The default is still inert.** With a stock config the bot logs in and holds a
player slot without moving, chatting, digging or attacking. Every active
behaviour is opt-in.

### What it does on real ground

The bot is terrain-aware, which sounds like a small thing and was not: it used to
work only on flat ground and could not jump. Two independent causes, both fixed:

- **nothing ever issued a jump.** The only `jump` calls in the codebase were a
  random 25% chance while fleeing and a 500 ms pulse in the stall watchdog.
  A jump pulse against a one-block step moves a bot exactly zero blocks: in
  Minecraft a step needs `forward` **and** `jump` held on the same tick as the
  collision. `src/movement.js` now probes the ground along the direction of
  travel and holds both together.
- **destinations were computed as if the world were flat.** Escape vectors were
  `position*2 - threat` and goals were `topSolidY` guesses, so a target could sit
  in a gully, on a ledge, or above a drop the pathfinder refuses to take. It
  answered `path_stop`, the goal resolved to AFK, and the bot froze — which is
  exactly why a single block of falling used to end it: after the fall, the next
  arithmetic target was unreachable in the same way, forever.

Now every candidate destination is scored against the actual world
(`src/terrain.js`): distance from the threat, how far it must climb, whether the
cell has any exit that is not the way it came. Cliff edges are detected by
looking one column *past* the cell — a spot can be perfectly standable and still
be the rim of a drop — and a hole is escaped by walking to the lip and jumping it,
because the pathfinder cannot plan a 2-block climb at all.

---

## Which Minecraft version can this join?

The bot can join a server only when the installed `minecraft-data` ships a data
directory for that server's **protocol number**. That is the whole rule, and it is
worth stating as a rule rather than a status report, because both sides move: the
server owner updates Paper, and `npm update minecraft-data` adds protocols.

What the installed `minecraft-data` (3.117.0) supports right now, computed from
the package rather than from memory:

| protocol | version | joinable? |
|---|---|---|
| 768 | 1.21.3 | ✓ |
| 769 | 1.21.4 | ✓ |
| 770–773 | 1.21.5 / 1.21.6 / 1.21.8 / 1.21.9 | ✓ |
| **774** | **1.21.11** | **✓ — what betahhd runs, joined and tested live** |
| **775** | **26.1** | ✓ (the highest supported) |
| 776 | 26.2 | ✗ — indexed, but no data directory published yet |

**Don't read a table to find your server — ask the bot:**

```bash
mc targets            # probes every known address, says which are joinable
mc targets --save     # and writes the best one into config/config.json
```

`mc targets` is the answer to "which address should the config use", because that
question has no permanent answer: Aternos regenerates `*.aternos.host` names when
a server restarts or is renamed, and the protocol number changes when the owner
upgrades Paper. The probe is re-run every time; a table in a README goes stale in
a week (two did, on this project — see below).

When the server really is too new, the bot **pings first, checks the protocol, and
stops with an actionable message** instead of reconnect-looping, because hammering
an unreachable server keeps the box empty and invites Aternos's idle hibernation.
A *stopped* server is deliberately not treated the same way — see
[Stopped is not unsupported](#stopped-is-not-unsupported).

For live testing there is no bundled rig in this checkout; point the bot at any
joinable server (`mc targets` will name one), or use `mc demo`, which drives the
whole behaviour stack against the offline generated world with no server at all.

---

## Target server

`config/config.json` ships with the address that is currently **joinable and
actually tested**:

```
betahhd.aternos.me:49851     # Paper 1.21.11, protocol 774 — bot joins, verified live
```

This replaced `4of5.aternos.me:44640` as the default, and the reason is worth
keeping, because it is the kind of claim a README gets wrong silently: 4of5 now
answers the status ping as **Paper 26.2 / protocol 776**, for which no published
`minecraft-data` ships a data directory. The bot cannot join it at all, so a
default that points there is a default that fails. Verify either claim yourself
with `mc targets`.

Two caveats that are properties of Aternos, not of this bot:

- **`*.aternos.host` names rotate.** Aternos regenerates them when a server is
  restarted or renamed, so the address stops resolving. `*.aternos.me` addresses
  have been the stable form here.
- **The box sleeps when nobody joins** (observed: betahhd stops after ~6 minutes
  with zero players). This bot counts as a player, so leaving it connected is what
  keeps the server up — which is the point of an AFK bot. A stopped server is
  waited out rather than treated as a failure; see below.

**Bedrock (console/mobile) players can join the same address and port** on this
server family. The Aternos front-end multiplexes Java and Bedrock on the server's
own port; the Bedrock side is served by Geyser. See [Bedrock](#bedrock) below.

---

## Quick start

```bash
cd ~/mc-bot                                   # this project

# 1. Install dependencies (project-local only, ~95 packages)
export npm_config_cache="$PWD/.npm-cache"
export TMPDIR="$PWD/tmp"
npm install --no-audit --no-fund \
  --fetch-retries=8 --fetch-retry-mintimeout=2000 \
  --fetch-timeout=300000 --maxsockets=4

# 2. Find a server the bot can actually join, then check it is up
./mc targets                                  # probes known addresses: joinable / stopped / too new
python3 src/probe.py betahhd.aternos.me 49851  # raw Java status ping, read-only

# 3. Start the bot, and drive it
./mc start                                    # detached daemon
./mc status                                   # hearts, mode, position, last duel
./mc pvp Steve hard                           # that's the whole interface
```

> **Aternos sleeps when empty.** betahhd was observed stopping after ~6 minutes
> with zero players. `./mc start` fixes that by itself (the bot counts as a
> player), but a bot pointed at a *sleeping* server must wait rather than fail —
> which is what [Stopped is not unsupported](#stopped-is-not-unsupported) is
> about. If `mc targets` says "stopped", start the server from the Aternos panel.

`./mc` is one word per argument — no `bash`, no `./x.sh "quoted line"`, no
embedded quotes around the whole command. See [The `mc` CLI](#the-mc-cli).

To put it on your `$PATH` instead of using `./`:

```bash
npm link                # from the project directory
mc status
```

Foreground and bounded runs still work:

```bash
npm start                       # foreground daemon
node src/bot.js --duration 900  # foreground, exit after 15 minutes
./mc start -f                   # same, through the CLI
./mc demo                       # no server at all: offline world, full stack
```

To run it detached the old way:

```bash
(nohup node "$PWD/src/bot.js" > "$PWD/logs/afk.log" 2>&1 &)
```

> **Backgrounding gotcha:** write it as `(cd DIR && nohup cmd &)`. The form
> `cd DIR && nohup cmd &` backgrounds the *entire* `cd && nohup` chain, so any
> following foreground command runs in the original directory and relative paths
> break. `./mc start` does the right thing, which is why it exists.

### The `mc` CLI

Every command talks to the running daemon over its UNIX socket (`run/bot.sock`),
so the bot is never restarted to be told something. `mc help` lists all of them.

```bash
./mc start                      # detached; --demo for the offline world
./mc stop | status | doctor     # lifecycle and self-test
./mc logs --errors              # tail, filtered
./mc tui                        # the dashboard

./mc goto 100 -20               # x z (surface found) or x y z (exact)
./mc come | home 12 64 -8 | wander 60 | gather 96
./mc follow Steve 3 | attack zombie | eat | survive on
./mc pickaxe 2 | craft oak_planks 8

./mc pvp Steve hard             # rookie | easy | medium | vet | hard | 0..1
./mc pvp Steve stop
./mc pvp hp Steve 8             # correct the estimate after watching them eat
./mc pvp Steve hard --explain   # print the exact AI prompt, send nothing
./mc hearts                     # your hearts + gamemode
./mc hearts Steve               # their gamemode, health, and where the number came from
./mc result                     # how the last duel ended, and on what evidence
./mc ai assist | force | off    # external decision advisor (default off)
./mc players | jump | climb | radar 12 | shot
```

`mc doctor` answers the questions that used to require reading logs: is a daemon
running, is its pid stale, can it see the world, what is the ground in front of
it, which package versions are installed.

### Controlling a running bot

```bash
./mc stop                       # graceful: quit packet, then exit 0
node tools/daemon.js status     # pid + socket, no CLI needed
```

Do not `pkill -f src/bot.js`: it matches the caller's own shell. The daemon writes
`run/bot.pid`, and both `mc stop` and `tools/daemon.js` target that exact process.
SIGINT and SIGTERM both trigger a clean shutdown — a proper disconnect packet, up
to 3 s, then exit 0.

---

## Configuration

Everything lives in `config/config.json`. Defaults are merged over the file, so
you only need to set what you want to change.

| Field | Default | Meaning |
|---|---|---|
| `host` | `betahhd.aternos.me` | Server hostname (see [Target server](#target-server)) |
| `port` | `49851` | Server port (Java **and** Bedrock) |
| `username` | `AFK_Bot` | In-game name (offline mode — no auth) |
| `version` | `auto` | Minecraft version; `auto` negotiates from the server ping |
| `auth` | `offline` | Must stay `offline`; the server is not in online mode |
| `checkTimeoutMs` | `45000` | mineflayer keep-alive check interval |
| `connectTimeoutMs` | `60000` | Watchdog: give up waiting for spawn after this |
| `reconnect.*` | see below | Automatic reconnect behaviour |
| `antiIdle.*` | see below | Anti-idle behaviour |
| `behaviors.*` | see below | The behaviour engine: modes, survival, terrain, PvP, AI |
| `logging.*` | see below | Log destinations |

### `behaviors`

Everything that can move the bot, arm the survival layer, or start a duel. The
shipped config leaves `mode: "afk"` and `survive.enabled: false`, so a fresh
install is still the passive bot.

```json
"behaviors": {
  "mode": "afk",
  "survive": {
    "enabled": false,
    "eatAt": 16,
    "fleeHealth": 10,
    "nightFleeRadius": 12,
    "attack": true,
    "autoRespawn": true
  },
  "stuckTimeoutMs": 6000,
  "maxStuckAttempts": 4,
  "goalTimeoutMs": 300000,
  "canDig": true,
  "allowSprinting": true,
  "gotoRange": 3,
  "movements": { "maxDropDown": 2 },
  "pvp": {
    "reach": 3.0,
    "retreatHp": 6,
    "safeHp": 12,
    "maxDrop": 1,
    "descendMax": 3,
    "verifyMs": 4000,
    "autoEat": true,
    "ai": "off"
  },
  "ai": { "pvp": "off", "ttlMs": 1200 }
}
```

| Field | Meaning |
|---|---|
| `movements.maxDropDown` | The largest drop the **pathfinder** will plan. Capped at 2 because a 3-block drop starts fall damage *and* the plugin cannot plan the climb back out — the asymmetry that used to strand the bot in holes. |
| `pvp.reach` | The server's melee reach. Paper defaults higher than vanilla (~4.5); set it to what your server actually allows or the bot swings at air. |
| `pvp.retreatHp` | Below this the bot stops swinging to **verify** the number. It does not flee: see [Reading hearts](#reading-hearts-and-game-mode). |
| `pvp.descendMax` | Largest step down the *duel* will take to close on a target. Deliberately larger than `maxDrop`: refusing every drop means never fighting anyone standing one block below you. |
| `pvp.verifyMs` | How long the verify-pause lasts before the estimate is re-anchored on confirmed hits and the fight resumes. |
| `behaviors.ai.pvp` | `off` \| `assist` \| `force` for the external decision advisor. See [The decision advisor](#the-decision-advisor). |

### `reconnect`

```json
"reconnect": {
  "enabled": true,
  "initialDelayMs": 5000,
  "maxDelayMs": 120000,
  "multiplier": 1.75,
  "jitterMs": 2000,
  "maxAttempts": 25,
  "exitOnGiveUp": true
}
```

Exponential backoff with jitter: `min(maxDelay, initial × multiplier^(n-1)) + rand(jitter)`.
The attempt counter resets to zero on the next successful spawn, so a stable
connection never inflates the delay. If `enabled` is false, the process exits
after the first disconnect.

`maxAttempts` exists because of an observed failure: backoff caps at `maxDelayMs`,
so a wrong host/port produced an endless retry loop at the cap — one daemon
logged **694 connects over 24 hours** against a dead address. Retrying is only
rational if something might change, so after `maxAttempts` with no successful
spawn the bot stops and says what to check (`mc doctor`, `src/probe.py`) instead
of hammering quietly forever.

### `antiIdle`

```json
"antiIdle": {
  "enabled": true,
  "intervalMs": 90000,
  "maxYawDeltaDeg": 12,
  "movement": false
}
```

Every 90 s the bot nudges its look direction by up to ±12° from its original
heading — just enough to reset the server's idle timer, not enough to look like
a player. `movement: false` is enforced: the bot never walks. There is no chat,
no whispering, no block breaking, no attacking, and no inventory handling
anywhere in the code. Chat and whisper events are logged and ignored.

### `logging`

```json
"logging": {
  "level": "info",
  "file": "logs/bot.log",
  "jsonl": "logs/bot.jsonl",
  "statusFile": "logs/status.json"
}
```

Three formats at once: human-readable `bot.log`, newline-delimited JSON
`bot.jsonl` for tooling, and a constantly-overwritten `status.json` snapshot for
a quick `cat`.

### Command-line overrides

Any of these take precedence over the config file:

```bash
node src/bot.js --host betahhd.aternos.me --port 49851 \
                --username AFK_Bot --version auto --duration 900
```

`--duration <seconds>` shuts the bot down cleanly after that long — useful for
bounded test runs. `--config <path>` loads a different config file, and
`BOT_CONFIG=<path>` does the same via the environment.

---

## Logs

```bash
tail -f logs/bot.log       # human-readable
tail -f logs/bot.jsonl     # one JSON object per line
cat logs/status.json       # current snapshot
```

`status.json` tracks `state`, `connects`, `spawns`, `disconnects`, `kicks`,
`errors`, the last spawn/disconnect timestamps, the last kick reason, and
process uptime.

---

## Testing

```bash
npm test                          # offline suite (220+ checks, no network)
node tools/live_integration.js    # end-to-end against the local Paper rig
node tools/measure_memory.js      # memory ceiling (see docs/MEMORY.md)
./mc doctor                       # is a daemon running, and can it see the world?
./mc demo goto 12 12              # drive the behaviour engine offline, with terrain
```

The offline suite is split into focused files, each self-registering into
`run_tests.js`:

| file | covers |
|---|---|
| `tests/api_contract_test.js` | mock must match the real plugin surface; events, controls, yaw convention, gamemode plumbing |
| `tests/version_probe_test.js` | unsupported-version detection is correct |
| `tests/memory_test.js` | render caps bound the memory footprint; the new trackers/caches are bounded too |
| `tests/survival_test.js` | hostile classification, night window, gather targets |
| `tests/stuck_test.js` | the watchdog recovers real stalls without false alarms |
| `tests/terrain_test.js` | **the flat-ground suite**: steps need a jump, cliffs are refused, holes are climbed, strafes go the right way |
| `tests/pvp_test.js` | **the hearts suite**: gamemode reads, confirmed vs estimated hits, verdicts that cannot be invented, duels that survive terrain |
| `tests/jev_test.js` | the advisor: prompt shape, weight logic, cache identity, and every failure path returning null |
| `tests/death_test.js` | death position is recorded and recovered |
| `tests/tasks_test.js` | the task queue stops on failure; crafting math |
| `tests/tui_test.js` | keys, resize, disconnect, malformed payloads |
| `tests/metrics_test.js` | Prometheus text and the HTTP endpoint |

The async tests run **sequentially**, not concurrently. They were previously both
silently skipped (the synchronous `test()` helper never awaited them, so 14
behaviour tests were decorative) and, once fixed, launching all of them at once
made them compete for the event loop so that timing assertions failed for reasons
unrelated to the behaviour under test.

### Why the mock is generated, not hand-written

Every live bug in this project's history came from the offline mock inventing an
API the real `mineflayer-pathfinder` does not have: an `isPathing()` method, a
public `goal` property, `findBlocks` returning block objects instead of
positions, and `entity.kind === 'hostile'` where the real value is the phrase
`"Hostile mobs"`. Each one passed every offline test and broke on a live server.

So the mock is now held to a **machine-recorded contract**. `tools/record_api.js`
scans the installed packages for the surface the bot depends on and writes
`src/api_contract.json`; the test suite asserts the mock satisfies it and that
the contract itself matches the installed packages. The next time a plugin
upgrade changes the real API, the suite fails instead of shipping a bot that
works offline.

What the contract now records, beyond the pathfinder surface:

| section | why it is in the contract |
|---|---|
| `events.emitted` / `events.required` | Perception subscribes by **name**. `entityDeath`, `entityRemoved`, `playerGone` and `bot.on('animation')` do not exist in mineflayer — the real names are `entityDead`, `entityGone`, `playerLeft`. A listener on a name that nothing emits fails *silently*: no error, no crash, just a bot that has quietly stopped seeing damage. That is exactly the regression that turns "read the hearts" back into "guess the hearts". |
| `playerInfo` | gamemode is how the bot knows an opponent cannot be hurt at all. |
| `controls` | `setControlState` **asserts** on an unknown control name, so the list must match. |
| `physics` | the yaw convention, read from `prismarine-physics`' `applyHeading`. A sign flip here is invisible except as a bot that strafes into walls — and two separate sign errors were made and caught by tests while building this. |
| `movements` | the hard-coded 1.2-block jump limit and the `maxDropDown` default, which together justify `climbOut` existing rather than asking the pathfinder to plan a climb. |

### The mock's own blind spot (why the terrain bugs survived so long)

`MockWorld.getBlock(x, y, z)` only accepted three numbers, but every terrain
query calls `world.getBlock(new Vec3(...))` — the form mineflayer itself uses.
Object arguments are `NaN` in arithmetic, so the mock answered *"outside the
world"*, `topSolidY` returned `null`, and the code concluded the column was
unloaded. In other words **the offline mock agreed with the flat-ground
assumption by accident**, which is why a whole class of terrain bugs was
untestable, and why writing tests for them required fixing the mock first.

Three more fidelity gaps were found the same way and closed:

- the mock moved the bot by writing `position` directly, so a bot that never
  jumped still travelled anywhere. It now consumes the *control states* through a
  real physics step: a one-block step stops the bot unless `forward` **and**
  `jump` are both held.
- there was no terrain a test could control, so `MockWorld.arena()` was added
  (flat / step / wall / cliff / pit / slope from a height map).
- `bot.players['Steve']` was an entity, not a *player record*, so
  `player.gamemode` never existed and the creative-opponent fix could not be
  exercised offline at all.

If the contract test fails, regenerate it and review the diff:

```bash
node tools/record_api.js > src/api_contract.json
```

Anything that changes in that diff is precisely the kind of thing that used to
produce "works in the mock, breaks on a live server."

### Probing the server by hand

```bash
# Which known target can the bot join right now?
node bin/mc.js targets

# Java server-list ping (status/handshake)
python3 src/probe.py betahhd.aternos.me 49851

# Bedrock unconnected ping
python3 src/bedrock_probe.py betahhd.aternos.me 49851
```

Both python probes are strictly read-only — one packet out, one packet back.

---

## Bedrock

The Bedrock endpoint shares the Java port — on this server family the proxy
multiplexes both onto the server's **own** port, so it is the same host:port as
the Java address, not 19132:

```
betahhd.aternos.me:49851
```

Confirmed live with a RakNet unconnected ping:

```
MCPE;Welcome to the server of betahhd!;2193;26.51;1;20;6677849224849247236;Another Geyser server.;Survival;1;49851;49851;
```

That is a live Bedrock MOTD — the same server name as the Java ping, the trailing
`49851;49851` is the proxy echoing the port back, and it identifies itself as a
Geyser proxy. **Do not assume the Bedrock port is 19132** — on this Aternos
family the conventional port does not respond; the proxy listens on the server's
own port. Re-check with `python3 src/bedrock_probe.py <host> <port>`; the numbers
above are one observation of one server, not a constant.

---

## Troubleshooting

### "You are using an incorrect port" — do not trust it

When the Minecraft server process is **stopped**, the Aternos TCP proxy still
accepts connections and answers the server-list ping with:

```
⚠ Error — You are using an incorrect port.
Make sure to enter the full server address.
```

This is a **proxy-generated placeholder**, not a statement about your port. It
appears even when the port is perfectly correct, purely because there is no
backend server to route to. Treat it as "server is stopped", not "wrong port".

### Stopped is not unsupported

Three server states look identical from a failed connection and need three
different reactions. Confusing them is what produced a daemon that logged **694
reconnects in 24 hours** against an address it could never join, and one that
quit permanently because a server had simply gone to sleep.

| what the ping says | meaning | what the bot does |
|---|---|---|
| `name: "● Offline"`, **protocol `-1`** | server is **stopped** (Aternos proxy answering with nothing behind it) | state `waiting_for_server`, and **wait indefinitely** — see below |
| **protocol 776** (26.2) | running, but this `minecraft-data` has no data for it | state `unsupported_version`, stop, and print what to update — retrying cannot help, and looping keeps the box empty and hibernated |
| any joinable protocol | go | connect |

The distinction lives in one pure function, `decideProbeAction()` in `src/core.js`,
because when it was inlined in `connect()` the two most consequential branches in
the daemon were reachable only by running a socket at a live server — so they were
untested, and both had bugs. `-1` was falling through the version check and being
marked fatal, which meant **a sleeping server killed the bot permanently** until a
human restarted it. Protocol `-1` is not a Minecraft version; it is the value a
*client* sends in a status handshake to mean "just give me the MOTD", so seeing it
come back means the proxy answered, not the game.

**Why a stopped server is waited on forever while an unreachable one gives up.**
Both look like a failed connection, and one of them has to stop: a wrong address
produced **694 reconnects in 24 hours**, so `reconnect.maxAttempts` now ends that
run with an actionable message. But an AFK bot exists to keep an empty Aternos box
awake, and that box sleeps in ~6 minutes — so a daemon that gave up waiting and
exited would leave nothing to bring the server back, defeating the bot's whole
purpose from a server that was merely napping. The two are told apart by what the
ping *answers*: a proxy that replies "Offline" has identified itself and the
condition, so `scheduleReconnect(…, { waitIndefinitely: true })` re-probes on a
capped cadence and **never spends the give-up budget**. A target that answers
nothing at all is treated as a real failure and does hit the ceiling. Both halves
are pinned by tests in `tests/version_probe_test.js`, including one that fails if
the exemption flag is silently dropped at the call site.

Find out which state you are actually in:

```bash
mc targets      # joinable / stopped / too-new, for every known address
mc doctor       # what the running daemon thinks, including a banned verdict
```

The same rule applies in reverse to *bans* — see the next section.

### Reconnect into a ban: the bot now refuses

Aternos can kick with

```
multiplayer.disconnect.banned.reason
"You have been idle for too long. This violates our terms of service"
```

which is a verdict about the client, not a transient failure. Observed live: the
server answered four consecutive connects with that kick and the daemon retried
each one on its own backoff schedule — which is how a temporary idle flag turns
into a permanent block.

`classifyKick()` in `src/core.js` sorts kicks into:

- **`idle_ban` / `ban`** — stop reconnecting entirely, state `banned`, and say what
to do (`mc doctor` and `mc status` show the reason). A successful spawn clears the
flag, so a lifted ban needs no restart.
- **`denied`** (server full, whitelist) — keep trying, but wait ≥60 s rather than
polling a packed server every few seconds.
- **`transient`** — ordinary blips, including `logged_in_new` (which reads like a
rejection but is what happens when a reconnect races the old session's timeout;
stopping on it would brick the bot during normal operation).

The idle ban itself is avoided by not *being* idle: `--anti-idle-movement on`, or
run an active mode. `mc doctor` warns when the config is `afk` with movement
disabled against a live server.

### The hostname stopped working after a restart

Aternos regenerates the `*.aternos.host` name when a server is restarted or
renamed, so that form is ephemeral. Use the `*.aternos.me` address, which has been
stable across restarts here — and run `mc targets` to confirm the address, the
port, and the protocol are all still what the config expects.

### The bot connects but never spawns

Check the probe output first — if you see the `⚠ Error` MOTD, the server is down
and the bot is connecting to a proxy with nothing behind it. The bot cannot
distinguish this from a real server by itself; it just waits for a spawn that
never comes until the watchdog fires.

### `npm install` fails with ECONNABORTED / errno -103

Set the project-local cache and TMPDIR as shown in *Quick start* and retry with
the fetch-retry flags. The registry connection is flaky; retries of 5–8 usually
get through.

---

## How the bot behaves

The design goal is to stay inert by default while counting as a player.

- **Passive by construction.** No chat, no whispers back, no movement, no block
  breaking, no attacking, no inventory interaction. Incoming chat is logged at
  debug level and never answered. (`npm test` asserts this.)
- **Self-healing.** A connect watchdog kills hung handshakes; exponential
  backoff reconnects after any disconnect; `uncaughtException` triggers a
  reconnect rather than a crash; `unhandledRejection` is logged without killing
  the process.
- **Knows when to stop.** If the server runs a Minecraft version the installed
  `minecraft-data` cannot speak, the bot says so once and stops instead of
  reconnect-looping (which is what gets an empty server hibernated).
- **Resigns politely.** SIGINT/SIGTERM produce a clean quit packet and exit 0.
- **Cheap to run.** Roughly 120–200 MB RSS and well under a minute of CPU per
  hour of uptime; it is happy on a small ARM box.

### Autonomous modes (opt-in)

All of these are reachable from the TUI hotkeys, the `mc` CLI, or an `exec`
command over IPC. None of them run unless asked.

| mode | behaviour |
|---|---|
| `afk` *(default)* | stand still, stay alive, log everything |
| `hold` | stay put but defend if attacked |
| `goto x y z` | pathfind to a coordinate (steps are jumped, cliffs are avoided) |
| `come` | return to the recorded home point |
| `wander [radius]` | pick reachable random points near home and walk |
| `gather [radius]` | find trees, walk to a safe spot beside each, chop the whole trunk |
| `follow [player]` | follow another player |
| `attack [mob]` | fight a specific mob |
| `pvp [player] [tier]` | duel a player — see [Dueling](#dueling-pvp) |

The **anti-stuck watchdog** is what makes these usable: while a goal is active
the bot measures real movement, and if it stalls it works through a recovery
sequence ordered by how cheap the fix is:

1. **walk toward the goal while jumping** — forward *and* jump together, held
   rather than pulsed. This alone clears most stalls, and it is the fix for
   "it doesn't jump at all".
2. **climb out of the hole it is in**, if the ground around it is higher. A
   one-cell scan finds nothing in a 3×3 pit, so the search reaches two and three
   cells out for a climbable lip and walks to it first.
3. **dig the block actually in the way** — the cell toward the goal, not the one
   it happens to be facing (a stalled pathfinder has stopped turning, so the old
   code dug air).
4. **re-plan with a terrain-checked goal**: a destination that is not standable
   from here has no route, so it is snapped to the nearest reachable surface
   before the pathfinder is asked again.
5. only then invert the goal, and only then give up and go AFK.

Three details matter more than they look:

- **A freshly set goal is not judged as stuck.** The pathfinder spends its
  first moments *computing* a route, not walking. Counting that as a stall made
  the watchdog burn every recovery attempt before the bot took a step, so it
  gave up on goals it could trivially reach. There is now a grace period after
  each goal change.
- **Proactive assistance at 2.5 s.** Waiting the full stall timeout is a waste:
  by then the pathfinder has usually already decided the route is dead. Halfway
  to the threshold the bot drives toward the goal itself for a few hundred ms,
  jumping whatever is in front — a single successful hop resets the clock and no
  recovery is ever needed.
- **When the pathfinder gives up, the goal resolves.** mineflayer-pathfinder
  emits `path_stop` when there is no route. Handling that event is the
  difference between "gave up with a logged reason" and "standing 10 blocks
  away forever, still claiming to be going there."

An active goal also gets a **minimal self-defence layer** — a bot that dies
mid-task never finishes. It hits back when hurt, flees to *reachable* ground at
low health, turns to fight when cornered with nowhere to run, retreats home when
swarmed, and resumes the interrupted goal once safe. The passive default
(`afk`/`hold`) is untouched unless the survival layer is explicitly enabled.

The escape route is the part that used to fail. It was
`position * 2 - threat`: x/z arithmetic that never consulted the world, so on
any map with relief it aimed at a gully, a ledge, or a column past a cliff — the
pathfinder said `path_stop`, and the bot stood still while being eaten. Now a
ring of candidate cells is scored against real terrain: gap from the threat,
how far it must climb, whether the cell has an exit that is not the way it came
(a pocket is not an escape). Home wins when it is both closer and safer.

### Dueling (PvP)

`mc pvp Steve hard` starts a duel against a named player. Tiers tune
*human-ness*, not damage — the damage is identical at every tier, because tuning
it would be cheating:

| tier | behaviour |
|---|---|
| `rookie` (0) | walks in a straight line, swings only when touching you, slow reactions, swings at nothing |
| `medium` (0.5) | loose spacing, occasional strafe, mostly respects its attack cooldown |
| `hard` (1) | holds the exact edge of its reach, orbits continuously with direction changes, **jumps steps**, pressures you mid-swing, disengages the instant its spacing breaks |

A continuous value works too (`0.73`), and friendly names map onto the scale:
`rookie easy medium vet hard`.

What a duel is made of:

- **Orbiting instead of beelining.** Circling at the edge of reach makes *you*
  move, and the circle is terrain-aware: it will not walk off a ledge to keep
  one. Movement is decomposed against the current yaw, so the bot can strafe
  without turning — a turn costs about a second of not being able to hit.
- **Cooldown discipline.** 1.9+ damage scales with swing charge; spamming at
  100 ms does roughly one damage per hit and leaves you open. A hard bot waits
  for ~90% charge, a rookie flails.
- **Spacing budget.** Orbiting refuses drops (never step off a rim to hold
  range); closing is allowed to descend up to `descendMax`, bounded by fall
  damage. Getting that split wrong is what made the bot stand 6 blocks away
  refusing to fight anyone standing one block below it.
- **Auto-eat** while fighting, if there is food.

### Reading hearts and game mode

The server does not send another player's health to a vanilla client. That is not
a bug in this bot; it is how the protocol works. What the bot does about it is
the interesting part.

The original design *accounted* for it: subtract weapon damage per hit, reduce by
visible armour, retreat when the total crossed a threshold. That single number
was simultaneously the victory condition and the panic button, so any drift —
a swing that missed, an enchantment, a golden apple, a relog at full health —
moved the estimate across the threshold and the bot **ran away from a fight it
had already won**. Against an opponent in creative mode it did worse: the
subtraction marched to zero, which read as "won" and "at 3 hearts, flee" at the
same time, against a player the server says cannot take damage.

Now observation and inference are separate things, and can never be confused:

| signal | source | what it can decide |
|---|---|---|
| `entityHurt` (animation 1 / status 2 / `damage_event`) | server | a hit landed; on 1.20+ the packet *names the attacker*, so "I hurt them" is confirmed, not assumed |
| `entityDead` (status 3) | server | **win** |
| `entityGone` / `playerLeft` | server | **win** on forfeit |
| `death` (ours) | server | **loss** |
| `player_info` gamemode | server | **no-fight** — creative/spectator cannot be duelled, and the bot says so instead of pretending |
| our own health drop | server | how much they hit us; calibrates the weapon estimate |
| swings that produced no packet | inference | a miss, a shield, or an unkillable target |
| the health estimate | arithmetic | **nothing that ends a duel** |

Crossing the retreat threshold on an *estimate* now pauses the attack for
`verifyMs` and re-checks, then **re-anchors the arithmetic on confirmed hits**
and resumes. A drifted number can make the bot cautious; it can no longer make it
run, and it can never invent a victory. `mc result` reports which of `win` /
`loss` / `draw` / `forfeit` / `no-fight` happened and *why*, with swings,
confirmed hits, and hits that changed nothing listed separately.

Hearts are the unit everything speaks now: `mc hearts` for your own, `mc hearts
Steve` for an opponent's gamemode, health, and **where the number came from**
(`server` or `estimate`). The TUI draws a heart bar; `hearts` = `ceil(hp / 2)`,
the vanilla display.

One subtlety worth naming, because it cost a whole debugging session: a damage
packet is **not proof of life**. Swing animations and in-flight damage events
are not synchronised with the death packet, so clearing `dead` on any hurt made
the bot swing at a corpse, erase its own win, and fight forever until the time
limit reported a draw. Only a positive health reading or a respawn may revive a
Vitals record.

### The decision advisor

An optional external classifier can be asked what a good player would do, given
everything observable about the duel. It is off by default; `mc ai assist` or
`mc ai force` turns it on. See [docs/jev-api.md](docs/jev-api.md) for the API and
for why the integration is built the way it is.

Rules the design follows, because a third-party free tier must not be allowed to
break a bot:

- **It never blocks a tick.** Decisions are fetched asynchronously and read from
  a cache. A 2 s round trip inside a 110 ms control loop is a stall, and a stall
  in PvP is a death.
- **It is allowed to fail.** 403s, rate limits, timeouts and nonsense answers all
  degrade to the local tier logic, and a repeatedly-failing endpoint is latched
  off with a backoff after 3 failures.
- **It cannot veto safety.** It chooses *how* to pressure an opponent
  (`attack press space strafe retreat bait guard disengage`), never whether to
  walk off a ledge, jump a step, or flee at 2 hearts.
- **An unconfident answer is ignored.** A flat probability distribution is noise,
  and noise acted on 9 times a second is a hazard.

`mc pvp Steve hard --explain` prints the exact state sentence and the per-option
weights that would be sent, using live bot state, without sending anything.
Without it, debugging a classifier you cannot see the input to is guesswork.

### Multi-step tasks

`exec pickaxe [n]` runs a task queue: gather enough logs → craft planks → craft
sticks → craft `n` wooden pickaxes. Each step is a precondition for the next,
and the first failure stops the queue with a logged reason — it never runs later
steps against inputs an earlier step never produced.

```
exec pickaxe 2      # wood -> planks -> sticks -> 2x wooden_pickaxe
exec craft oak_planks 8
```

### Death recovery

On death the bot records where it fell, respawns, and **walks back to pick up its
dropped items** before resuming whatever it was doing. Drops despawn after five
minutes, so a recovery older than that is skipped with a logged reason rather than
a wasted trip. The return target's height is re-resolved against the terrain —
the approach from world spawn can start at a completely different level, and a
recorded y is a guess about a place you are no longer in.

### TUI dashboard

```bash
./mc tui                        # or: node src/tui.js
```

Attaches to the running daemon over a UNIX socket and shows: live state (a
**heart bar**, food, position, gamemode, counters), the current goal, the
**ground in front of the bot** (surface height, the rise/drop of the next step,
whether it is airborne or in a hole — the numbers that make a stall explainable),
a true-colour top-down radar with mob markers, a scrolling log tail, and a
command line. During a duel a **DUEL panel** appears: opponent health *with its
source* (`server` vs `estimate`), their gamemode, swings vs confirmed hits vs
swings that did nothing, the last movement decision, and the advisor's current
intent if one is enabled. Hotkeys switch modes, `s` takes a 360° panorama,
`p` duels a player, `j` jumps, `c` climbs out, `h` prints hearts, `?` shows help.
The daemon keeps running when the TUI closes — reattach any time.

### 360° panorama

`s` in the TUI (or the `screenshot` IPC command) raycasts through the loaded
chunks around the bot and writes a single wide PNG to `screenshots/`. No texture
files are needed — block colours come from a built-in palette plus lighting, so
memory use stays trivial.

---

## Layout

```
├── package.json              mineflayer, mineflayer-pathfinder, npm scripts, `mc` bin
├── mc                        ./mc <command> — the CLI launcher (also `npm link`)
├── bin/mc.js                 the CLI itself: talks to the daemon over IPC
├── config/config.json        canonical target + behaviours (survive/pvp/ai/movements)
├── src/bot.js                entry point (daemon): lock, signals, startup
├── src/core.js               BotCore: connect, probe, watchdog, reconnect, IPC, status
├── src/actor.js              behaviour engine: modes, goals, anti-stuck, survival
├── src/terrain.js            terrain reasoning: columns, drops, escape scoring
├── src/movement.js           control-state driving: jump steps, refuse cliffs, climb
├── src/perceive.js           real signals: hearts, damage, gamemode, verdicts
├── src/pvp.js                the duel controller (spacing, orbit, cooldown, terrain)
├── src/jev.js                external decision advisor: prompt, parse, cache, backoff
├── src/tasks.js              task queue for multi-step goals (gather → craft → ...)
├── src/config.js             config loader + CLI overrides
├── src/logger.js             console + .log + .jsonl + status.json
├── src/ipc.js                UNIX-socket line-JSON protocol (daemon ↔ TUI/CLI)
├── src/tui.js                terminal dashboard
├── src/lockfile.js           single-instance daemon lock (run/bot.pid)
├── src/render.js             voxel-DDA panorama + radar renderer
├── src/colors.js             block → colour palette and lighting
├── src/png.js                zero-dependency PNG encoder
├── src/mock.js               offline world + fake bot (demo & tests), with test arenas
├── src/api_contract.json     machine-recorded real-plugin surface
├── src/probe.py              Java server-list ping
├── src/bedrock_probe.py      Bedrock RakNet unconnected ping
├── src/poller.py             single-target status poller
├── src/multi_poll.py         multi-target status poller
├── tools/record_api.js       regenerate src/api_contract.json from the packages
├── tools/daemon.js           status | stop | kill (targets the PID file)
├── tools/live_integration.js end-to-end test against the local Paper rig
├── tools/measure_memory.js   memory ceiling measurement
├── tests/                    focused offline suites (self-registering)
├── docs/MEMORY.md            measured memory ceiling and its rationale
├── docs/VERSION_GAP.md       the 26.1 → 26.2 block-palette gap
├── docs/jev-api.md            the external decision endpoint, as observed
├── results/                  recorded live test output
├── screenshots/              panorama PNGs
└── logs/                     runtime logs and status snapshot
```

---

## Constraints honoured

- **No global packages.** Everything installs under `node_modules/` in the
  project; `npm_config_cache` and `TMPDIR` are redirected into the project too.
- **No files outside the project.** All logs, caches, and temp files stay under
  the project root.
- **No relay or tunnel.** The bot connects directly to the server over plain TCP.
- **No authentication.** Offline mode only; no credentials are stored or sent.
