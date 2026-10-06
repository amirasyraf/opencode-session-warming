"""Exercise a disposable OpenCode TUI through a PTY; never submits a model prompt."""

import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def stop_driver(_signal, _frame):
    raise SystemExit(1)


signal.signal(signal.SIGTERM, stop_driver)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
command = ["opencode"] if len(sys.argv) < 4 else ["opencode", "attach", sys.argv[2], "--session", sys.argv[3], "--dir", sys.argv[1]]
child = subprocess.Popen(command, cwd=sys.argv[1], stdin=slave, stdout=slave,
                         stderr=slave, start_new_session=True)
os.close(slave)
output = b""
ready = False
responsive = False
initialized = False
indicator_completed = False
indicator_sending = False
indicator_failed = False
expect_indicator = os.environ.get("WARMING_TUI_EXPECT_INDICATOR") == "1"
sent = False
dismissed_update = False
deadline = time.monotonic() + 45

try:
    while time.monotonic() < deadline and child.poll() is None:
        if responsive:
            for path in [Path(os.environ["XDG_DATA_HOME"]) / "opencode/log/opencode.log",
                         Path(os.environ["XDG_STATE_HOME"]) / "opencode/session-warming-fallback.log"]:
                try:
                    if "[session-warming] ready" in path.read_text():
                        initialized = True
                except OSError:
                    pass
            if initialized and (not expect_indicator or (indicator_completed and indicator_sending and indicator_failed)):
                break
        readable, _, _ = select.select([master], [], [], 0.1)
        if not readable:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        output = (output + chunk)[-262144:]
        # Minimal terminal replies, so capability queries don't stall the renderer.
        for query, reply in [
            (b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[>c", b"\x1b[>0;100;0c"),
            (b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[?u", b"\x1b[?0u"),
            (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
            (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
        ]:
            if query in chunk:
                os.write(master, reply)
        text = output.decode("utf-8", "replace")
        text = re.sub(r"\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)", "", text)
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        if "Update Available" in text and not dismissed_update:
            os.write(master, b"\x1b")
            dismissed_update = True
        if "Warming" in text and "✓" in text:
            indicator_completed = True
        if "▸" in text or "▹" in text:
            indicator_sending = True
        if "×" in text:
            indicator_failed = True
        if "Ask anything" in text or (len(sys.argv) >= 4 and "Build" in text and "Warming" in text and b"\x1b[?25h" in output):
            ready = True
        if ready and not sent:
            os.write(master, b"\x1b[200~warming-smoke\x1b[201~")
            sent = True
        if sent and "warming-smoke" in text:
            responsive = True
    print(json.dumps({"screenReady": ready, "inputResponsive": responsive,
                      "initialized": initialized,
                      "indicatorCompleted": indicator_completed,
                      "indicatorSending": indicator_sending,
                      "indicatorFailed": indicator_failed,
                      "output": output.decode("utf-8", "replace")[-16000:]}))
    sys.exit(0 if responsive else 1)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
    os.close(master)
