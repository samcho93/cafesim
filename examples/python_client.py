"""
Talk to the cafeSim virtual main board from Python (or any language) over raw TCP.
The bytes are identical to what the real board expects on COM1 @ 38400.

    npm run sim
    python examples/python_client.py
"""
import socket
import time

ENQ, EOT = 0x05, 0x04


def checksum(data: bytes) -> bytes:
    low = sum(data) & 0xFF
    return f"{low:02X}".encode()


def frame(station: str, cmd: str, addr: str, payload: bytes = b"", length: int | None = None) -> bytes:
    body = bytes([ENQ]) + station.encode() + cmd.encode() + addr.encode()
    if cmd == "BR":
        body += f"{length:03d}".encode()
    else:
        body += f"{len(payload):03d}".encode() + payload
    body += bytes([EOT])
    return body + checksum(body)


def exchange(sock: socket.socket, data: bytes, expect: int | None = None) -> bytes:
    sock.sendall(data)
    time.sleep(0.05)
    sock.settimeout(1.0)
    buf = b""
    while True:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            break
        buf += chunk
        if expect and len(buf) >= expect:
            break
    return buf


with socket.create_connection(("127.0.0.1", 7001)) as s:
    # read the 149 byte status block (M000..M148)
    resp = exchange(s, frame("01", "BR", "M000", length=149), expect=15 + 149)
    data = resp[12 : 12 + 149]
    print("coffee boiler  :", data[73], "C")
    print("hot water      :", data[74], "C")
    print("brew upper/mid/low contacts:", chr(data[58]), chr(data[59]), chr(data[60]))

    # move the brew mechanism up in manual mode (S020=1, S059=1) - watch it in the 3D view (내부 보기)
    print(exchange(s, frame("01", "BW", "S020", b"1"), expect=12))
    print(exchange(s, frame("01", "BW", "S059", b"1"), expect=12))
    time.sleep(2)
    resp = exchange(s, frame("01", "BR", "M000", length=149), expect=15 + 149)
    print("brew upper contact now:", chr(resp[12 + 58]))
    exchange(s, frame("01", "BW", "S061", b"1"), expect=12)  # back down
    exchange(s, frame("01", "BW", "S020", b"0"), expect=12)
