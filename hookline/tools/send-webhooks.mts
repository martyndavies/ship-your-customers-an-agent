/**
 * Hookline's webhook sender (stand-in for Hookline's delivery service).
 * Signs each event with the active secret and logs the delivery result.
 *
 * Usage (from hookline_support): npm run send [count]
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, '../data');
try { process.loadEnvFile(path.resolve(HERE, '../hookline_support/.env')); } catch { /* no .env: use defaults */ }
const TARGET = process.env.ACME_WEBHOOK_URL ?? 'http://localhost:8787/webhooks/hookline';
const COUNT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 3);

const { active } = JSON.parse(readFileSync(path.join(DATA_DIR, 'secrets.json'), 'utf8'));
const fp = createHash('sha256').update(active).digest('hex').slice(0, 8);

for (let i = 0; i < COUNT; i++) {
  const event = {
    id: `evt_${randomBytes(6).toString('hex')}`,
    type: 'invoice.paid',
    created: new Date().toISOString(),
    data: { customer_email: 'jane.doe@acme-customers.example', amount: 4900, currency: 'eur' },
  };
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', active).update(`${t}.${body}`).digest('hex');

  let status = 0;
  try {
    const res = await fetch(TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Hookline-Signature': `t=${t},v1=${v1}` },
      body,
    });
    status = res.status;
  } catch {
    status = 599; // receiver unreachable
  }

  const delivery = {
    ts: new Date().toISOString(),
    customer: 'acme',
    endpoint: new URL(TARGET).pathname,
    event_id: event.id,
    event_type: event.type,
    status,
    signing_secret_fp: fp,
  };
  appendFileSync(path.join(DATA_DIR, 'deliveries.jsonl'), JSON.stringify(delivery) + '\n');
  console.log(`${delivery.ts}  ${status}  ${event.id}  (signed with ${fp})`);
}
