"""Run unchanged regression assertions against a task-owned ephemeral server."""
import os
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding='utf-8')


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/'
output = []
try:
    env = dict(os.environ, STUDIO_TEST_BASE=base, PYTHONUTF8='1')
    for name, args in [('studio_test.py', []), ('link_test.py', [base])]:
        result = subprocess.run([sys.executable, str(ROOT / 'tests' / name), *args], env=env,
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=90)
        output.append(name + '\n' + result.stdout + result.stderr)
        print(output[-1])
        if result.returncode:
            raise SystemExit(result.returncode)
finally:
    server.shutdown()
    server.server_close()
    evidence = ROOT.parent / 'evidence'
    evidence.mkdir(exist_ok=True)
    (evidence / 'existing-regressions.txt').write_text('\n'.join(output), encoding='utf-8')
