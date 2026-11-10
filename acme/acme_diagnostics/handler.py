"""
acme_diagnostics: Acme's side of the investigation.

Runs inside Acme's environment, next to the webhook handler log, and connects
to Blocks outbound only. It is deliberately NOT an LLM: a model should not be
deciding what leaves your network. The release policy below is plain code
that Acme owns and can audit.

Input (JSON text):  {"endpoint": "/webhooks/hookline", "since": "<ISO 8601>"}
Output (JSON):      failing deliveries, reduced to an allowlist of fields.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from blocks_network import StartTaskMessage, TaskContext

LOG_PATH = Path(os.environ.get("ACME_LOG_PATH", Path(__file__).resolve().parent.parent / "data" / "webhook-handler.log"))

# --- Release policy (Acme owns this) -----------------------------------------
MAX_WINDOW = timedelta(hours=24)
MAX_EVENTS = 20
RELEASED_FIELDS = ["ts", "event_id", "event_type", "http_status", "error"]
# Also released: the framework and SDK version, and a SHA-256 fingerprint of the configured secret.
# Never released: headers, payload, customer data, the secret itself.
# -----------------------------------------------------------------------------


def handler(task: StartTaskMessage, ctx: Optional[TaskContext] = None) -> dict:
    # 1. Who is asking? Every Blocks request carries verified caller identity.
    print(
        f"[acme_diagnostics] request from owner={task.owner_id} org={task.org_id} "
        f"claims={json.dumps(task.caller_claims or {})}",
        flush=True,
    )

    text = next((str(p.text) for p in task.request_parts if p.text is not None), "{}")
    query = json.loads(text)
    endpoint = query.get("endpoint", "/webhooks/hookline")

    now = datetime.now(timezone.utc)
    since = datetime.fromisoformat(query["since"]) if query.get("since") else now - MAX_WINDOW
    since = max(since, now - MAX_WINDOW)  # policy: never more than 24h back

    if ctx is not None:
        ctx.report_status(f"Acme: checking webhook handler logs since {since.isoformat(timespec='minutes')}")

    entries = []
    if LOG_PATH.exists():
        for line in LOG_PATH.read_text().splitlines():
            entry = json.loads(line)
            if entry["endpoint"] == endpoint and datetime.fromisoformat(entry["ts"]) >= since:
                entries.append(entry)

    failures = [e for e in entries if e["outcome"] == "rejected"]
    latest = entries[-1] if entries else {}

    result = {
        "source": "acme_diagnostics",
        "endpoint": endpoint,
        "window_start": since.isoformat(timespec="seconds"),
        "deliveries_seen": len(entries),
        "failures": len(failures),
        "first_failure": failures[0]["ts"] if failures else None,
        "error_classes": sorted({e["error"].split(":")[0] for e in failures}),
        "framework": latest.get("framework"),
        "sdk": latest.get("sdk"),
        # A SHA-256 fingerprint, not the secret.
        "configured_secret_fp": latest.get("configured_secret_fp"),
        "failing_events": [{k: e[k] for k in RELEASED_FIELDS} for e in failures[-MAX_EVENTS:]],
        "withheld": ["headers", "payloads", "customer data", "secret values"],
    }

    print(f"[acme_diagnostics] released {len(result['failing_events'])} events, withheld headers and payloads", flush=True)
    return {"artifacts": [{"data": json.dumps(result, indent=2), "mimeType": "application/json"}]}
