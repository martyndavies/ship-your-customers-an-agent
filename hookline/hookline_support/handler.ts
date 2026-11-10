/**
 * hookline_support: Hookline's support agent.
 *
 * Hookline can see THAT a customer's webhooks are failing (its own delivery
 * logs). Only the customer can see WHY (their handler logs). This agent puts
 * the two halves together:
 *
 *   1. Reads Hookline's own delivery logs and signing-secret history.
 *   2. Calls the customer's acme_diagnostics agent over Blocks (cross-org,
 *      agent-to-agent) for the customer-side evidence.
 *   3. Matches both against Hookline's private runbook.
 *   4. Returns a diagnosis, optionally written up by an LLM.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeInlineArtifact,
  type ArtifactEvent,
  type HandlerResult,
  type StartTaskMessage,
  type TaskClient,
  type TaskContext,
  type TerminalEvent,
} from '@blocks-network/sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HOOKLINE_DATA_DIR ?? path.resolve(HERE, '../data');
const ACME_AGENT = process.env.ACME_DIAGNOSTICS_AGENT ?? 'acme_diagnostics';
const ACME_ENDPOINT = '/webhooks/hookline';
const WINDOW_MS = 24 * 60 * 60 * 1000;

export default async function handler(task: StartTaskMessage, ctx?: TaskContext): Promise<HandlerResult> {
  const question = task.requestParts?.[0]?.text ?? '';
  console.log(`[hookline_support] question from owner=${task.ownerId} org=${task.orgId}: ${question}`);

  // 1. Hookline's half of the picture.
  ctx?.reportStatus('Hookline: checking our delivery logs');
  const vendor = readVendorEvidence();

  // 2. Acme's half, from Acme's own agent, over Blocks.
  ctx?.reportStatus(`Hookline: asking ${ACME_AGENT} for Acme-side evidence`);
  // Ask only about the window around the problem (10 minutes before the first failure).
  const since = vendor.firstFailure
    ? new Date(Date.parse(vendor.firstFailure) - 10 * 60 * 1000).toISOString()
    : new Date(Date.now() - WINDOW_MS).toISOString();
  const acmeCall = await callAgent(ctx!.taskClient, ACME_AGENT, { endpoint: ACME_ENDPOINT, since });
  const acme = acmeCall.status === 'completed' && typeof acmeCall.artifact === 'object' ? (acmeCall.artifact as AcmeEvidence) : null;

  // 3. Combine with the private runbook.
  ctx?.reportStatus('Hookline: matching evidence against our runbook');
  const diagnosis = diagnose(vendor, acme);
  const evidence = { vendor, acme: acme ?? { error: acmeCall.error }, runbookEntry: diagnosis.runbookId };
  await ctx?.publishArtifact(JSON.stringify(evidence, null, 2), { mimeType: 'application/json', fileName: 'evidence.json' });

  // 4. Write it up.
  ctx?.reportStatus('Hookline: writing the diagnosis');
  const summary = (await llmSummary(question, diagnosis, evidence)) ?? diagnosis.summary;

  return {
    artifacts: [{ data: renderMarkdown(summary, diagnosis, vendor, acme), mimeType: 'text/markdown', fileName: 'diagnosis.md' }],
  };
}

// ---------------------------------------------------------------------------
// Agent-to-agent call (pattern from the Blocks agent-to-agent docs)
// ---------------------------------------------------------------------------

interface SubTaskResult {
  status: 'completed' | 'failed' | 'timeout';
  artifact?: unknown;
  error?: string;
}

async function callAgent(taskClient: TaskClient, agentName: string, input: unknown): Promise<SubTaskResult> {
  try {
    // ownerId is omitted on purpose: the call is made as this agent, not as the original caller.
    const session = await taskClient.sendMessage({
      agentName,
      requestParts: [{ partId: 'request', text: JSON.stringify(input) }],
    });

    return await new Promise<SubTaskResult>((resolve) => {
      let artifact: unknown;
      let settled = false;
      const finish = (result: SubTaskResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.close();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: 'timeout', error: `${agentName} timed out` }), 30_000);

      session.onArtifact((event: ArtifactEvent) => {
        const ref = event.artifactRef;
        if (ref.kind !== 'inline') return;
        const text = new TextDecoder().decode(decodeInlineArtifact(ref));
        try { artifact = JSON.parse(text); } catch { artifact = text; }
      });
      session.onTerminal((event: TerminalEvent) => {
        finish(event.state === 'completed' ? { status: 'completed', artifact } : { status: 'failed', error: String(event.state) });
      });
    });
  } catch (err) {
    // A revoked grant lands here: the network rejects the call.
    return { status: 'failed', error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Hookline's own evidence
// ---------------------------------------------------------------------------

interface VendorEvidence {
  activeSecretFp: string;
  previousSecretFp: string | null;
  rotatedAt: string | null;
  deliveries: number;
  failures: number;
  firstFailure: string | null;
  failureStatuses: number[];
}

interface AcmeEvidence {
  deliveries_seen: number;
  failures: number;
  first_failure: string | null;
  error_classes: string[];
  framework: string | null;
  sdk: string | null;
  configured_secret_fp: string | null;
  failing_events: { ts: string; event_id: string; http_status: number; error: string }[];
  withheld: string[];
}

const fp = (secret: string) => createHash('sha256').update(secret).digest('hex').slice(0, 8);

function readVendorEvidence(): VendorEvidence {
  const secrets = JSON.parse(readFileSync(path.join(DATA_DIR, 'secrets.json'), 'utf8'));
  const logFile = path.join(DATA_DIR, 'deliveries.jsonl');
  const cutoff = Date.now() - WINDOW_MS;
  const deliveries = (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : [])
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((d) => d.endpoint === ACME_ENDPOINT && Date.parse(d.ts) >= cutoff);
  const failures = deliveries.filter((d) => d.status >= 400);

  return {
    activeSecretFp: fp(secrets.active),
    previousSecretFp: secrets.previous ? fp(secrets.previous) : null,
    rotatedAt: secrets.rotated_at,
    deliveries: deliveries.length,
    failures: failures.length,
    firstFailure: failures[0]?.ts ?? null,
    failureStatuses: [...new Set<number>(failures.map((d) => d.status))],
  };
}

// ---------------------------------------------------------------------------
// Diagnosis: deterministic, so the demo never depends on model quality
// ---------------------------------------------------------------------------

interface Diagnosis {
  runbookId: string | null;
  title: string;
  summary: string;
  runbook: string;
}

function diagnose(vendor: VendorEvidence, acme: AcmeEvidence | null): Diagnosis {
  if (!acme) {
    return {
      runbookId: null,
      title: 'Customer-side evidence unavailable',
      summary: `Hookline sees ${vendor.failures} failed deliveries but could not reach ${ACME_AGENT}. Escalating to a human.`,
      runbook: '',
    };
  }
  let id: string | null = null;
  if (acme.configured_secret_fp && acme.configured_secret_fp === vendor.previousSecretFp && acme.configured_secret_fp !== vendor.activeSecretFp) {
    id = 'HL-101';
  } else if (acme.error_classes.includes('TimestampOutsideTolerance')) {
    id = 'HL-103';
  } else if (acme.error_classes.some((e) => e.startsWith('SignatureVerificationError'))) {
    id = 'HL-102';
  }
  const entry = id ? runbookEntry(id) : null;
  return {
    runbookId: id,
    title: entry?.title ?? 'No known issue matched',
    summary: entry?.fix ?? 'The evidence does not match a known issue. Escalating to a Hookline engineer with the evidence attached.',
    runbook: entry?.body ?? '',
  };
}

function runbookEntry(id: string) {
  const runbook = readFileSync(path.join(HERE, 'runbook.md'), 'utf8');
  const section = runbook.split(/^## /m).find((s) => s.startsWith(id));
  if (!section) return null;
  const [heading, ...rest] = section.split('\n');
  const body = rest.join('\n').trim();
  const fix = body.match(/\*\*Fix:\*\*\s*([\s\S]*?)(\n\n|$)/)?.[1]?.trim() ?? body;
  return { title: heading.replace(`${id}: `, '').trim(), body, fix };
}

// ---------------------------------------------------------------------------
// Optional LLM write-up (any OpenAI-compatible endpoint, e.g. Ollama)
// ---------------------------------------------------------------------------

async function llmSummary(question: string, diagnosis: Diagnosis, evidence: unknown): Promise<string | null> {
  const baseUrl = process.env.LLM_BASE_URL;
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY ?? 'none'}` },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? 'qwen2.5:7b',
        messages: [
          {
            role: 'system',
            content:
              'You are Hookline support. Reply to the customer in 3-5 plain sentences: what is wrong, why, and the exact fix. Use only the evidence and runbook given. Never invent details.',
          },
          { role: 'user', content: `Question: ${question}\n\nRunbook entry:\n${diagnosis.runbook}\n\nEvidence:\n${JSON.stringify(evidence)}` },
        ],
      }),
    });
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    console.warn('[hookline_support] LLM unavailable, using runbook text:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------

function renderMarkdown(summary: string, d: Diagnosis, v: VendorEvidence, a: AcmeEvidence | null): string {
  const lines = [
    `# ${d.title}`,
    '',
    summary,
    '',
    '## Evidence',
    '',
    '| | Hookline (vendor side) | Acme (customer side) |',
    '|---|---|---|',
    `| Signing secret | active \`${v.activeSecretFp}\`${v.rotatedAt ? `, rotated ${v.rotatedAt}` : ''} | configured \`${a?.configured_secret_fp ?? 'n/a'}\` |`,
    `| Failures | ${v.failures} of ${v.deliveries} deliveries (HTTP ${v.failureStatuses.join(', ') || 'none'}) | ${a?.failures ?? 'n/a'} rejected |`,
    `| First failure | ${v.firstFailure ?? 'n/a'} | ${a?.first_failure ?? 'n/a'} |`,
    `| Errors | n/a | ${a?.error_classes.join(', ') || 'n/a'} |`,
    `| Stack | n/a | ${a ? `${a.framework}, ${a.sdk}` : 'n/a'} |`,
    '',
    '## What crossed the network',
    '',
    a ? `Acme released event IDs, error classes and a secret fingerprint. Withheld: ${a.withheld.join(', ')}.` : 'Nothing: the call to Acme was rejected.',
  ];
  if (d.runbookId) lines.push('', `Matched internal runbook entry **${d.runbookId}**.`);
  return lines.join('\n') + '\n';
}
