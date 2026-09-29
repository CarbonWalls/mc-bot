# AFK Minecraft Bot

A passive-by-default Minecraft bot that can also be switched into a fully
autonomous one: walk to waypoints, wander, chop wood, come home, flee and fight
to stay alive — all driven from a terminal UI dashboard with a live radar and
360° panorama screenshots.

Built with [mineflayer](https://github.com/PrismarineJS/mineflayer). No Microsoft
or Mojang authentication is involved — the server is in offline mode, so the bot
uses a fake offline-profile username.

**The default is still inert.** With a stock config the bot logs in and holds a
player slot without moving, chatting, digging or attacking. Every active
behaviour is opt-in.

---

## Which Minecraft version can this join?

The bot speaks whatever the installed `minecraft-data` supports. As of this
writing that tops out at **26.1 (protocol 775)** — `mineflayer` reports it as
`latestSupportedVersion`.

| server | protocol | bot can join? |
|---|---|---|
| 1.21.3 | 768 | ✓ |
| 1.21.4 | 769 | ✓ |
| **26.1** | **775** | ✓ (best supported) |
| **26.2** | **776** | **✗ — no published `minecraft-data` yet** |

The cloud server this project was built against runs **26.2**, so the bot
cannot join it today: `minecraft-data` has a `26.2` index entry but ships no
data directory for it, and that server's ViaVersion only translates *upward*, so
an older client is hard-rejected. This is a dependency gap, not a bug — when
`minecraft-data` publishes 26.2 it becomes a one-line change.

Rather than reconnect-loop an unjoinable server (which keeps the box empty and
triggers Aternos's idle hibernation), the bot **pings first, checks the
protocol, and stops with an actionable message** if the version is unsupported.

For live testing there is a local Paper 26.1.2 rig in
`../afk-test-server` — see that project's README for why 26.1.2 was chosen.

---

## Canonical target

```
4of5.aternos.me:44640
```

This is the **universal** address for the server and the one to use. It is what
`config/config.json` ships with.

The server has appeared under several other names during testing
(`bernedoodle.aternos.host`, `medaka.aternos.host`), but those hostnames are
ephemeral: Aternos regenerates them, and the address stops working the moment
the server is restarted or renamed. `4of5.aternos.me` is the stable one.

**Bedrock (console/mobile) players can join the same address and port.** The
Aternos front-end multiplexes Java and Bedrock on `44640`; the Bedrock side is
served by Geyser. See [Bedrock](#bedrock) below.

---

## Quick start

```bash
cd /root/projects/afk-minecraft-bot

# 1. Install dependencies (project-local only, ~95 packages)
export npm_config_cache="$PWD/.npm-cache"
export TMPDIR="$PWD/tmp"
npm install --no-audit --no-fund \
  --fetch-retries=8 --fetch-retry-mintimeout=2000 \
  --fetch-timeout=300000 --maxsockets=4

# 2. Check the server is actually up before starting the bot
python3 src/probe.py 4of5.aternos.me 44640

# 3. Start the bot
npm start                       # foreground
node src/bot.js --duration 900  # foreground, exit after 15 minutes
```

To run it detached:

```bash
(nohup node "$PWD/src/bot.js" > "$PWD/logs/afk.log" 2>&1 &)
```

> **Backgrounding gotcha:** write it as `(cd DIR && nohup cmd &)`. The form
> `cd DIR && nohup cmd &` backgrounds the *entire* `cd && nohup` chain, so any
> following foreground command runs in the original directory and relative paths
> break.

### Controlling a running bot

```bash
# Find it
pgrep -af "src/bot.js"

# Stop it (graceful: sends quit packet, then exits 0)
kill -SIGINT <pid>
```

SIGINT and SIGTERM both trigger a clean shutdown: the bot sends a proper
disconnect packet, waits up to 3 s, then exits with code 0.

---

## Configuration

Everything lives in `config/config.json`. Defaults are merged over the file, so
you only need to set what you want to change.

| Field | Default | Meaning |
|---|---|---|
| `host` | `4of5.aternos.me` | Server hostname |
| `port` | `44640` | Server port (Java **and** Bedrock) |
| `username` | `AFK_Bot` | In-game name (offline mode — no auth) |
| `version` | `auto` | Minecraft version; `auto` negotiates from the server ping |
| `auth` | `offline` | Must stay `offline`; the server is not in online mode |
| `checkTimeoutMs` | `45000` | mineflayer keep-alive check interval |
| `connectTimeoutMs` | `60000` | Watchdog: give up waiting for spawn after this |
| `reconnect.*` | see below | Automatic reconnect behaviour |
| `antiIdle.*` | see below | Anti-idle behaviour |
| `logging.*` | see below | Log destinations |

### `reconnect`

```json
"reconnect": {
  "enabled": true,
  "initialDelayMs": 5000,
  "maxDelayMs": 120000,
  "multiplier": 1.75,
  "jitterMs": 2000
}
```

Exponential backoff with jitter: `min(maxDelay, initial × multiplier^(n-1)) + rand(jitter)`.
The attempt counter resets to zero on the next successful spawn, so a stable
connection never inflates the delay. If `enabled` is false, the process exits
after the first disconnect.

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
node src/bot.js --host 4of5.aternos.me --port 44640 \
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
npm test                          # offline suite (~90 checks, no network)
node tools/live_integration.js   # end-to-end against the local Paper rig
node tools/measure_memory.js     # memory ceiling (see docs/MEMORY.md)
node tools/daemon.js status      # is a daemon running, and which PID?
```

The offline suite is split into focused files, each self-registering into
`run_tests.js`:

| file | covers |
|---|---|
| `tests/api_contract_test.js` | mock must match the real plugin surface |
| `tests/version_probe_test.js` | unsupported-version detection is correct |
| `tests/memory_test.js` | render caps bound the memory footprint |
| `tests/survival_test.js` | hostile classification, night window, gather targets |
| `tests/stuck_test.js` | the watchdog recovers real stalls without false alarms |
| `tests/death_test.js` | death position is recorded and recovered |
| `tests/tasks_test.js` | the task queue stops on failure; crafting math |
| `tests/tui_test.js` | keys, resize, disconnect, malformed payloads |

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

If the contract test fails, regenerate it and review the diff:

```bash
node tools/record_api.js > src/api_contract.json
```

Anything that changes in that diff is precisely the kind of thing that used to
produce "works in the mock, breaks on a live server."

### Probing the server by hand

```bash
# Java server-list ping (status/handshake)
python3 src/probe.py 4of5.aternos.me 44640

# Bedrock unconnected ping
python3 src/bedrock_probe.py 4of5.aternos.me 44640
```

Both are strictly read-only — one packet out, one packet back.

---

## Bedrock

The Bedrock endpoint shares the Java port:

```
4of5.aternos.me:44640
```

Confirmed by a RakNet unconnected ping:

```
MCPE;Welcome to the server of FivServ!;2193;26.51;4;6;18215011712949652688;Another Geyser server.;Survival;1;44640;44640;
```

That is a live Bedrock MOTD — same text and same 4/6 player count as the Java
ping, identifying itself as a Geyser proxy. **Do not assume the Bedrock port is
19132.** On this Aternos family the proxy multiplexes both protocols onto the
server's own port, and the conventional 19132 does not respond.

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

### Silent accept-then-close

Also when stopped, the proxy may instead accept the TCP connection and then send
nothing at all, closing the socket after roughly 30 s. This looks like a hang.
The bot's connect watchdog (`connectTimeoutMs`) handles it: if no spawn arrives
within 60 s it forces the connection down and reconnects.

### The hostname stopped working after a restart

Aternos regenerates the `*.aternos.host` name. Use `4of5.aternos.me:44640`,
which has been stable across restarts.

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

All of these are reachable from the TUI hotkeys or an `exec` command. None of
them run unless asked.

| mode | behaviour |
|---|---|
| `afk` *(default)* | stand still, stay alive, log everything |
| `hold` | stay put but defend if attacked |
| `goto x y z` | pathfind to a coordinate |
| `come` | return to the recorded home point |
| `wander [radius]` | pick reachable random points near home and walk |
| `gather [radius]` | find trees, walk to a safe spot beside each, chop the whole trunk |
| `follow [player]` | follow another player |
| `attack` | fight a specific mob |

The **anti-stuck watchdog** is what makes these usable: while a goal is active
the bot measures real movement, and if it stalls it jumps, digs whatever is in
the way, re-plans, and after repeated failures gives up and goes AFK rather than
spinning forever.

Two details matter more than they look:

- **A freshly set goal is not judged as stuck.** The pathfinder spends its
  first moments *computing* a route, not walking. Counting that as a stall made
  the watchdog burn every recovery attempt before the bot took a step, so it
  gave up on goals it could trivially reach. There is now a grace period after
  each goal change.
- **When the pathfinder gives up, the goal resolves.** mineflayer-pathfinder
  emits `path_stop` when there is no route. Handling that event is the
  difference between "gave up with a logged reason" and "standing 10 blocks
  away forever, still claiming to be going there."

An active goal also gets a **minimal self-defence layer** — a bot that dies
mid-task never finishes, which is the "gets stuck halfway" failure this project
exists to prevent. It hits back when hurt, flees at low health (and at night,
flees a hostile that is merely *close*, since a zombie closes faster than a
poll notices), retreats home when swarmed, and resumes the interrupted goal once
safe. The passive default (`afk`/`hold`) is untouched unless the survival layer
is explicitly enabled.

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

On death the bot records where it fell, respawns, and **walks back to pick up
its dropped items** before resuming whatever it was doing. Drops despawn after
five minutes, so a recovery older than that is skipped with a logged reason
rather than a wasted trip.

### TUI dashboard

```bash
node src/tui.js
```

Attaches to the running daemon over a UNIX socket and shows: live state (health,
food, position, counters), the current goal, a true-colour top-down radar with
mob markers, a scrolling log tail, and a command line. Hotkeys switch modes,
`s` takes a 360° panorama, `?` shows help. The daemon keeps running when the TUI
closes — reattach any time.

### 360° panorama

`s` in the TUI (or the `screenshot` IPC command) raycasts through the loaded
chunks around the bot and writes a single wide PNG to `screenshots/`. No texture
files are needed — block colours come from a built-in palette plus lighting, so
memory use stays trivial.

---

## Layout

```
├── package.json              mineflayer, mineflayer-pathfinder, npm scripts
├── config/config.json        canonical target (4of5.aternos.me:44640)
├── src/bot.js                entry point (daemon): lock, signals, startup
├── src/core.js               BotCore: connect, probe, watchdog, reconnect, IPC, status
├── src/actor.js              behaviour engine: modes, goals, anti-stuck, survival
├── src/tasks.js              task queue for multi-step goals (gather → craft → …)
├── src/config.js             config loader + CLI overrides
├── src/logger.js             console + .log + .jsonl + status.json
├── src/ipc.js                UNIX-socket line-JSON protocol (daemon ↔ TUI)
├── src/tui.js                terminal dashboard
├── src/lockfile.js           single-instance daemon lock (run/bot.pid)
├── src/render.js             voxel-DDA panorama + radar renderer
├── src/colors.js             block → colour palette and lighting
├── src/png.js                zero-dependency PNG encoder
├── src/mock.js               offline generated world + fake bot (demo & tests)
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
