# usage: pty-run.py <seconds> <rows> <cols> <steps-json> -- cmd...   steps: [[delay_s, "keys"], ...]
import os, pty, sys, json, time, select, struct, fcntl, termios
secs, rows, cols, steps = float(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), json.loads(sys.argv[4])
cmd = sys.argv[sys.argv.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
buf = b""; start = time.time(); queue = list(steps); nxt = start + (queue[0][0] if queue else 1e9)
while time.time() - start < secs:
    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        buf += d
    if queue and time.time() >= nxt:
        os.write(fd, queue.pop(0)[1].encode())
        nxt = time.time() + (queue[0][0] if queue else 1e9)
try: os.kill(pid, 9)
except OSError: pass
sys.stdout.buffer.write(buf)
