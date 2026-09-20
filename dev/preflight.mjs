#!/usr/bin/env node
/**
 * Validate the Symbiote before handing it to TaleSpire.
 *
 * TaleSpire reports a failed manifest as a small warning marker in the Symbiote
 * list, with the detail buried in `.debug/log.txt`. Catching the common mistakes
 * here is faster than round-tripping through the game.
 *
 *   node dev/preflight.mjs                          # the shipping Symbiote
 *   node dev/preflight.mjs spirekeeper_v2/symbiote  # any other build
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A second build lives alongside the first, so the target is an argument rather
// than a constant — one validator, no copy to drift out of date.
const TARGET = process.argv[2] || "symbiote";
const DIR = resolve(ROOT, TARGET);

const problems = [];
const warnings = [];
const ok = [];

const fail = (m) => problems.push(m);
const warn = (m) => warnings.push(m);
const pass = (m) => ok.push(m);

// Namespace -> event sources, from the Symbiote API 0.1 docs. A subscription to
// anything not on this list silently never fires.
const SUBSCRIPTIONS = {
  urls: ["onUrlMessage"],
  rulers: ["onRulerEvent"],
  chat: ["onChatMessage"],
  creatures: ["onCreatureStateChange", "onCreatureSelectionChange"],
  sync: ["onSyncMessage", "onClientEvent"],
  dice: ["onRollResults"],
  slabs: ["onSlabCopied"],
  contentPacks: ["onContentPackChange"],
  clients: ["onClientEvent"],
  symbiote: ["onVisibilityEvent", "onStateChangeEvent", "onNotificationEvent"],
  players: ["onCampaignPlayerEvent", "onBoardPlayerEvent"],
  initiative: ["onInitiativeEvent"],
  picking: ["onPickingEvent"],
};

const CAPABILITIES = ["playAudio", "runInBackground"];
const EXTRAS = ["fonts", "icons", "colorStyles", "diceFinder"];

// --- manifest ---------------------------------------------------------------

const manifestPath = join(DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("No manifest.json in symbiote/ — TaleSpire won't see this folder at all.");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  pass("manifest.json parses");
} catch (e) {
  console.error(`manifest.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

for (const field of ["manifestVersion", "name", "entryPoint"]) {
  if (manifest[field] === undefined) fail(`manifest is missing the required field "${field}"`);
}
if (manifest.manifestVersion !== 1) warn(`manifestVersion is ${manifest.manifestVersion}; this project targets 1`);
if (manifest.name && manifest.name.length > 80) fail("name is over the 80 character limit");
if (manifest.summary && manifest.summary.length > 250) fail("summary is over the 250 character limit");

// --- entry point and referenced files ---------------------------------------

const localPath = (p) => join(DIR, p.replace(/^\//, ""));
const isRemote = (p) => /^https?:\/\//i.test(p);

let entryHtml = null;
if (manifest.entryPoint) {
  if (isRemote(manifest.entryPoint)) {
    warn(`entryPoint is remote (${manifest.entryPoint}); local files below aren't checked`);
  } else if (!manifest.entryPoint.startsWith("/")) {
    fail(`entryPoint "${manifest.entryPoint}" must start with "/" or be a full URL`);
  } else if (!existsSync(localPath(manifest.entryPoint))) {
    fail(`entryPoint "${manifest.entryPoint}" does not exist`);
  } else {
    pass(`entryPoint ${manifest.entryPoint} exists`);
    entryHtml = readFileSync(localPath(manifest.entryPoint), "utf8");
  }
}

if (manifest.descriptionFilePath && !existsSync(localPath(manifest.descriptionFilePath))) {
  fail(`descriptionFilePath "${manifest.descriptionFilePath}" does not exist`);
}

for (const [size, path] of Object.entries(manifest.icons || {})) {
  if (!existsSync(localPath(path))) fail(`icon "${size}" points at missing file ${path}`);
}

// --- scripts referenced by the entry page -----------------------------------

const scriptSrcs = [];
if (entryHtml) {
  for (const m of entryHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const src = m[1];
    if (isRemote(src)) {
      warn(`entry page loads a remote script (${src}); it will fail if the machine is offline`);
      continue;
    }
    scriptSrcs.push(src);
    if (!existsSync(join(DIR, src))) fail(`entry page references missing script ${src}`);
  }

  if (/<script[^>]+type=["']module["']/i.test(entryHtml)) {
    fail("entry page uses an ES module script; a local Symbiote loads from a file origin where module imports are blocked");
  }

  if (scriptSrcs.length) pass(`${scriptSrcs.length} local scripts referenced and present`);
}

const allScriptSource = scriptSrcs
  .filter((src) => existsSync(join(DIR, src)))
  .map((src) => readFileSync(join(DIR, src), "utf8"))
  .join("\n");

// --- duplicate declarations -------------------------------------------------
//
// Two functions of the same name in the same scope is legal JavaScript: the
// later one silently replaces the earlier, and every existing call site starts
// running the wrong body. It has happened twice in this project — once to
// `renderBindBar`, once to `refreshInitiative`, where the GM's initiative
// tracker quietly stopped receiving a turn queue. Nothing throws, so nothing
// surfaces until someone notices a feature that simply does nothing.

for (const src of scriptSrcs) {
  const body = readFileSync(join(DIR, src), "utf8");
  const seen = new Map();
  // Top-level declarations within a file's single IIFE share one scope, so
  // indentation is a good enough proxy for "same scope" here.
  for (const m of body.matchAll(/^(\s*)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const key = `${m[1].length}:${m[2]}`;
    const line = body.slice(0, m.index).split("\n").length;
    if (seen.has(key)) {
      fail(
        `${src} declares function "${m[2]}" twice at the same nesting (lines ${seen.get(key)} and ${line}) — ` +
          "the later one replaces the earlier and every caller silently gets the wrong body"
      );
    } else {
      seen.set(key, line);
    }
  }
}
if (scriptSrcs.length && !problems.length) pass("no duplicate function declarations");

// --- things that only break inside TaleSpire ---------------------------------

// A locally installed Symbiote runs from a file origin. `fetch` of a relative
// path is blocked there, so any same-origin fetch works perfectly over http in
// dev and fails silently in the game — the worst kind of bug to ship.
const SAME_ORIGIN_FETCH = /fetch\(\s*["'`](?!https?:)[^"'`]+["'`]/g;
for (const src of scriptSrcs) {
  const body = readFileSync(join(DIR, src), "utf8");
  for (const m of body.matchAll(SAME_ORIGIN_FETCH)) {
    fail(`${src} fetches a relative path (${m[0].slice(6)}…) — blocked on the file origin a local Symbiote runs from. Load it with a script tag instead.`);
  }
}
if (scriptSrcs.length && !problems.length) pass("no same-origin fetches (file origin safe)");

// The version shown in the panel is stated in code because it cannot be fetched;
// this is what stops it drifting from the manifest.
const versionInCode = allScriptSource.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
if (versionInCode) {
  if (versionInCode[1] !== manifest.version) {
    fail(`APP_VERSION is "${versionInCode[1]}" but the manifest says "${manifest.version}" — the panel would report the wrong build`);
  } else {
    pass(`APP_VERSION matches the manifest (${manifest.version})`);
  }
}

// Data files loaded by script tag have to exist.
for (const m of allScriptSource.matchAll(/tag\.src\s*=\s*["']([^"']+)["']/g)) {
  if (!existsSync(join(DIR, m[1]))) fail(`a script tag loads "${m[1]}", which is missing from the Symbiote`);
  else pass(`${m[1]} is present`);
}

// --- api block --------------------------------------------------------------

const api = manifest.api || {};
if (!api.version) {
  warn("no api.version, so TaleSpire will not inject the TS object at all");
} else {
  pass(`api.version ${api.version}`);
}

const subs = api.subscriptions || {};
let handlerCount = 0;

for (const [ns, sources] of Object.entries(subs)) {
  if (!SUBSCRIPTIONS[ns]) {
    fail(`subscription namespace "${ns}" is not a real namespace — events will never fire`);
    continue;
  }
  for (const [source, handler] of Object.entries(sources)) {
    if (!SUBSCRIPTIONS[ns].includes(source)) {
      fail(`"${ns}.${source}" is not a real event source — expected one of: ${SUBSCRIPTIONS[ns].join(", ")}`);
      continue;
    }
    handlerCount++;
    // The handler must be a global function; TaleSpire calls it by name.
    const declared = new RegExp(`(?:async\\s+)?function\\s+${handler}\\s*\\(|(?:var|let|const)\\s+${handler}\\s*=`).test(allScriptSource);
    if (!declared) {
      fail(`subscription "${ns}.${source}" names handler "${handler}", which no loaded script defines as a global`);
    }
  }
}
if (handlerCount && !problems.length) pass(`${handlerCount} event subscriptions resolve to real handlers`);

// sync, notifications and symbiote URLs all require an interop id
const needsInterop = Boolean(subs.sync) || /TS\.sync\.|TS\.symbiote\.sendNotification|createUrlPrefixForThisSymbiote/.test(allScriptSource);
const interopId = api.interop?.id;
if (needsInterop && !interopId) {
  fail("this Symbiote uses sync, notifications or symbiote URLs but the manifest has no api.interop.id");
} else if (interopId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(interopId)) {
    warn(`api.interop.id "${interopId}" is not a well-formed UUIDv4`);
  } else {
    pass("interop id is a valid UUIDv4");
  }
}

// --- the extension's target --------------------------------------------------
//
// The browser extension addresses this Symbiote by interop id, baked into
// link.js. If the two drift apart, every roll is launched successfully by the
// browser and lands nowhere — Chrome reports success, the panel reports
// nothing, and there is no error anywhere to follow. Exactly the silent kind
// this file exists to catch.

const extensionLink = join(dirname(DIR), "extension", "link.js");
if (existsSync(extensionLink) && interopId) {
  const src = readFileSync(extensionLink, "utf8");
  const declared = src.match(/INTEROP_ID\s*=\s*["']([^"']+)["']/)?.[1];
  if (!declared) {
    warn("extension/link.js has no INTEROP_ID to check against the manifest");
  } else if (declared !== interopId) {
    fail(
      `extension/link.js targets interop id ${declared} but this Symbiote's is ${interopId} — ` +
        "rolls would launch successfully and arrive nowhere"
    );
  } else {
    pass("extension targets this Symbiote's interop id");
  }
}

// --- environment ------------------------------------------------------------

const env = manifest.environment || {};
for (const cap of env.capabilities || []) {
  if (!CAPABILITIES.includes(cap)) warn(`unknown capability "${cap}"`);
}
for (const extra of env.extras || []) {
  if (!EXTRAS.includes(extra) && !extra.startsWith("/")) warn(`unknown extra "${extra}"`);
}
if (env.webViewBackgroundColor && !/^#[0-9a-f]{3,8}$/i.test(env.webViewBackgroundColor)) {
  warn(`webViewBackgroundColor "${env.webViewBackgroundColor}" is not a hex colour`);
}

// --- report -----------------------------------------------------------------

const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", D = "\x1b[2m", X = "\x1b[0m";

for (const m of ok) console.log(`${G}  ok${X}   ${m}`);
for (const m of warnings) console.log(`${Y}  warn${X} ${m}`);
for (const m of problems) console.log(`${R}  FAIL${X} ${m}`);

console.log();
console.log(`\x1b[2m  ${TARGET}\x1b[0m`);
if (problems.length) {
  console.log(`${R}${problems.length} problem(s) — TaleSpire will likely reject or silently misbehave.${X}`);
  process.exit(1);
}
console.log(`${G}Ready to load.${X} ${D}${warnings.length ? `${warnings.length} warning(s).` : ""}${X}`);
