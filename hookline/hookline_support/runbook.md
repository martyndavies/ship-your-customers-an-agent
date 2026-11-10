# Hookline support runbook (internal)

Not published. Known webhook issues and the fixes support has learned.

## HL-101: Signing secret rotated, customer still verifying with the old one

Deliveries start returning 401 within minutes of a signing secret rotation. The customer's configured secret fingerprint matches the previous secret, not the active one.

**Fix:** Your webhook signing secret was rotated, but your endpoint is still verifying with the old secret. Copy the new secret from the Hookline dashboard into your WEBHOOK_SECRET setting and restart the service. Hookline retries failed deliveries for 72 hours, so the failed events will arrive once the new secret is live.

Internal note: offer to extend the dual-secret grace period to 24h for this customer.

## HL-102: Body parsed before signature verification

Signature errors with a matching secret. Usually a framework middleware parses JSON before the handler sees the raw bytes, so the signed payload no longer matches.

**Fix:** Verify the signature against the raw request body, before any JSON parsing. In Express use `express.raw({ type: 'application/json' })` on the webhook route; in FastAPI read `await request.body()`.

## HL-103: Clock skew

TimestampOutsideTolerance errors. The customer's server clock is more than five minutes off.

**Fix:** Enable NTP time sync on the server receiving webhooks. Hookline rejects signatures older than five minutes to prevent replays.
