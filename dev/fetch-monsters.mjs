#!/usr/bin/env node
/**
 * Build the bundled monster list from Open5e.
 *
 * The SRD set ships inside the mod so a GM can run a fight with no network and
 * no paste step. Open5e's other ~2,900 monsters stay online and opt-in — they
 * are too large to bundle and most tables never touch them.
 *
 * This writes a file into the Symbiote, so it is a build step, not something the
 * panel does at runtime.
 *
 *   node dev/fetch-monsters.mjs                 # SRD, the bundled default
 *   node dev/fetch-monsters.mjs --source tob    # any other Open5e document slug
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : "wotc-srd";
const OUT = resolve(ROOT, "symbiote/data/monsters.js");

// Everything the sheet reads. `desc`, artwork and cross-links are the bulk of a
// record and none of it is rendered, so it is dropped rather than shipped.
const KEEP = [
  "slug", "name", "size", "type", "subtype", "alignment",
  "armor_class", "armor_desc", "hit_points", "hit_dice", "speed",
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
  "strength_save", "dexterity_save", "constitution_save",
  "intelligence_save", "wisdom_save", "charisma_save",
  "perception", "skills",
  "damage_vulnerabilities", "damage_resistances", "damage_immunities",
  "condition_immunities", "senses", "languages", "challenge_rating", "cr",
  "actions", "bonus_actions", "reactions",
  "legendary_desc", "legendary_actions", "special_abilities",
  "document__title", "document__license_url",
];

const empty = (v) =>
  v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

function trim(monster) {
  const out = {};
  for (const key of KEEP) if (!empty(monster[key])) out[key] = monster[key];
  return out;
}

async function fetchAll(slug) {
  const all = [];
  let url = `https://api.open5e.com/v1/monsters/?document__slug=${encodeURIComponent(slug)}&limit=200`;
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

console.log(`Fetching monsters from Open5e (document: ${source})`);
const raw = await fetchAll(source);
const monsters = raw.map(trim).sort((a, b) => a.name.localeCompare(b.name));

// Licences differ per source and have to travel with the data.
const licenses = [...new Set(monsters.map((m) => `${m.document__title} — ${m.document__license_url}`))];

const payload = {
  source,
  fetchedAt: new Date().toISOString().slice(0, 10),
  licenses,
  monsters,
};

// Written as a script that assigns a global, not as JSON.
//
// A Symbiote installed locally runs from a file origin, where `fetch` of a
// relative path is blocked — the same restriction that rules out ES modules. A
// <script> tag has no such problem, so the data arrives the one way that works
// both in the game and over http.
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `window.SPIREKEEPER_MONSTERS = ${JSON.stringify(payload)};\n`);

console.log(`\n  ${monsters.length} monsters  ${kb(JSON.stringify(raw).length)} -> ${kb(JSON.stringify(payload).length)}`);
for (const l of licenses) console.log(`  ${l}`);
console.log(`  written to symbiote/data/monsters.js`);
