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
mode = os.environ.get("WARMING_TUI_LAYOUT_ONLY", "")
width, height = (110 if mode == "child" else 150), 32
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
command = ["opencode"] if len(sys.argv) < 4 else ["opencode", "attach", sys.argv[2], "--session", sys.argv[3], "--dir", sys.argv[1]]
child = subprocess.Popen(command, cwd=sys.argv[1], stdin=slave, stdout=slave,
                         stderr=slave, start_new_session=True)
os.close(slave)
output = b""
history = b""
ready = False
responsive = False
initialized = False
indicator_completed = False
indicator_sending = False
indicator_failed = False
usage_cache_read = False
usage_cache_write = False
indicator_fill_only = False
indicator_segmented = False
segmentation_changed = False
sidebar_placed = False
compact_placed = False
narrow_placed = False
restored_sidebar = False
child_placed = False
monochrome = False
no_duplicates = True
snapshots = {}
stage = "wide"
expect_indicator = os.environ.get("WARMING_TUI_EXPECT_INDICATOR") == "1"
sent = False
dismissed_update = False
deadline = time.monotonic() + 45


def screen(raw):
    """Reconstruct all cells and RGB backgrounds from absolute terminal redraws."""
    text = re.sub(r"\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)", "", raw)
    row, column, background = 1, 1, None
    cells = [[" "] * width for _ in range(height)]
    backgrounds = [[None] * width for _ in range(height)]
    for token in re.finditer(r"\x1b\[([0-?]*)[ -/]*([@-~])|([^\x1b]+)", text):
        parameters, command, value = token.groups()
        if command and not re.fullmatch(r"[0-9;]*", parameters):
            continue
        values = [int(part or "0") for part in parameters.split(";")] if command else []
        if command in ("H", "f"):
            row = values[0] or 1
            column = (values[1] or 1) if len(values) > 1 else 1
        elif command == "J" and parameters in ("2", "3"):
            cells = [[" "] * width for _ in range(height)]
            backgrounds = [[None] * width for _ in range(height)]
        elif command == "K" and 1 <= row <= height:
            start = 0 if parameters in ("1", "2") else max(0, column - 1)
            end = min(width, column) if parameters == "1" else width
            for index in range(start, end):
                cells[row - 1][index] = " "
                backgrounds[row - 1][index] = background
        elif command == "G":
            column = values[0] or 1
        elif command in ("A", "B", "C", "D"):
            amount = values[0] or 1
            row += amount if command == "B" else -amount if command == "A" else 0
            column += amount if command == "C" else -amount if command == "D" else 0
        elif command == "m":
            index = 0
            while index < len(values):
                code = values[index]
                if code in (0, 49):
                    background = None
                elif code in (38, 48) and index + 1 < len(values):
                    kind = values[index + 1]
                    size = 5 if kind == 2 else 3
                    if code == 48:
                        background = tuple(values[index + 2:index + size])
                    index += size - 1
                elif 40 <= code <= 47 or 100 <= code <= 107:
                    background = (code,)
                index += 1
        elif value:
            for char in value:
                if char == "\r":
                    column = 1
                elif char == "\n":
                    row += 1
                elif char.isprintable():
                    if 1 <= row <= height and 1 <= column <= width:
                        cells[row - 1][column - 1] = char
                        backgrounds[row - 1][column - 1] = background
                    column += 1
    return ["".join(line) for line in cells], backgrounds


def resize(columns):
    global width, output
    width = columns
    output = b""
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
    os.killpg(child.pid, signal.SIGWINCH)


heading = re.compile(r"\b(?:Parent warming|Warming|Warm)(?= +(?:Waiting|Sending|Stopped|Expired|Unavailable|Inactive|Model active|Preparing|Window ending))")

try:
    while time.monotonic() < deadline and child.poll() is None:
        if responsive or mode:
            for path in [Path(os.environ["XDG_DATA_HOME"]) / "opencode/log/opencode.log",
                         Path(os.environ["XDG_STATE_HOME"]) / "opencode/session-warming-fallback.log"]:
                try:
                    if "[session-warming] ready" in path.read_text():
                        initialized = True
                except OSError:
                    pass
            if initialized and ((not expect_indicator and responsive) or
                                (mode == "child" and child_placed) or
                                (mode == "mono" and monochrome) or
                                (responsive and indicator_completed and indicator_sending and indicator_failed and segmentation_changed and restored_sidebar)):
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
        output = (output + chunk)[-524288:]
        history = (history + chunk)[-524288:]
        # Minimal terminal replies, so capability queries don't stall the renderer.
        for query, reply in [
            (b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[>c", b"\x1b[>0;100;0c"),
            (b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[?u", b"\x1b[?0u"),
            (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
            (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
        ]:
            if query in chunk:
                os.write(master, reply)
        lines, backgrounds = screen(output.decode("utf-8", "replace"))
        text = "\n".join(lines)
        usage_cache_read = usage_cache_read or "Cache Read" in text
        usage_cache_write = usage_cache_write or "Cache Write" in text
        if "Update Available" in text and not dismissed_update:
            os.write(master, b"\x1b")
            dismissed_update = True
        matches = [(row, match.start()) for row, line in enumerate(lines) for match in heading.finditer(line)]
        if len(matches) > 1:
            no_duplicates = False
        if matches:
            row, column = matches[0]
            if mode == "child":
                child_placed = "Parent warming" in lines[row] and "Stopped" in lines[row] and "HTTP 401" in lines[row] and not lines[-1].strip()
                if child_placed:
                    snapshots["child"] = lines
            elif width == 150 and column >= width - 42:
                lsp = next((index for index, line in enumerate(lines[:row]) if "LSP" in line[width - 42:]), None)
                sidebar_placed = lsp is not None and row > lsp and "Requests Sent" in text
                bar_row = row + 2
                pixels = backgrounds[bar_row][column:column + 37]
                track = lines[bar_row][column:column + 37]
                if len(pixels) == 37 and all(pixel is not None for pixel in pixels) and len(set(pixels)) >= 3 and not track.strip():
                    indicator_fill_only = True
                    runs = 1 + sum(a != b for a, b in zip(pixels, pixels[1:]))
                    # 15 interval bands initially, plus at most one fractional frontier colour.
                    if not mode and not re.search(r"Failed +1", text) and 15 <= runs <= 16:
                        indicator_segmented = True
                    # The fixture doubles its interval after a failure: 8 bands, same 37-column track.
                    if not mode and re.search(r"Failed +1", text) and 8 <= runs <= 9:
                        segmentation_changed = True
                    if mode == "mono":
                        monochrome = all(len(pixel) == 3 and max(pixel) - min(pixel) <= 1 for pixel in pixels)
                if re.search(r"Requests Sent +3", text) and "Requests attempted" not in text:
                    indicator_completed = True
                    snapshots["sidebar"] = lines
                if "Sending" in lines[row] and re.search(r"Requests Sent +3", text):
                    indicator_sending = True
                if re.search(r"Failed +1", text) and re.search(r"Requests Sent +3", text):
                    indicator_failed = True
                if stage == "restore" and sidebar_placed:
                    restored_sidebar = True
                    snapshots["restored"] = lines
            elif width == 110 and "Build" in lines[row] and "1 failed" in lines[row]:
                compact_placed = True
                snapshots["compact"] = lines
            elif width == 80 and "Build" in lines[row] and "1 failed" in lines[row]:
                narrow_placed = True
                snapshots["narrow"] = lines
        if "Ask anything" in text or (len(sys.argv) >= 4 and "Build" in text and matches):
            ready = True
        if ready and not sent and not mode:
            os.write(master, b"\x1b[200~warming-smoke\x1b[201~")
            sent = True
        if sent and "warming-smoke" in text:
            responsive = True
        if not mode and indicator_failed and segmentation_changed and responsive and stage == "wide":
            stage = "compact"
            resize(110)
        elif stage == "compact" and compact_placed:
            stage = "narrow"
            resize(80)
        elif stage == "narrow" and narrow_placed:
            stage = "restore"
            resize(150)
    print(json.dumps({"screenReady": ready, "inputResponsive": responsive,
                      "initialized": initialized,
                      "indicatorCompleted": indicator_completed,
                      "indicatorSending": indicator_sending,
                      "indicatorFailed": indicator_failed,
                      "usageCacheRead": usage_cache_read, "usageCacheWrite": usage_cache_write,
                      "indicatorFillOnly": indicator_fill_only,
                      "indicatorSegmented": indicator_segmented, "segmentationChanged": segmentation_changed,
                      "sidebarPlaced": sidebar_placed, "compactPlaced": compact_placed,
                      "narrowPlaced": narrow_placed, "restoredSidebar": restored_sidebar,
                      "childPlaced": child_placed, "monochrome": monochrome,
                      "noDuplicates": no_duplicates, "snapshots": snapshots,
                      "output": history.decode("utf-8", "replace")[-16000:]}))
    sys.exit(0 if responsive or child_placed or monochrome else 1)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
    os.close(master)
