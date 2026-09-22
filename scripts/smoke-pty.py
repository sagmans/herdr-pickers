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
import time

ROWS, COLS = 40, 120
GRACE_SECONDS = 1.5
REAP_SECONDS = 1.0
POLL_SECONDS = 0.05

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


def wait_for_exit(pid, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            reaped, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True
        if reaped:
            return True
        time.sleep(POLL_SECONDS)
    return False


def terminate(pid, master):
    # Closing the master hangs up the PTY before signalling, so a client
    # blocked on terminal I/O can finish its own exit. Every wait is bounded
    # because a client wedged in kernel exit cannot be reaped at all, and the
    # bridge must not outlive the smoke either way.
    try:
        os.close(master)
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    if wait_for_exit(pid, GRACE_SECONDS):
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    wait_for_exit(pid, REAP_SECONDS)


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
            # EOF means the harness that owns this PTY is gone, so nothing is
            # left to drive and nobody is left to report a leaked bridge to.
            if not data:
                break
            os.write(master, data)
finally:
    terminate(pid, master)
