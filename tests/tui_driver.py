"""Drive a disposable OpenCode V2 TUI through a PTY with a JSON scenario; never submits a model prompt.

argv[1]: JSON {"command": [...], "cwd": str, "width": int, "height": int, "steps": [...]}
Steps: {"wait": regex, "timeout": seconds, "name": str} | {"type": text} | {"key": "enter"|"escape"}
       | {"resize": columns} | {"sleep": seconds} | {"snapshot": name} | {"count": regex, "name": str}
Prints one JSON object: {"ok", "failed", "results", "snapshots", "screen"}.
"""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

scenario = json.loads(sys.argv[1])
width, height = scenario.get("width", 150), scenario.get("height", 40)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
child = subprocess.Popen(scenario["command"], cwd=scenario["cwd"], stdin=slave, stdout=slave, stderr=slave,
                         start_new_session=True)
os.close(slave)
raw = b""
KEYS = {"enter": b"\r", "escape": b"\x1b"}


def stop(_signal, _frame):
    raise SystemExit(1)


signal.signal(signal.SIGTERM, stop)


def pump(seconds):
    global raw
    end = time.monotonic() + seconds
    while time.monotonic() < end and child.poll() is None:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            raw += chunk
            # Answer terminal capability probes so the renderer does not stall.
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b[c" in chunk:
                os.write(master, b"\x1b[?62;22c")


def screen():
    """Reconstruct visible cells from absolute-positioned redraws."""
    text = re.sub(r"\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)", "", raw.decode("utf-8", "replace"))
    row, column = 1, 1
    cells = [[" "] * width for _ in range(height)]
    for token in re.finditer(r"\x1b\[([0-?]*)[ -/]*([@-~])|\x1b[^\[]|([^\x1b]+)", text):
        parameters, command, value = token.groups()
        if command is None and value is None:
            continue
        if command:
            if not re.fullmatch(r"[0-9;]*", parameters or ""):
                continue
            values = [int(part or "0") for part in (parameters or "").split(";")]
            if command in ("H", "f"):
                row = values[0] or 1
                column = (values[1] or 1) if len(values) > 1 else 1
            elif command == "J" and parameters in ("2", "3"):
                cells = [[" "] * width for _ in range(height)]
            elif command == "K" and 1 <= row <= height:
                start = 0 if parameters in ("1", "2") else max(0, column - 1)
                for index in range(start, width if parameters != "1" else min(width, column)):
                    cells[row - 1][index] = " "
            elif command == "G":
                column = values[0] or 1
            elif command in ("A", "B", "C", "D"):
                amount = values[0] or 1
                row += amount if command == "B" else -amount if command == "A" else 0
                column += amount if command == "C" else -amount if command == "D" else 0
            continue
        for char in value:
            if char == "\r":
                column = 1
            elif char == "\n":
                row += 1
            elif char.isprintable():
                if 1 <= row <= height and 1 <= column <= width:
                    cells[row - 1][column - 1] = char
                column += 1
    return "\n".join("".join(line).rstrip() for line in cells)


results, snapshots, failed = [], {}, None
try:
    pump(1.0)
    for step in scenario["steps"]:
        if "wait" in step:
            pattern = re.compile(step["wait"])
            end = time.monotonic() + step.get("timeout", 30)
            found = False
            while time.monotonic() < end and child.poll() is None:
                pump(0.3)
                if pattern.search(screen()):
                    found = True
                    break
            results.append({"name": step.get("name", step["wait"]), "ok": found})
            if not found:
                failed = step.get("name", step["wait"])
                break
        elif "count" in step:
            results.append({"name": step.get("name", step["count"]), "count": len(re.findall(step["count"], screen()))})
        elif "type" in step:
            for char in step["type"]:
                os.write(master, char.encode())
                pump(0.03)
        elif "key" in step:
            os.write(master, KEYS[step["key"]])
            pump(0.2)
        elif "resize" in step:
            width = step["resize"]
            raw = b""
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
            os.killpg(child.pid, signal.SIGWINCH)
            pump(1.0)
        elif "sleep" in step:
            pump(step["sleep"])
        elif "snapshot" in step:
            snapshots[step["snapshot"]] = screen()
    print(json.dumps({"ok": failed is None and child.poll() is None, "failed": failed, "exit": child.poll(),
                      "results": results, "snapshots": snapshots, "screen": screen()}))
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
    os.close(master)
