#!/usr/bin/env python3
"""Read-only Minecraft TCP probe: server list ping (status) and handshake latency."""
import socket
import struct
import json
import sys
import time


def pack_varint(value):
    out = bytearray()
    value &= 0xFFFFFFFF  # minecraft varints are 32-bit
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


def pack_string(s):
    data = s.encode("utf-8")
    return pack_varint(len(data)) + data


def read_varint(sock):
    num_read = 0
    result = 0
    while True:
        data = sock.recv(1)
        if not data:
            raise IOError("connection closed while reading varint")
        b = data[0]
        result |= (b & 0x7F) << (7 * num_read)
        num_read += 1
        if num_read > 5:
            raise ValueError("varint too big")
        if not (b & 0x80):
            break
    return result


def read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise IOError("connection closed")
        buf += chunk
    return buf


def ping(host, port, timeout=15, protocol_hint=None):
    t0 = time.time()
    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(timeout)
    latency_ms = (time.time() - t0) * 1000.0
    proto = -1 if protocol_hint is None else protocol_hint
    payload = pack_varint(proto) + pack_string(host) + struct.pack(">H", port) + b"\x01"
    packet = pack_varint(0x00) + payload  # packet id 0 = handshake
    sock.sendall(pack_varint(len(packet)) + packet)
    # status request (packet id 0x00 in status state)
    req = pack_varint(0x00)
    sock.sendall(pack_varint(len(req)) + req)
    length = read_varint(sock)
    body = read_exact(sock, length)
    # body = varint packetid + string json
    # strip packet id
    i = 0
    pid = 0
    shift = 0
    while True:
        b = body[i]
        i += 1
        pid |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    slen = 0
    shift = 0
    while True:
        b = body[i]
        i += 1
        slen |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    js = body[i:i + slen].decode("utf-8", "replace")
    sock.close()
    return latency_ms, json.loads(js)


def ping_latency_only(host, port, timeout=15):
    """Handshake + status request, returns just RTT and status json."""
    return ping(host, port, timeout)


if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else "weasel.aternos.host"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 44640
    try:
        lat, status = ping(host, port)
        out = {"ok": True, "latency_ms": round(lat, 2), "status": status}
        print(json.dumps(out, indent=2, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
