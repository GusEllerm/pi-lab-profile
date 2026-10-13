#!/usr/bin/env python3
"""Start Pi's interactive TUI in a pseudo-terminal and fail if it crashes on the way up.

check.sh's boot test runs Pi headless (`pi -p`), which never draws the TUI -- so a bug that only
fires while rendering (the column, the fleet list, the header) passes it. That is what happened on
13 Oct 2026: a timer unref'd outside its `if` threw on the first frame, every test was green, and
only a fresh-install test found it. This runs `pi --no-session` in a 150x44 pty for a few seconds
and checks that it is still alive, printed no JavaScript error, and drew the status column.

    python3 scripts/tui-smoke.py            # exit 0 when the TUI came up clean
"""
import fcntl, os, pty, re, select, signal, struct, sys, termios, time

ROWS, COLS, SETTLE = 44, 150, float(os.environ.get("TUI_SMOKE_SECONDS", "10"))
ERROR = re.compile(r"\b(TypeError|ReferenceError|RangeError|SyntaxError|Uncaught|Error: .{0,80}\bat\b)")

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("pi", ["pi", "--no-session"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
os.kill(pid, signal.SIGWINCH)

out = b""
end = time.time() + SETTLE
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    if os.waitpid(pid, os.WNOHANG)[0] == pid:
        pid = 0
        break

text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]", "", out.decode("utf-8", "replace"))
alive = pid != 0
error = ERROR.search(text)
column = re.search(r"\b(CONTEXT|ENDPOINT)\b", text)

if alive:
    for key in (b"\x03", b"\x03"):
        try:
            os.write(fd, key)
        except OSError:
            break
        time.sleep(0.3)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

if not alive or error:
    where = text[max(0, error.start() - 200): error.end() + 300] if error else text[-600:]
    print(f"tui: FAIL — {'pi exited' if not alive else 'error on screen'}\n" + re.sub(r"\s+\n", "\n", where).strip())
    sys.exit(1)
if not column:
    print("tui: FAIL — no status column drawn (is tuiMode fullscreen, and the terminal 72+ columns?)")
    sys.exit(1)
print(f"tui: clean (came up, drew the column, no errors in {SETTLE:g}s)")
