#!/usr/bin/env bash
# Put the demo back to a clean, working state: Hookline and Acme share the same
# signing secret, and both logs are empty.
#
# Acme on Fly.io:   ACME_FLY_APP=acme-webhooks-demo ./scripts/reset-demo.sh
#   Sets WEBHOOK_SECRET with `fly secrets set`, which restarts the Machine and
#   clears Acme's handler log (it lives on the Machine's local disk).
# Acme locally:     ./scripts/reset-demo.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SECRET="whsec_$(openssl rand -hex 18)"
FP="$(printf '%s' "$SECRET" | shasum -a 256 | cut -c1-8)"

mkdir -p "$ROOT/hookline/data" "$ROOT/acme/data"
printf '{\n  "active": "%s",\n  "previous": null,\n  "rotated_at": null\n}\n' "$SECRET" > "$ROOT/hookline/data/secrets.json"
: > "$ROOT/hookline/data/deliveries.jsonl"

if [[ -n "${ACME_FLY_APP:-}" ]]; then
  if [[ -n "${FLY_STAGE:-}" ]]; then
    fly secrets set "WEBHOOK_SECRET=$SECRET" -a "$ACME_FLY_APP" --stage
  else
    fly secrets set "WEBHOOK_SECRET=$SECRET" -a "$ACME_FLY_APP"
    echo "Acme on Fly ($ACME_FLY_APP) is restarting with the new secret. Give it about 20 seconds."
  fi
else
  printf 'WEBHOOK_SECRET=%s\n' "$SECRET" > "$ROOT/acme/webhook-receiver/config.env"
  : > "$ROOT/acme/data/webhook-handler.log"
fi

echo "Demo reset. Shared secret fingerprint: $FP"
