import os
import pty
import select
import signal
import sys

READ_BYTES = 65536
POLL_SECONDS = 0.1
ERROR_EXIT = 1

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])


def stop(*_):
    os.kill(pid, signal.SIGTERM)


signal.signal(signal.SIGTERM, stop)
try:
    while True:
        readable, _, _ = select.select([master], [], [], POLL_SECONDS)
        if readable:
            try:
                data = os.read(master, READ_BYTES)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
finally:
    os.close(master)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    sys.exit(code if code >= 0 else ERROR_EXIT)
