"""
Acme's webhook receiver: the production endpoint Hookline delivers events to.

It verifies the Hookline-Signature header with the secret in config.env and
logs every delivery to ../data/webhook-handler.log. That log is deliberately
"realistic": it contains raw headers and payloads, including customer emails.
acme_diagnostics decides which small slice of it may leave Acme.

Run locally:  python3 receiver.py   (listens on http://localhost:8787)
On Fly.io it runs alongside acme_diagnostics; see ../start.py.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.env"
LOG_PATH = Path(os.environ.get("ACME_LOG_PATH", HERE.parent / "data" / "webhook-handler.log"))
PORT = int(os.environ.get("PORT", 8787))
TOLERANCE_SECONDS = 300

FRAMEWORK = "acme-billing/2.3 (python http.server)"
SDK = "hookline-python 2.1.0"


def load_secret() -> str:
    # On Fly the secret comes from `fly secrets`; locally from config.env.
    if os.environ.get("WEBHOOK_SECRET"):
        return os.environ["WEBHOOK_SECRET"]
    for line in CONFIG.read_text().splitlines():
        if line.startswith("WEBHOOK_SECRET="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("WEBHOOK_SECRET missing from config.env")


def fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()[:8]


def verify(header: str, body: bytes, secret: str) -> str | None:
    """Return None if valid, otherwise an error string."""
    try:
        fields = dict(item.split("=", 1) for item in header.split(","))
        timestamp, signature = fields["t"], fields["v1"]
    except (KeyError, ValueError):
        return "MalformedSignatureHeader"
    if abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
        return "TimestampOutsideTolerance"
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return "SignatureVerificationError: signature does not match expected value"
    return None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        # Health check for the hosting platform.
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            secret = load_secret()
            error = verify(self.headers.get("Hookline-Signature", ""), body, secret)
        except (RuntimeError, FileNotFoundError):
            secret, error = "", "MissingWebhookSecret"
        status = 401 if error else 200

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {"raw": body.decode(errors="replace")}

        entry = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "endpoint": self.path,
            "event_id": payload.get("id"),
            "event_type": payload.get("type"),
            "outcome": "rejected" if error else "accepted",
            "http_status": status,
            "error": error,
            "framework": FRAMEWORK,
            "sdk": SDK,
            "configured_secret_fp": fingerprint(secret),
            # Sensitive: never meant to leave Acme.
            "headers": dict(self.headers),
            "payload": payload,
        }
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a") as f:
            f.write(json.dumps(entry) + "\n")

        self.send_response(status)
        self.end_headers()
        self.wfile.write(b'{"ok":false}' if error else b'{"ok":true}')
        print(f"{entry['ts']}  {status}  {entry['event_type']}  {error or ''}")

    def log_message(self, *_args) -> None:  # silence default access log
        pass


if __name__ == "__main__":
    try:
        status = f"secret fp {fingerprint(load_secret())}"
    except (RuntimeError, FileNotFoundError):
        status = "no WEBHOOK_SECRET set yet: every delivery will be rejected"
    print(f"Acme webhook receiver on port {PORT}  ({status})")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
