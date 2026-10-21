// Source-build loader. The standalone executable build replaces this module
// with a generated module containing the same pinned data.
import crypto from 'node:crypto';
import fs from 'node:fs';

const corpus = fs.readFileSync(new URL('../data/slopsquatting.jsonl', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const expected = '54e487fbe4fea9feffa6b6660c5e23a6ed58fd7b5539db981a545d5347dced74';
const actual = crypto.createHash('sha256').update(corpus).digest('hex');
if (actual !== expected) throw new Error(`Trend Micro corpus hash mismatch: ${actual}`);

export default corpus;
