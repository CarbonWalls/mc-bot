#!/usr/bin/env python3
"""Poll several (host,port) endpoints and log MOTD/online state over time."""
import time, json, sys, os, socket
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe import ping

targets = []
for arg in sys.argv[1:]:
    h, p = arg.rsplit(':', 1)
    targets.append((h, int(p)))
interval = 30
attempts = 12
out = 'logs/multi_poll.log'
seen = {}
for i in range(attempts):
    for h, p in targets:
        key = f'{h}:{p}'
        try:
            lat, st = ping(h, p, timeout=10)
            d = st.get('description')
            text = d.get('text', '') if isinstance(d, dict) else str(d)
            if not text and isinstance(d, dict) and d.get('extra'):
                text = ''.join(e.get('text', '') for e in d['extra'])
            rec = {'ts': time.strftime('%H:%M:%S'), 'target': key, 'ok': True,
                   'version': st.get('version'), 'players': st.get('players', {}).get('online'),
                   'motd': text[:120]}
        except Exception as e:
            rec = {'ts': time.strftime('%H:%M:%S'), 'target': key, 'ok': False, 'err': f'{type(e).__name__}'}
        sig = (rec.get('ok'), rec.get('version', {}).get('name') if rec.get('version') else None, rec.get('motd'))
        changed = seen.get(key) != sig
        seen[key] = sig
        rec['changed'] = changed
        print(json.dumps(rec), flush=True)
        with open(out, 'a') as f: f.write(json.dumps(rec) + '\n')
    time.sleep(interval)
