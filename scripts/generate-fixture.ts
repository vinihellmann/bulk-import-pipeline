/**
 * Generates a large product CSV for load testing the pipeline.
 *
 *   npm run generate:fixture -- --rows 250000 --error-rate 0.01 --out fixtures/large-products.csv
 *
 * The file is written with backpressure, so memory stays flat regardless of the row count.
 * Output is deterministic for a given --seed, which makes runs comparable.
 */
import { once } from 'node:events';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    rows: { type: 'string', default: '100000' },
    'error-rate': { type: 'string', default: '0.01' },
    out: { type: 'string', default: 'fixtures/large-products.csv' },
    seed: { type: 'string', default: '42' },
  },
});

const rows = Number(values.rows);
const errorRate = Number(values['error-rate']);
const out = path.resolve(values.out ?? 'fixtures/large-products.csv');
if (!Number.isInteger(rows) || rows < 1) throw new Error('--rows must be a positive integer');
if (!(errorRate >= 0 && errorRate <= 1)) throw new Error('--error-rate must be within [0, 1]');

// Mulberry32: tiny, fast, seedable PRNG.
let state = Number(values.seed) >>> 0;
function random(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

const CATEGORIES = ['tools', 'home', 'office', 'electronics', 'garden', 'kitchen', 'sports'];
const ADJECTIVES = ['Compact', 'Pro', 'Classic', 'Smart', 'Heavy Duty', 'Eco', 'Ultra'];
const NOUNS = ['Drill', 'Lamp', 'Chair', 'Kettle', 'Router', 'Backpack', 'Blender', 'Hose'];

function row(i: number): string {
  const sku = `GEN-${String(i).padStart(8, '0')}`;
  const name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${i}`;
  const description = random() < 0.3 ? '' : `"Generated item ${i}, batch ${Math.floor(i / 1000)}"`;
  let price = (random() * 999 + 1).toFixed(2);
  let stock = String(Math.floor(random() * 500));

  if (random() < errorRate) {
    // Inject one realistic defect per bad row.
    if (random() < 0.5) price = random() < 0.5 ? '0' : 'N/A';
    else stock = '-1';
  }
  return `${sku},${name},${description},${price},${stock},${pick(CATEGORIES)}\n`;
}

async function main(): Promise<void> {
  mkdirSync(path.dirname(out), { recursive: true });
  const stream = createWriteStream(out);
  const started = Date.now();

  stream.write('sku,name,description,price,stock,category\n');
  for (let i = 1; i <= rows; i++) {
    if (!stream.write(row(i))) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'finish');

  process.stdout.write(
    `Wrote ${rows.toLocaleString('en-US')} rows to ${out} in ${Date.now() - started}ms\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
