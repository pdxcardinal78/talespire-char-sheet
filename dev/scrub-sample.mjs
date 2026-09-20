#!/usr/bin/env node
/**
 * Replace the identities in a D&D Beyond export with synthetic ones.
 *
 * The test fixture was a real character, which meant the repository carried its
 * owner's D&D Beyond username and user id, the DM's username, and the usernames
 * and character names of fifteen other players at that table. Those last ones
 * are not the repository owner's to publish.
 *
 * What makes the file useful as a fixture is its mechanical shape — the
 * modifier graph, the inventory, the class and subclass features, the spell
 * lists. None of that is identifying, and none of it is touched here. Only the
 * labels change, so every code path the fixture exercises stays exercised.
 *
 *   node dev/scrub-sample.mjs prototype/sample-character.json
 *   node dev/scrub-sample.mjs in.json --out out.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
  console.error("usage: node dev/scrub-sample.mjs <character.json> [--out <file>]");
  process.exit(1);
}
const output = args.includes("--out") ? args[args.indexOf("--out") + 1] : input;

// Deliberately obvious stand-ins: anyone reading the fixture should be able to
// tell at a glance that it is not somebody's real character. Check any id you
// invent — 100000001 looked synthetic and belongs to a real D&D Beyond user.
const FAKE = {
  characterId: 123456789,
  userId: 200000001,
  username: "ExampleWarden",
  name: "Doran Stoneborne",
  campaignId: 300000001,
  campaignName: "The Example Campaign",
  dmUserId: 200000002,
  dmUsername: "ExampleGM",
};

const doc = JSON.parse(readFileSync(resolve(input), "utf8"));
const c = doc.data || doc;
const realName = c.name;
const realId = String(c.id);

// --- the character itself ---------------------------------------------------
c.id = FAKE.characterId;
c.userId = FAKE.userId;
c.username = FAKE.username;
c.name = FAKE.name;
c.socialName = null;
c.readonlyUrl = `https://dndbeyond.com/characters/${FAKE.characterId}`;

// Avatar URLs embed the character id, and the portrait is a real person's
// choice of art. Dropping them costs the fixture nothing — the normalizer only
// ever passes them through.
if (c.decorations) {
  for (const k of Object.keys(c.decorations)) {
    if (/avatarUrl$/i.test(k) || /backdropAvatarUrl$/i.test(k)) c.decorations[k] = null;
  }
  if (c.decorations.defaultBackdrop) {
    for (const k of Object.keys(c.decorations.defaultBackdrop)) c.decorations.defaultBackdrop[k] = null;
  }
}

// --- the table --------------------------------------------------------------
// The roster is the sharpest edge: fifteen other people's usernames and
// character names. The normalizer never reads it, so it is replaced with a
// single synthetic entry rather than deleted — the shape stays testable.
if (c.campaign) {
  c.campaign.id = FAKE.campaignId;
  c.campaign.name = FAKE.campaignName;
  c.campaign.description = "";
  c.campaign.link = `/campaigns/${FAKE.campaignId}`;
  c.campaign.publicNotes = "";
  c.campaign.dmUserId = FAKE.dmUserId;
  c.campaign.dmUsername = FAKE.dmUsername;
  c.campaign.characters = [
    {
      userId: FAKE.userId,
      username: FAKE.username,
      characterId: FAKE.characterId,
      characterName: FAKE.name,
      characterUrl: `/profile/${FAKE.username}/characters/${FAKE.characterId}`,
      avatarUrl: null,
      privacyType: 3,
      campaignId: null,
      isAssigned: true,
    },
  ];
}

// --- prose the player wrote -------------------------------------------------
// Backstory, traits, bonds and flaws are someone's creative writing and name the
// character throughout. Replaced with short neutral text that keeps the fields
// populated, since an empty string and a filled one are different code paths.
if (c.notes) {
  c.notes.backstory = "Example backstory text for a test fixture.";
  for (const k of ["allies", "personalPossessions", "otherHoldings", "organizations", "enemies", "otherNotes"]) {
    if (c.notes[k]) c.notes[k] = "";
  }
}
if (c.traits) {
  c.traits.personalityTraits = "Example personality trait.";
  c.traits.ideals = "Example ideal.";
  c.traits.bonds = "Example bond.";
  c.traits.flaws = "Example flaw.";
  if (c.traits.appearance) c.traits.appearance = "";
}

// --- anything left over -----------------------------------------------------
// A last pass over the serialised document, because ids and names turn up in
// URLs and nested blobs that are tedious to enumerate and easy to miss.
let json = JSON.stringify(doc);
const before = json;
json = json.split(realId).join(String(FAKE.characterId));
if (realName) {
  json = json.split(JSON.stringify(realName).slice(1, -1)).join(FAKE.name);
  // The short form people use in prose, e.g. `Ann` from `Ann "Nan" Smith`.
  const first = realName.split(/[\s"]/).filter(Boolean)[0];
  if (first && first.length > 3) json = json.split(first).join(FAKE.name.split(" ")[0]);
}
const sweptIds = (before.match(new RegExp(realId, "g")) || []).length;

writeFileSync(resolve(output), json);

console.log(`Scrubbed ${input}`);
console.log(`  character  ${realName} -> ${FAKE.name}`);
console.log(`  ids swept  ${sweptIds} occurrences of ${realId}`);
console.log(`  roster     replaced with 1 synthetic entry`);
console.log(`  written to ${output}`);
