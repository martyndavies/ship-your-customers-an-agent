# Setup

Two Blocks accounts, two folders:

- **Acme** account: everything in `acme/`. Acme runs on Fly.io.
- **Hookline** account: everything in `hookline/`. Hookline runs on your laptop.

Run every command from the repo root unless a step says `cd`.

---

## Part 1: one-time setup (about 30 minutes)

### 1. Install

```bash
cd hookline/hookline_support && npm install && cd ../..
cd acme/acme_diagnostics && uv sync && cd ../..
```

### 2. Acme: register the agent

```bash
cd acme/acme_diagnostics
blocks login --write-env        # sign in with the ACME account
blocks register
cd ../..
```

### 3. Acme: deploy to Fly

```bash
./scripts/deploy-acme.sh
```

It reads the app name from `acme/fly.toml` and Acme's key from `acme/acme_diagnostics/.env`, then creates the app, sets the secrets, deploys, and points Hookline at the new URL. When it's done, check Acme's logs:

```bash
fly logs -a acme-infra-demo
```

You should see `Acme webhook receiver on port 8787` and the agent connecting to Blocks.

### 4. Hookline: register the agent

```bash
blocks logout
cd hookline/hookline_support
blocks login --write-env        # sign in with the HOOKLINE account
blocks register
cd ../..
```

### 5. Give each other access

Acme lets Hookline call its agent. Use the email address of the **Hookline account** (when `hookline_support` calls another agent, it authenticates as its owner):

```bash
cd acme/acme_diagnostics
blocks invite send acme_diagnostics --email <hookline-account-email>
cd ../..
```

Note: inviting the agent address `hookline_support@blocks.ai` returned "agent not found" on accept, so use the account email.

Hookline lets Acme call its agent. Get Acme's org slug from the Blocks dashboard, or by running `blocks whoami --json` while signed in as Acme.

```bash
cd hookline/hookline_support
blocks invite send hookline_support --org <acme-org-slug>
cd ../..
```

Each invite sends an email. Open each one in a browser signed in to the *receiving* account and click **Accept**.

### 6. Check it works

```bash
cd hookline/hookline_support
blocks run                      # leave this running (terminal 1)
```

In a second terminal:

```bash
cd acme/acme_diagnostics
uv run ask_hookline.py "Why are my Hookline webhooks failing?"
```

With no failures yet, you should get an answer saying nothing matched. That means both agents can reach each other across the two accounts. Setup is done.

---

## Part 2: break it and ask why

### Break the integration

```bash
ACME_FLY_APP=acme-infra-demo ./scripts/reset-demo.sh    # wait about 20 seconds for Fly to restart
cd hookline/hookline_support
npm run send 3     # 200s: working
npm run rotate     # Hookline rotates the signing secret
npm run send 3     # 401s: Acme is still on the old one
```

### Ask Hookline

Keep three terminals open:

1. `blocks run` in `hookline/hookline_support` (Hookline's agent)
2. `fly logs -a acme-infra-demo` (Acme)
3. The question:

```bash
cd acme/acme_diagnostics
uv run ask_hookline.py "Why are my Hookline webhooks failing?"
```

Or ask from an MCP client (such as Claude Code) with the Blocks MCP server signed in as Acme: "Use the hookline_support agent on Blocks to find out why my Hookline webhooks are failing, and show me its full reply."

### Revoke access

```bash
cd acme/acme_diagnostics
blocks invite revoke acme_diagnostics --email <hookline-account-email> --reason "Ticket closed"
uv run ask_hookline.py "Why are my Hookline webhooks failing?"
```

The answer now says Acme's evidence is unavailable: the network refused Hookline's call. To get access back, run the step 5 Acme invite again and accept it.

---

## If something goes wrong

- **Agent name taken** on `blocks register`: rename `agentName` in that agent's `agent-card.json`, then set `ACME_DIAGNOSTICS_AGENT` (in Hookline's `.env`) or `HOOKLINE_SUPPORT_AGENT` (in Acme's `.env`) to the new name.
- **Cross-account call fails:** check both invites were accepted with `blocks invite grants <agent>`. To rule out access problems, register both agents in one account and skip step 5.
- **`blocks` commands act as the wrong account:** run `blocks logout`, then `blocks login` again from the right folder.
- **Node errors:** the Blocks SDK needs Node 22.23.4+ or 24.22.1+ (`node -v`).
- **Use npm, not pnpm, for Hookline.** `blocks run` can't launch the agent through pnpm's `.bin` wrappers.

Optional: to have a local Ollama model write the reply, set `LLM_BASE_URL=http://localhost:11434/v1` and `LLM_MODEL` in `hookline/hookline_support/.env`. Without it, the agent uses the runbook text.
