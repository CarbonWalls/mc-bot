#!/usr/bin/env python3
"""RakNet (Minecraft Bedrock) unconnected-ping probe.

Sends an Unconnected Ping (0x01) and looks for an Unconnected Pong (0x1c),
which carries the server MOTD. Read-only, one packet in/out.
"""
import os
import socket
import struct
import sys
import time

MAGIC = bytes([0x00, 0xFF, 0xFF, 0x00, 0xFE, 0xFE, 0xFE, 0xFE,
               0xFD, 0xFD, 0xFD, 0xFD, 0x12, 0x34, 0x56, 0x78])


def ping(host, port, timeout=6):
    """Return (rtt_ms, pong_text) or raise."""
    guid = os.urandom(8)
    t_ms = int(time.time() * 1000) & 0xFFFFFFFFFFFFFFFF
    payload = (b"\x01" + struct.pack(">Q", t_ms) + MAGIC + guid)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        t0 = time.time()
        s.sendto(payload, (host, port))
        data, _ = s.recvfrom(2048)
        rtt = (time.time() - t0) * 1000.0
    finally:
        s.close()
    if not data or data[0] != 0x1C:
        raise ValueError(f"unexpected packet id 0x{data[0]:02x} (wanted 0x1c)")
    # 0x1c | time(8) | magic(16) | guid(8) | strlen(2, big endian) | string
    off = 1 + 8 + 16 + 8
    slen = struct.unpack(">H", data[off:off + 2])[0]
    off += 2
    text = data[off:off + slen].decode("utf-8", "replace")
    return rtt, text


def main(argv):
    if len(argv) < 2:
        print("usage: bedrock_probe.py HOST [PORT...]", file=sys.stderr)
        return 2
    host = argv[1]
    ports = [int(p) for p in argv[2:]] or [19132, 19133, 19134]
    any_ok = False
    for port in ports:
        try:
            rtt, text = ping(host, port)
            any_ok = True
            print(f"{host}:{port:<6} -> PONG {rtt:.0f}ms  {text!r}")
        except Exception as e:
            print(f"{host}:{port:<6} -> {type(e).__name__}: {e}")
    return 0 if any_ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
