#!/usr/bin/env node
/**
 * Prove that compacting a character payload changes nothing.
 *
 * The sheet keeps a trimmed copy of the D&D Beyond payload so that equipping and
 * unequipping items can re-derive armour class, ability scores and saves without
 * a re-import. That copy is built from an explicit keep-list, which is only safe
 * for as long as it stays in step with what the normaliser reads — so this
 * compares the normalised output of the full payload against the compacted one
 * and fails on any difference.
 *
 *   node dev/compaction-test.mjs [character.json ...]
 *
 * Defaults to the bundled sample. Pass real exports to widen the check; a
 * high-level multiclass with a full inventory exercises far more of the payload
 * than the sample does.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DDB = createRequire(import.meta.url)(resolve(ROOT, "symbiote/lib/ddb.js"));

const files = process.argv.slice(2);
if (!files.length) files.push(resolve(ROOT, "prototype/sample-character.json"));

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", X = "\x1b[0m";
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

let failed = 0;

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const compact = DDB.compactPayload(raw);

  const before = JSON.stringify(DDB.normalize(raw));
  const after = JSON.stringify(DDB.normalize(compact));
  const name = JSON.parse(before).identity?.name || file;

  if (before === after) {
    const stored = JSON.stringify(compact).length + before.length;
    console.log(
      `${G}  ok${X}   ${name} ${D}— payload ${kb(JSON.stringify(raw).length)} -> ` +
        `${kb(JSON.stringify(compact).length)}, ${kb(stored)} stored per character${X}`
    );
    continue;
  }

  failed++;
  console.log(`${R}  FAIL${X} ${name} — compaction changed the derived sheet`);
  const a = JSON.parse(before), b = JSON.parse(after);
  for (const key of Object.keys(a)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      console.log(`         "${key}" differs — add what it reads to PAYLOAD_KEEP in lib/ddb.js`);
    }
  }
}

console.log();
if (failed) {
  console.log(`${R}${failed} payload(s) lost information when compacted.${X}`);
  process.exit(1);
}
console.log(`${G}Compaction is lossless.${X}`);
