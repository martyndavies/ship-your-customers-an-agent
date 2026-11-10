"""
Container entrypoint for Acme on Fly.io.

Runs two processes side by side and exits if either one dies (Fly restarts the
Machine):

  - webhook-receiver/receiver.py   Acme's existing webhook endpoint (public HTTPS)
  - blocks-run in acme_diagnostics  the diagnostics agent (outbound only, no port)

They share the handler log on local disk, which is why they run together.
"""

import os
import signal
import subprocess
import sys
import time

APP = os.environ.get("APP_DIR", "/app")

processes = {
    "receiver": subprocess.Popen([sys.executable, f"{APP}/webhook-receiver/receiver.py"]),
    "acme_diagnostics": subprocess.Popen(["blocks-run"], cwd=f"{APP}/acme_diagnostics"),
}


def shutdown(*_args) -> None:
    for proc in processes.values():
        if proc.poll() is None:
            proc.terminate()
    for proc in processes.values():
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

while True:
    for name, proc in processes.items():
        code = proc.poll()
        if code is not None:
            print(f"[start] {name} exited ({code}); shutting down", flush=True)
            for other in processes.values():
                if other.poll() is None:
                    other.terminate()
            sys.exit(1)
    time.sleep(1)
