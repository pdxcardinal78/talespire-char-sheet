#!/usr/bin/env node
/**
 * CLI front end for the normalizer that the Symbiote uses.
 *
 *   node prototype/normalize-cli.js prototype/sample-character.json
 *   node prototype/normalize-cli.js prototype/sample-character.json --json > sheet.json
 *
 * The logic lives in symbiote/lib/ddb.js so there is exactly one copy of it.
 */

const { readFileSync } = require("node:fs");
const { normalize, signed } = require("../symbiote/lib/ddb.js");

const file = process.argv[2];
if (!file) {
  console.error("usage: node normalize-cli.js <character.json> [--json]");
  process.exit(1);
}

const sheet = normalize(JSON.parse(readFileSync(file, "utf8")));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(sheet, null, 2));
  process.exit(0);
}

const { identity: id, abilities: ab } = sheet;
const line = (l, r) => console.log(`  ${String(l).padEnd(22)} ${r}`);

console.log(`\n${id.name} — ${id.species} ${id.classes.map((c) => `${c.name} ${c.level}`).join(" / ")}`);
console.log("─".repeat(64));
line("Background", id.background);
line("Proficiency bonus", signed(sheet.proficiencyBonus));
line("AC", `${sheet.ac.value}  (${sheet.ac.summary.join(" + ")})`);
line("HP", `${sheet.hp.current}/${sheet.hp.max}${sheet.hp.temp ? ` (+${sheet.hp.temp} temp)` : ""}`);
line("Hit dice", sheet.hp.hitDice.map((h) => `${h.total}${h.die}`).join(", "));
line("Initiative", signed(sheet.initiative));
line("Speed", Object.entries(sheet.speeds).map(([k, v]) => `${k} ${v}`).join(", "));
line("Senses", `passive perception ${sheet.senses.passivePerception}${sheet.senses.darkvision ? `, darkvision ${sheet.senses.darkvision} ft.` : ""}`);

console.log("\n  Abilities");
for (const [k, v] of Object.entries(ab)) {
  const save = sheet.savingThrows.find((s) => s.key === k);
  const caveat = save.conditionalAdvantage.length ? `  adv ${save.conditionalAdvantage[0]}` : "";
  console.log(
    `    ${v.name.padEnd(13)} ${String(v.score).padStart(2)}  ${signed(v.mod).padStart(3)}   save ${signed(save.value).padStart(3)}${save.proficient ? " ●" : "  "}${save.advantage ? " (adv)" : ""}${caveat}`
  );
}

const prof = sheet.skills.filter((s) => s.proficient || s.expertise);
console.log(`\n  Skill proficiencies (${prof.length})`);
for (const s of prof) console.log(`    ${s.name.padEnd(18)} ${signed(s.value)}${s.expertise ? "  (expertise)" : ""}`);

console.log("\n  Attacks");
for (const a of sheet.attacks) {
  console.log(`    ${a.name.padEnd(12)} ${a.attackRoll.padEnd(7)} dmg ${a.damageRoll.padEnd(8)} ${a.damageType || ""} ${a.proficient ? "" : "(not proficient)"}`);
}

for (const b of sheet.spellcasting.blocks) {
  const head = b.ability ? `${b.className}  DC ${b.saveDc}, attack ${signed(b.attackBonus)}` : b.className;
  console.log(`\n  ${head}`);
  const byLevel = {};
  for (const s of b.spells) (byLevel[s.level] ||= []).push(s);
  for (const lvl of Object.keys(byLevel).sort()) {
    const label = lvl === "0" ? "Cantrips" : `Level ${lvl}`;
    const names = byLevel[lvl].map((s) => {
      const dice = s.damage?.[0]?.roll || s.healing;
      return s.name + (s.prepared ? "*" : "") + (dice ? ` [${dice}]` : "");
    });
    console.log(`    ${label.padEnd(10)} ${names.join(", ")}`);
  }
}

const slots = sheet.spellcasting.slots.filter((s) => s.available > 0);
if (slots.length) {
  console.log(`\n  Spell slots        ${slots.map((s) => `L${s.level}: ${s.remaining}/${s.available}`).join("   ")}`);
}

if (sheet.resources.length) {
  console.log("\n  Limited-use resources");
  for (const r of sheet.resources) {
    console.log(`    ${r.name.padEnd(18)} ${r.remaining}/${r.max}   resets on ${r.resetsOn}`);
  }
}

if (sheet.conditions.length) console.log(`\n  Conditions         ${sheet.conditions.map((c) => c.name).join(", ")}`);
if (sheet.defenses.resistances.length) console.log(`  Resistances        ${sheet.defenses.resistances.join(", ")}`);

console.log("\n  TaleSpire mini projection");
line("  HP", `${sheet.talespireProjection.hp.current}/${sheet.talespireProjection.hp.max}`);
for (const s of sheet.talespireProjection.stats) line(`  ${s.name}`, s.value);
console.log(`\n  ${sheet.inventory.length} inventory items · ${sheet.features.length} features · ${sheet.spellcasting.blocks.reduce((t, b) => t + b.spells.length, 0)} spells\n`);
