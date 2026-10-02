#!/bin/sh
# ./mc — thin wrapper so the CLI runs straight from the project folder:
#   ./mc pvp Steve hard        (also installable globally with `npm link`)
# It execs node directly: no bash, no quoting of the whole command, one word per
# argument. bin/mc.js talks to the daemon over its UNIX socket.
exec node "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/bin/mc.js" "$@"
