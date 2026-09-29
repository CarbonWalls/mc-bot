#!/usr/bin/env python3
"""Poll the server status until it responds, logging each attempt."""
import time, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe import ping

host = sys.argv[1] if len(sys.argv) > 1 else 'weasel.aternos.host'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 44640
interval = float(sys.argv[3]) if len(sys.argv) > 3 else 45
attempts = int(sys.argv[4]) if len(sys.argv) > 4 else 60
log = sys.argv[5] if len(sys.argv) > 5 else 'logs/status_poll.log'

for i in range(attempts):
    ts = time.strftime('%Y-%m-%d %H:%M:%S')
    try:
        lat, st = ping(host, port, timeout=12)
        rec = {'ts': ts, 'ok': True, 'latency_ms': round(lat,1),
               'version': st.get('version'), 'players': st.get('players'),
               'motd': st.get('description')}
        print(json.dumps(rec), flush=True)
        if i:  # first hit after failures => came online
            pass
        with open(log, 'a') as f: f.write(json.dumps(rec) + "\n")
    except Exception as e:
        rec = {'ts': ts, 'ok': False, 'err': f'{type(e).__name__}: {e}'}
        print(json.dumps(rec), flush=True)
        with open(log, 'a') as f: f.write(json.dumps(rec) + "\n")
    time.sleep(interval)
