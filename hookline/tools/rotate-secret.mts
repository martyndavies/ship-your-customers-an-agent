/**
 * Rotate Hookline's webhook signing secret for Acme.
 * Acme is not told, which is the point of the demo.
 *
 * Usage (from hookline_support): npm run rotate
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/secrets.json');
const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

const current = JSON.parse(readFileSync(file, 'utf8'));
const next = { active: `whsec_${randomBytes(18).toString('hex')}`, previous: current.active, rotated_at: new Date().toISOString() };
writeFileSync(file, JSON.stringify(next, null, 2) + '\n');

console.log(`Rotated signing secret: ${fp(current.active)} -> ${fp(next.active)} at ${next.rotated_at}`);
