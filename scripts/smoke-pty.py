#!/usr/bin/env python3
# PTY bridge: runs a command in a real pseudo-terminal while forwarding
# plain stdin/stdout. herdr's TUI needs a true tty (macOS `script` refuses
# socket-backed stdin), and the smoke harness needs to inject keystrokes.
import fcntl
import os
import pty
import select
import signal
import struct
import termios
import sys

ROWS, COLS = 40, 120

cmd = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

running = True


def stop(*_):
    global running
    running = False


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

try:
    while running:
        readable, _, _ = select.select([master, sys.stdin], [], [], 0.5)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin in readable:
            data = sys.stdin.buffer.read1(65536)
            if data:
                os.write(master, data)
finally:
    try:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
    except Exception:
        pass
