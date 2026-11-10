#!/usr/bin/env bash
# Deploy Acme (webhook endpoint + acme_diagnostics agent) to Fly.io.
#
# Reads:   the app name from acme/fly.toml
#          Acme's Blocks key from acme/acme_diagnostics/.env
# Does:    creates the Fly app if needed, sets the secrets, deploys,
#          and points Hookline's sender at the new URL.
#
# Usage:   ./scripts/deploy-acme.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

APP="$(sed -n 's/^app *= *"\([^"]*\)".*/\1/p' "$ROOT/acme/fly.toml")"
KEY="$(sed -n 's/^BLOCKS_API_KEY=//p' "$ROOT/acme/acme_diagnostics/.env" 2>/dev/null || true)"
[[ -n "$APP" ]] || { echo "No app name found in acme/fly.toml"; exit 1; }
[[ -n "$KEY" ]] || { echo "No BLOCKS_API_KEY in acme/acme_diagnostics/.env (run: blocks login --write-env as Acme)"; exit 1; }

echo "1/4  Fly app: $APP"
# Capture the list first: piping straight into `grep -q` can make fly exit early
# and, with pipefail, look like "not found".
APPS="$(fly apps list 2>/dev/null || true)"
if grep -qw -- "$APP" <<<"$APPS"; then
  echo "     already exists in your account, reusing it"
elif ! fly apps create "$APP"; then
  echo
  echo "Could not create '$APP'. If the name belongs to someone else, change 'app' in acme/fly.toml and run this again."
  exit 1
fi

echo "2/4  Setting Acme's Blocks key on Fly"
fly secrets set "BLOCKS_API_KEY=$KEY" -a "$APP" --stage

echo "3/4  Setting a fresh webhook secret (shared with Hookline)"
ACME_FLY_APP="$APP" FLY_STAGE=1 "$ROOT/scripts/reset-demo.sh"

echo "4/4  Deploying"
(cd "$ROOT/acme" && fly deploy)

URL="https://$APP.fly.dev/webhooks/hookline"
ENV_FILE="$ROOT/hookline/hookline_support/.env"
touch "$ENV_FILE"
if grep -q '^ACME_WEBHOOK_URL=' "$ENV_FILE"; then
  sed -i.bak "s#^ACME_WEBHOOK_URL=.*#ACME_WEBHOOK_URL=$URL#" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
else
  echo "ACME_WEBHOOK_URL=$URL" >> "$ENV_FILE"
fi

echo
echo "Done. Acme is live at https://$APP.fly.dev"
echo "Hookline will now send webhooks to $URL"
echo "Watch Acme with:  fly logs -a $APP"
