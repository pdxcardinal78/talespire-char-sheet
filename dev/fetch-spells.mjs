#!/usr/bin/env node
/**
 * Build the bundled spell list from Open5e.
 *
 * D&D Beyond's character export does not carry spells a subclass grants through
 * its feature table — a Twilight Domain cleric's export names faerie fire,
 * moonbeam, see invisibility and sleep only inside the feature's prose, never as
 * spell objects. The website merges them in from a separate service. This is
 * where the panel gets the details it needs to make them castable.
 *
 * The 2024 SRD is the document to use: these characters are on 2024 rules, and
 * the two editions genuinely differ — 2014 Sleep drops creatures by hit point
 * total, 2024 Sleep is a Wisdom save against Incapacitated. Shipping the wrong
 * one would be quietly wrong on exactly the spell a player is about to cast.
 *
 * This writes a file into the Symbiote, so it is a build step, not something the
 * panel does at runtime.
 *
 *   node dev/fetch-spells.mjs                      # 2024 SRD, the bundled default
 *   node dev/fetch-spells.mjs --source srd-2014    # any other Open5e document key
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : "srd-2024";
const OUT = resolve(ROOT, "symbiote/data/spells.js");

// Everything lib/spells.js reads when it builds a sheet-shaped spell. Anything
// not on this list is Open5e bookkeeping — cross-references, target metadata,
// per-class availability — and none of it is rendered.
const KEEP = [
  "key", "name", "level", "desc", "higher_level",
  "casting_time", "reaction_condition",
  "range", "range_text", "range_unit",
  "shape_type", "shape_size", "shape_size_unit",
  "duration", "concentration", "ritual",
  "verbal", "somatic", "material", "material_specified",
  "saving_throw_ability", "attack_roll", "damage_roll", "damage_types",
];

const empty = (v) =>
  v == null || v === "" || v === false || (Array.isArray(v) && !v.length);

/**
 * Upcasting, as dice rather than prose.
 *
 * `higher_level` says "the damage increases by 1d10 for each spell slot level
 * above 2", which a regex can usually parse and sometimes cannot. Open5e also
 * publishes the resolved dice for every slot level, so the panel reads those and
 * never has to guess.
 */
function upcastTable(spell) {
  const out = {};
  for (const opt of spell.casting_options || []) {
    const level = /^slot_level_(\d+)$/.exec(opt.type || "")?.[1];
    if (!level || !opt.damage_roll) continue;
    out[level] = opt.damage_roll;
  }
  return Object.keys(out).length ? out : null;
}

function trim(spell) {
  const out = {};
  for (const key of KEEP) if (!empty(spell[key])) out[key] = spell[key];
  if (spell.school?.name) out.school = spell.school.name;
  const upcast = upcastTable(spell);
  if (upcast) out.upcast = upcast;
  return out;
}

async function fetchAll(key) {
  const all = [];
  let url = `https://api.open5e.com/v2/spells/?document__key=${encodeURIComponent(key)}&limit=100`;
  while (url) {
    process.stdout.write(`  fetching ${all.length ? `from ${all.length}` : "first page"}…\r`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open5e returned ${res.status} for ${url}`);
    const page = await res.json();
    all.push(...page.results);
    url = page.next;
  }
  return all;
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

console.log(`Fetching spells from Open5e (document: ${source})`);
const raw = await fetchAll(source);
if (!raw.length) {
  console.error(`\nNo spells returned for document "${source}" — check the key.`);
  process.exit(1);
}

const spells = raw.map(trim).sort((a, b) => a.name.localeCompare(b.name));

// Licences differ per source and have to travel with the data.
const doc = raw[0].document || {};
const licenses = [`${doc.name || source} — ${doc.permalink || "open5e.com"}`];

const payload = {
  source,
  fetchedAt: new Date().toISOString().slice(0, 10),
  licenses,
  spells,
};

// Written as a script that assigns a global, not as JSON.
//
// A Symbiote installed locally runs from a file origin, where `fetch` of a
// relative path is blocked — the same restriction that rules out ES modules. A
// <script> tag has no such problem, so the data arrives the one way that works
// both in the game and over http.
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `window.SPIREKEEPER_SPELLS = ${JSON.stringify(payload)};\n`);

console.log(`\n  ${spells.length} spells  ${kb(JSON.stringify(raw).length)} -> ${kb(JSON.stringify(payload).length)}`);
for (const l of licenses) console.log(`  ${l}`);
console.log(`  written to symbiote/data/spells.js`);
