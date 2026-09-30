/**
 * Persistence for Spirekeeper.
 *
 * TaleSpire gives Symbiotes two 5 MB string blobs: one global (follows the user
 * across campaigns) and one scoped to the current campaign. We use both:
 *
 *   global    — the sheet library. Import a character once, use it anywhere.
 *   campaign  — bindings from a mini (creature id) to a sheet, which are
 *               meaningless outside the campaign they were made in.
 *
 * The docs warn there are no atomicity guarantees when two TaleSpire instances
 * run on one machine, so every write is read-modify-write over a cached copy and
 * we never merge concurrent edits. For this data — a handful of sheets the user
 * edits by hand — last-write-wins is the honest tradeoff.
 */

const Store = (() => {
  const EMPTY_LIBRARY = { version: 1, sheets: {} };
  const EMPTY_BINDINGS = { version: 1, bindings: {}, statNamesOffered: false, encounters: {} };

  let library = null; // { version, sheets: { [sheetId]: sheet } }
  let bindings = null; // { version, bindings: { [creatureId]: sheetId } }

  /** TS calls report failure with a `cause` property rather than throwing. */
  const failed = (r) => r && r.cause !== undefined;

  // --- compression ---------------------------------------------------------
  //
  // Each sheet keeps a trimmed copy of its D&D Beyond payload so that equipping
  // an item can re-derive the numbers. That is cheap for one character and
  // expensive for a party: a level-20 with a full pack costs about 670 KB, and a
  // GM holding six of them would blow the 5 MB blob. The data is JSON — highly
  // repetitive — and gzips about six to one, which turns that party into a
  // comfortable fraction of the budget.
  //
  // Compression is best-effort. If the webview lacks the Streams compression API
  // the library is written as plain JSON exactly as before, and either form is
  // readable, so a blob written by one build always loads in the other.

  /** Scopes whose stored blob exists but could not be parsed; see readBlob. */
  const unreadable = new Set();

  // Deliberately still says "sheetbridge": this string is the marker on every
  // blob already written. Renaming it would make existing libraries unreadable,
  // which is a far worse trade than a stale word in a format tag.
  const ENVELOPE = "sheetbridge/gzip-base64";
  const BLOB_LIMIT = 5 * 1024 * 1024;

  const canCompress = () =>
    typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

  /** btoa over a large buffer overflows the argument list, so feed it in chunks. */
  function base64FromBytes(bytes) {
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function bytesFromBase64(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function compress(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return base64FromBytes(new Uint8Array(buffer));
  }

  async function decompress(b64) {
    const stream = new Blob([bytesFromBase64(b64)])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }

  async function readBlob(scope) {
    try {
      const raw = await TS.localStorage[scope].getBlob();
      if (failed(raw) || !raw) return null;

      const parsed = JSON.parse(raw);
      if (parsed && parsed.format === ENVELOPE) return JSON.parse(await decompress(parsed.data));
      return parsed;
    } catch (e) {
      // Unreadable is not the same as empty. A blob we failed to parse still
      // holds someone's characters, so mark the scope and refuse to write over
      // it rather than silently replacing a library with a blank one.
      console.warn(`[Spirekeeper] could not read ${scope} storage`, e);
      unreadable.add(scope);
      return null;
    }
  }

  async function writeBlob(scope, value) {
    if (unreadable.has(scope)) {
      throw new Error(
        `Refusing to overwrite ${scope} storage: its existing contents could not be read. ` +
          "Reload the panel; if this persists, the stored data was written by a newer version."
      );
    }

    const json = JSON.stringify(value);

    let raw = json;
    if (canCompress()) {
      try {
        raw = JSON.stringify({ format: ENVELOPE, data: await compress(json) });
      } catch (e) {
        console.warn("[Spirekeeper] compression failed, storing plain", e);
      }
    }

    // 5 MB cap, measured on the UTF-16 string TaleSpire receives.
    if (raw.length * 2 > BLOB_LIMIT) {
      const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
      throw new Error(
        `Sheet library is too large for TaleSpire storage: ${mb(raw.length * 2)} of a 5 MB limit` +
          (raw === json ? " (this browser could not compress it)" : "") +
          ". Delete a character you are not using."
      );
    }

    const res = await TS.localStorage[scope].setBlob(raw);
    if (failed(res)) throw new Error(`Could not save to ${scope} storage: ${res.cause}`);
  }

  /** Storage cost of the library as it stands, for the library screen. */
  async function usage() {
    const json = JSON.stringify(library);
    let stored = json.length;
    if (canCompress()) {
      try {
        stored = JSON.stringify({ format: ENVELOPE, data: await compress(json) }).length;
      } catch {
        /* fall back to the uncompressed figure */
      }
    }
    return { bytes: stored * 2, limit: BLOB_LIMIT, compressed: stored < json.length };
  }

  async function load() {
    library = (await readBlob("global")) || structuredClone(EMPTY_LIBRARY);
    bindings = (await readBlob("campaign")) || structuredClone(EMPTY_BINDINGS);
    if (!library.sheets) library.sheets = {};
    if (!bindings.bindings) bindings.bindings = {};
    if (!bindings.encounters) bindings.encounters = {};
  }

  // --- sheet library -------------------------------------------------------

  const listSheets = () => Object.values(library.sheets);
  const getSheet = (id) => library.sheets[id] || null;

  /**
   * Sheets are keyed by source and source id so re-importing the same character
   * updates in place instead of piling up duplicates.
   */
  function sheetId(sheet) {
    return `${sheet.meta.source}:${sheet.meta.sourceId}`;
  }

  /**
   * Swap in a freshly derived sheet for one already in the library, keeping its
   * id and import timestamp. Used when equipment changes force a re-derivation.
   */
  async function replaceSheet(id, sheet) {
    if (!library.sheets[id]) return;
    library.sheets[id] = sheet;
    await writeBlob("global", library);
  }

  async function saveSheet(sheet) {
    const id = sheetId(sheet);
    sheet.meta.sheetId = id;
    sheet.meta.fetchedAt = new Date().toISOString();
    library.sheets[id] = sheet;
    await writeBlob("global", library);
    return id;
  }

  /**
   * Write the library back without touching import metadata.
   *
   * Play state (current HP, spent slots, used resources) lives on the sheet but
   * changes constantly during a session, so it saves through here rather than
   * through saveSheet, which would restamp the sheet as freshly imported.
   */
  async function persist() {
    await writeBlob("global", library);
  }

  /**
   * Seed the mutable half of a sheet. Everything above this line is a snapshot
   * of what D&D Beyond said at import time; everything in `play` is what has
   * happened at the table since.
   */
  function ensurePlay(sheet) {
    if (sheet.play) return sheet.play;

    const slotsUsed = {};
    for (const slot of sheet.spellcasting.slots) slotsUsed[slot.level] = slot.used || 0;

    const resourcesUsed = {};
    for (const r of sheet.resources) resourcesUsed[r.name] = r.used || 0;

    const hitDiceUsed = {};
    for (const hd of sheet.hp.hitDice) hitDiceUsed[hd.die] = hd.used || 0;

    // Spells that arrive with their own uses — Magic Initiate's one free cast per
    // long rest — are tracked by name, the way resources are.
    const spellUsesUsed = {};
    for (const block of sheet.spellcasting.blocks) {
      for (const sp of block.spells) {
        if (sp.limitedUse) spellUsesUsed[sp.name] = sp.limitedUse.used || 0;
      }
    }

    sheet.play = {
      hp: { current: sheet.hp.current, temp: sheet.hp.temp || 0 },
      slotsUsed,
      pactUsed: sheet.spellcasting.pact?.used || 0,
      resourcesUsed,
      hitDiceUsed,
      spellUsesUsed,
      effects: [], // buffs from other players' spells; see app.js
      // Equip/attune choices made at the table, keyed by inventory item id.
      // D&D Beyond only knows what was true at export; taking a ring off mid-fight
      // has to change armour class here without a re-import.
      equipment: {},
      // Written at the table and never sent anywhere; see app.js.
      notes: [],
      // Seeded from the import, then owned by the table: D&D Beyond only knows
      // what was true when you exported.
      conditions: (sheet.conditions || []).map((c) => ({ name: c.name, level: c.level || null })),
    };
    return sheet.play;
  }

  async function deleteSheet(id) {
    delete library.sheets[id];
    for (const [creatureId, boundId] of Object.entries(bindings.bindings)) {
      if (boundId === id) delete bindings.bindings[creatureId];
    }
    await writeBlob("global", library);
    await writeBlob("campaign", bindings);
  }

  // --- mini bindings -------------------------------------------------------

  const boundSheetId = (creatureId) => bindings.bindings[creatureId] || null;

  const boundCreatureIds = (id) =>
    Object.entries(bindings.bindings).filter(([, v]) => v === id).map(([k]) => k);

  // --- encounters ----------------------------------------------------------
  //
  // Campaign-scoped, because an encounter is a thing you prepared for *this*
  // table. A GM building next week's session wants both fights sitting ready,
  // so they are saved by name rather than being a single scratch list.

  const listEncounters = () =>
    Object.values(bindings.encounters).sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const getEncounter = (id) => bindings.encounters[id] || null;

  async function saveEncounter(encounter) {
    if (!encounter.id) encounter.id = `enc-${Math.random().toString(36).slice(2, 9)}`;
    bindings.encounters[encounter.id] = encounter;
    await writeBlob("campaign", bindings);
    return encounter.id;
  }

  async function deleteEncounter(id) {
    delete bindings.encounters[id];
    await writeBlob("campaign", bindings);
  }

  async function bind(creatureId, id) {
    bindings.bindings[creatureId] = id;
    await writeBlob("campaign", bindings);
  }

  async function unbind(creatureId) {
    delete bindings.bindings[creatureId];
    await writeBlob("campaign", bindings);
  }

  return {
    load,
    persist,
    ensurePlay,
    listSheets,
    getSheet,
    sheetId,
    saveSheet,
    replaceSheet,
    usage,
    listEncounters,
    getEncounter,
    saveEncounter,
    deleteEncounter,
    deleteSheet,
    boundSheetId,
    boundCreatureIds,
    bind,
    unbind,
  };
})();

if (typeof window !== "undefined") window.Store = Store;
