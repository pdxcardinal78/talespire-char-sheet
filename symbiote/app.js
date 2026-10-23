/**
 * Spirekeeper — UI and TaleSpire glue.
 *
 * Lifecycle note: TaleSpire injects the API and then fires `hasInitialized` via
 * the subscription named in the manifest. Nothing may touch `TS.*` before that.
 * The functions the manifest names (onStateChangeEvent, onCreatureSelectionChange,
 * onRollResults, onPickingEvent) must be globals, and each receives an event
 * shaped `{ kind, payload }`.
 */

const App = (() => {
  const $ = (id) => document.getElementById(id);
  const failed = (r) => r && r.cause !== undefined;

  const state = {
    ready: false,
    sheet: null,
    sheetId: null,
    mode: "normal",
    creatureId: null, // mini this sheet is linked to
    target: null, // { id, name, ac }
    isGM: false,
    // Feature-granted spells, resolved from the bundled SRD once per sheet.
    granted: null,
    me: null, // { id, name } — how we tell whether a broadcast is for us
    selection: [],
    pending: [], // attacks awaiting a DM hit call, holding their damage
    // Spent slots and spell changes for statblocks opened out of the search,
    // which belong to no encounter and are forgotten when the panel closes.
    monsterScratch: {},
  };

  /** Play state changes constantly; don't hammer TaleSpire's storage. */
  let saveTimer;
  function savePlay() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => Store.persist().catch((e) => console.error("[Spirekeeper] persist", e)), 400);
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async function boot() {
    state.ready = true;
    try {
      await Store.load();
      renderVersion();
      await detectGM();
      Bridge.probe(); // not awaited: an absent plugin must not slow startup
      // Board writes report what they replaced, so they can be undone
      Bridge.onWrite({
        before: async (id) => {
          const i = await Board.oneCreature(id);
          return i ? { name: i.name, hp: i.hp, stats: i.stats } : null;
        },
        after: onBoardWrite,
      });

      Party.configure({
        onGrant: onEffectGranted,
        onTempGrant,
        onSaveSession,
        onInitiative: ({ creatureId, value, dex }) => placeInInitiative([{ id: creatureId, value, dex }]),
        onSaveAck,
        onSaveQuery,
        onSaveResult,
        onRevoke: onEffectRevoked,
        onAck: onEffectAck,
        onVitals: onVitalsFromPlayer,
        onTemp: onTempFromGm,
        onHit: onHitFromGm,
        onStatusMapping: ({ emoteId, condition }) => {
          Statuses.setMapping(emoteId, condition, false).then(() => followLinkedMini());
        },
        onStatusRequest: () => {
          if (state.isGM) Statuses.shareAll();
        },
        onCondition: onConditionFromPlayer,
        onZoneQuery,
        onZoneReply,
        onZoneKeep,
        onZoneKept,
        onZoneRemove,
      });
      Zones.configure({ toast, onResult: showZone });
      Zones.useCreatures(zoneCreatures);
      Statuses.configure({
        changed: () => {
          if (state.isGM) {
            GM.refresh();
            refreshBoardHp();
            renderStatusMap();
          }
          followLinkedMini();
        },
      });
      // A player's panel gets the GM's status pairings when it opens
      if (!state.isGM) Party.requestStatusMappings().catch(() => {});
      renderLibrary();

      // Reopen whatever was open last, if it still exists.
      refreshInitiative();

      // The "sheetbridge" keys predate the rename and are kept on purpose —
      // changing them would orphan every imported character and saved encounter.
      const last = localStorage.getItem("sheetbridge:last");
      if (last && Store.getSheet(last)) openSheet(last);
      else showImport();
    } catch (e) {
      toast(`Startup failed: ${e.message}`, true);
      console.error("[Spirekeeper] boot", e);
    }
  }

  /**
   * Is this client allowed to GM?
   *
   * Everything on the GM side hangs off this, and when it silently answered "no"
   * there was no way to tell a player's client from a failed lookup — the GM
   * buttons simply weren't there. So every branch now says what happened, out
   * loud in the console and once in a toast if the call actually failed.
   */
  async function detectGM() {
    const conclude = (isGm, why) => {
      state.isGM = isGm;
      renderGmEntry();
      console.log(`[Spirekeeper] GM tools ${isGm ? "enabled" : "hidden"} — ${why}`);
    };

    try {
      const me = await TS.players.whoAmI();
      if (failed(me)) {
        toast(`Could not identify you: ${me.cause}. GM tools are hidden.`, true);
        return conclude(false, `whoAmI failed: ${me.cause}`);
      }

      state.me = { id: me.id, name: me.name };

      const info = await TS.players.getMoreInfo([me]);
      if (failed(info)) {
        toast(`Could not read your permissions: ${info.cause}. GM tools are hidden.`, true);
        return conclude(false, `getMoreInfo failed: ${info.cause}`);
      }

      const rights = info?.[0]?.rights;
      if (!rights) return conclude(false, "no rights came back for this player");
      conclude(Boolean(rights.canGm), `canGm=${rights.canGm} for ${me.name}`);
    } catch (e) {
      toast(`Could not check GM rights: ${e.message}`, true);
      conclude(false, `threw: ${e.message}`);
    }
  }

  /**
   * Shown in the panel because "am I actually running the build I just
   * installed?" is otherwise unanswerable — the webview caches.
   *
   * Stated here rather than read from the manifest: a Symbiote installed locally
   * runs from a file origin and cannot fetch its own files. `dev/preflight.mjs`
   * fails if this drifts from the manifest, which is the part that would rot.
   */
  const APP_VERSION = "0.22.0";

  function renderVersion() {
    console.log(`[Spirekeeper] v${APP_VERSION}`);
    const el = $("app-version");
    if (el) el.textContent = `v${APP_VERSION}`;
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  const DDB_ID = /(?:characters?\/)(\d+)/;

  function resolveLink() {
    const raw = $("ddb-link").value.trim();
    const match = raw.match(DDB_ID) || raw.match(/^(\d+)$/);
    if (!match) {
      setStatus("import-status", "That doesn't look like a D&D Beyond character link.", true);
      return;
    }
    const url = `https://character-service.dndbeyond.com/character/v5/character/${match[1]}`;
    $("json-url").textContent = url;
    $("copy-url").disabled = false;
    $("step-fetch").classList.remove("dimmed");
    setStatus("import-status", "");
  }

  async function copyUrl() {
    const url = $("json-url").textContent;
    if (!url || url === "—") return;
    // TS.system.clipboard reaches the real system clipboard; navigator.clipboard
    // is the fallback when developing in a plain browser.
    try {
      if (window.TS?.system?.clipboard) await TS.system.clipboard.setText(url);
      else await navigator.clipboard.writeText(url);
      toast("URL copied. Open it in your browser and copy the JSON back here.");
    } catch (e) {
      toast(`Could not copy: ${e.message}`, true);
    }
  }

  async function importJson(text) {
    const raw = (text ?? $("json-input").value).trim();
    if (!raw) {
      setStatus("import-status", "Paste the character JSON first.", true);
      return;
    }

    let sheet;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.success === false) throw new Error(parsed.message || "D&D Beyond returned an error");
      sheet = DDB.normalize(parsed);
      if (!sheet.identity?.name) throw new Error("No character name found — is this a character payload?");
      // Armour class and ability scores depend on what's worn, so equipping a ring
      // has to re-derive from source rather than patch the finished sheet. Kept in
      // compact form; the raw export is roughly a megabyte of builder bookkeeping.
      sheet.source = DDB.compactPayload(parsed);
    } catch (e) {
      setStatus("import-status", `Import failed: ${e.message}`, true);
      return;
    }

    try {
      const id = await Store.saveSheet(sheet);
      $("json-input").value = "";
      setStatus("import-status", "");
      renderLibrary();
      openSheet(id);
      toast(`Imported ${sheet.identity.name}.`);
    } catch (e) {
      setStatus("import-status", `Could not save: ${e.message}`, true);
    }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Encounters
  // -------------------------------------------------------------------------

  let initiativePoll = null;

  function showEncounters() {
    for (const id of ["import-view", "sheet-view", "party-view", "bestiary-view"]) {
      $(id).classList.add("hidden");
    }
    $("encounters-view").classList.remove("hidden");
    renderEncounters();
    refreshBoardHp();
    refreshInitiative();

    // `initiativeUpdated` fires when the turn moves or the queue is edited — not
    // reliably when initiative first starts. Polling while this view is open
    // means the order appears whether or not an event came.
    clearInterval(initiativePoll);
    initiativePoll = setInterval(refreshInitiative, 3000);
  }

  function closeEncounters() {
    clearInterval(initiativePoll);
    initiativePoll = null;
    $("encounters-view").classList.add("hidden");
    if (state.sheet) $("sheet-view").classList.remove("hidden");
    else $("import-view").classList.remove("hidden");
  }

  function renderEncounters() {
    Encounters.renderList(Store.listEncounters());
    Encounters.render();
    const open = Encounters.current;
    $("encounters-meta").textContent = open
      ? `${open.name} · ${open.combatants.length} combatants`
      : `${Store.listEncounters().length} saved`;
    refreshEncounterPicker();
  }

  async function saveCurrentEncounter() {
    const enc = Encounters.current;
    if (!enc) return;
    try {
      await Store.saveEncounter(enc);
    } catch (e) {
      toast(e.message, true);
    }
    renderEncounters();
  }

  async function createEncounter() {
    const name = $("encounter-name").value.trim();
    if (!name) return toast("Give the encounter a name first.", true);
    const encounter = { id: null, name, combatants: [] };
    const id = await Store.saveEncounter(encounter);
    $("encounter-name").value = "";
    openEncounter(id);
  }

  function openEncounter(id) {
    const enc = Store.getEncounter(id);
    if (!enc) return;
    if (!enc.combatants) enc.combatants = [];
    Encounters.setCurrent(enc);
    renderEncounters();
    refreshBoardHp();
  }

  async function refreshBoardHp() {
    const backfilled = await Encounters.readBoard();
    if (backfilled) await saveCurrentEncounter();
    else Encounters.render();
  }

  /** The encounter a monster gets added to, chosen on the Monsters view. */
  function refreshEncounterPicker() {
    const pick = $("bestiary-encounter");
    const chosen = pick.value;
    pick.replaceChildren();
    for (const enc of Store.listEncounters()) {
      const opt = document.createElement("option");
      opt.value = enc.id;
      opt.textContent = enc.name;
      pick.appendChild(opt);
    }
    if ([...pick.options].some((o) => o.value === chosen)) pick.value = chosen;
    $("bestiary-add").classList.toggle("hidden", !pick.options.length || !Bestiary.current);
  }

  async function addCurrentMonsterToEncounter() {
    const monster = Bestiary.current;
    const enc = Store.getEncounter($("bestiary-encounter").value);
    if (!monster || !enc) return;
    if (!enc.combatants) enc.combatants = [];

    const count = Math.max(1, Math.min(20, Number($("bestiary-count").value) || 1));
    // Bundled monsters are re-read from the shipped file by slug; an Open5e one
    // has to carry its statblock or it would be missing next session.
    const bundled = await Monsters.get(monster.slug);
    Encounters.addMonster(enc, { ...monster, bundled: Boolean(bundled) }, count);

    await Store.saveEncounter(enc);
    if (Encounters.current?.id === enc.id) Encounters.setCurrent(enc);
    toast(`${count} × ${monster.name} added to ${enc.name}.`);
    renderEncounters();
  }

  /**
   * Damage rolled by someone else on the board.
   *
   * TaleSpire reports every roll to every Symbiote, so the GM's panel sees the
   * party's damage dice as they land. Which group is the damage is a guess worth
   * making carefully: a roll staged by this mod names it "<something> damage",
   * and anything else is taken whole. Nothing is ever applied automatically — a
   * roll is not a hit, and only the GM knows whether it landed.
   */
  async function offerForeignRoll(payload) {
    if (!state.isGM) return;

    const groups = payload.resultsGroups || [];
    if (!groups.length) return;

    // Spirekeeper names typed groups "Rapier damage [piercing]", "Divine Smite [radiant]"
    const named = groups.filter((g) => /damage/i.test(g.name || "") || Damage.typeFromGroupName(g.name));
    const use = named.length ? named : groups;

    let amount = 0;
    const parts = [];
    for (const g of use) {
      const value = await TS.dice.evaluateDiceResultsGroup(g);
      if (failed(value)) continue;
      amount += value;
      parts.push({ name: g.name, type: Damage.typeFromGroupName(g.name), amount: value });
    }
    if (!amount) return;

    offerDamageToFight({
      rollId: payload.rollId,
      parts,
      amount,
      label: use[0]?.name || null,
      who: await rollerName(payload.clientId),
    });
  }

  /**
   * Park a damage roll on the fight for the GM to aim.
   *
   * Every route into the inbox comes through here, because the two gates below
   * used to be silent. A GM rolling for a player saw nothing at all — their own
   * dice are claimed by the roll tracker and never reach onForeignRoll — and a
   * GM standing on any view but Fights saw nothing either, because the inbox
   * only draws inside the encounter pane. Both now say so out loud.
   */
  function offerDamageToFight(entry) {
    if (!state.isGM) return;

    if (!Encounters.current) {
      // Once per roll, not once per die: a silent drop reads as a broken feature.
      toast(`${entry.amount} damage rolled — open a fight to apply it.`);
      return;
    }

    Encounters.offerDamage(entry);

    // The inbox lives inside the Fights view. If the GM is looking at anything
    // else, the badge and this line are the only things that will reach them.
    if ($("encounters-view").classList.contains("hidden")) {
      toast(`${entry.who} rolled ${entry.amount} damage — open Fights to apply it.`);
    }
  }

  /** Count of damage rolls waiting, shown on the Fights button. */
  function renderFightBadge(count) {
    const btn = $("open-encounters");
    if (!btn) return;
    btn.textContent = count ? `Fights (${count})` : "Fights";
    btn.classList.toggle("has-waiting", Boolean(count));
  }

  /** Whose dice those were, for the offer line. */
  async function rollerName(clientId) {
    if (!clientId) return "Someone";
    try {
      const infos = await TS.clients.getMoreInfo([clientId]);
      if (failed(infos)) return "Someone";
      return infos?.[0]?.player?.name || infos?.[0]?.name || "Someone";
    } catch {
      return "Someone";
    }
  }

  /**
   * Bind a turn to a combatant by hand.
   *
   * Automatic matching guesses from ids and names, and a GM is entitled to run
   * any statblock on any model — so when the guess is wrong, this is the answer
   * that always works. The binding is stored on the combatant and beats every
   * other rule.
   */
  async function assignTurn(entry, combatantId) {
    const enc = Encounters.current;
    if (!enc) return;

    // A turn can only belong to one combatant, so clear any previous holder.
    for (const c of enc.combatants) {
      if (c.turnId === entry.id) c.turnId = null;
    }

    const combatant = enc.combatants.find((c) => c.id === combatantId);
    if (combatant) combatant.turnId = entry.id;

    await saveCurrentEncounter();
    toast(combatant ? `${entry.name}'s turn is ${combatant.label}.` : `${entry.name} unassigned.`);
  }

  /** Take an offered roll and spend it on the selected combatant. */
  async function applyOfferedDamage(combatant, entry, modes = {}) {
    if (!combatant) return;
    const onBoard = Encounters.hpFor(combatant).source === "board";
    if (onBoard && !writesBoard(combatant)) {
      return toast("This mini's hit points live on the board — change them there.", true);
    }
    const def = await defensesForCombatant(combatant);
    const { total, rows } = Damage.apply(entry.parts?.length ? entry.parts : [{ type: null, amount: entry.amount }], def, modes);
    const changed = rows.filter((r) => r.mode !== "normal").map((r) => `${r.type} ${r.mode === "resist" ? "halved" : r.mode === "vuln" ? "doubled" : "immune"}`);
    if (!(await undoable(`${total} damage to ${combatant.label}`, () => setCombatantHp(combatant, `-${total}`)))) return;
    Encounters.dismissDamage(entry.rollId);
    toast(`${total} damage to ${combatant.label}${changed.length ? ` (${changed.join(", ")})` : ""}.`);
  }

  const combatantDefenses = new Map(); // combatant id -> defenses, for the Fights inbox

  /** A combatant's damage defenses: its stat block's, or a player's reported sheet. */
  async function defensesForCombatant(combatant) {
    if (combatant?.slug || combatant?.cached) {
      try {
        const m = combatant.cached || (await Monsters.get(combatant.slug));
        if (m?.defenses) return Damage.defensesOf(m.defenses);
      } catch {
        /* no stat block: no defaults */
      }
    }
    return (combatant?.creatureId && Vitals.reportedFor(combatant.creatureId)?.defenses) || null;
  }

  /** Can this combatant's HP go straight onto its mini? Needs the bridge and a link. */
  const writesBoard = (combatant) => Boolean(combatant?.creatureId) && Bridge.canWrite();

  /**
   * Read what was typed into an HP box: `12` sets, `-5` and `+3` change.
   * Returns { next } or { error }. Never below zero; a GM may go above max.
   */
  function parseHpInput(raw, before) {
    const text = String(raw ?? "").trim();
    if (!text) return { empty: true };
    const relative = /^[+-]/.test(text);
    const value = Number(text);
    if (!Number.isFinite(value)) return { error: `“${text}” isn't a number. Try 12, -5 or +3.` };
    return { next: Math.max(0, Math.round(relative ? (before ?? 0) + value : value)) };
  }

  /** Is this text damage (`-5`)? Damage takes temp HP before HP. */
  const damageAmount = (raw) => {
    const m = /^\s*-\s*(\d+)\s*$/.exec(String(raw ?? ""));
    return m ? parseInt(m[1], 10) : null;
  };

  /** The party row as Vitals.write expects it. */
  const rowVitals = (row) => ({
    id: row.id, hp: row.hp, max: row.hpMax,
    temp: row.temp, tempIndex: row.tempIndex, tempMax: row.tempMax,
  });

  /**
   * Write HP and temp to a mini through the bridge as GM, and tell the
   * player's panel the new temp pool when the campaign has no Temp HP stat.
   */
  async function writeVitals(v, next, label) {
    const r = await Vitals.write(v, next);
    if (!r.ok) {
      toast(`Couldn't update ${label} on the board (${r.error}).`, true);
      return false;
    }
    if (r.syncTemp != null) {
      Vitals.report(v.id, { hp: next.hp ?? v.hp, max: next.max ?? v.max, temp: r.syncTemp });
      await Party.setTemp(v.id, r.syncTemp).catch(() => {});
    }
    return true;
  }

  /** A GM editing a party mini's HP from the party view, through the bridge. */
  async function setPartyHp(row, raw) {
    const dmg = damageAmount(raw);
    if (dmg != null && row.temp > 0) {
      const next = Vitals.takeDamage({ hp: row.hp, temp: row.temp }, dmg);
      if (!(await writeVitals(rowVitals(row), { hp: next.hp, temp: next.temp }, row.name))) return GM.render();
      return;
    }
    const parsed = parseHpInput(raw, row.hp);
    if (parsed.empty) return GM.render();
    if (parsed.error) {
      GM.render();
      return toast(parsed.error, true);
    }
    const r = await Bridge.setHp(row.id, parsed.next, row.hpMax);
    if (!r.ok) {
      GM.render();
      return toast(`Couldn't set ${row.name}'s HP on the board (${r.error}).`, true);
    }
    // TaleSpire's change event refreshes the row with the board's own value
  }

  /** Set a party mini's temp pool exactly (the GM's call, so no "larger wins" rule). */
  async function setPartyTemp(row, raw) {
    const n = Number(String(raw ?? "").trim() || "0");
    if (!Number.isFinite(n) || n < 0) {
      GM.render();
      return toast("Temp HP must be 0 or more.", true);
    }
    await writeVitals(rowVitals(row), { temp: Math.round(n) }, row.name);
    // Re-read: a temp pool without a stat changes nothing on the board, so no
    // change event will come round to refresh the row
    GM.refresh();
  }

  /**
   * Set a combatant's hit points from what was typed on its own row.
   *
   * `12` sets them, `-5` and `+3` change them. The relative form is the one that
   * matters in play: a player calls out their damage and the GM types it, with
   * no arithmetic and nothing to aim at but the row in front of them.
   */
  async function setCombatantHp(combatant, raw) {
    const hp = Encounters.hpFor(combatant);
    const toBoard = writesBoard(combatant);

    if (hp.source === "board" && !toBoard) {
      Encounters.render();
      toast("This mini's hit points live on the board — change them there.", true);
      return false;
    }

    // A monster can be brought back above its statblock maximum by a GM who
    // wants that; it just cannot go below zero.
    const parsed = parseHpInput(raw, hp.value ?? combatant.hp ?? combatant.maxHp ?? 0);
    if (parsed.empty) {
      Encounters.render();
      return false;
    }
    if (parsed.error) {
      Encounters.render();
      toast(parsed.error, true);
      return false;
    }
    let next = parsed.next;
    // Damage (-5) comes off temp HP first; setting a value (12) or healing (+3)
    // never touches it
    let nextTemp = hp.temp || 0;
    const dmg = damageAmount(raw);
    if (dmg != null) {
      const after = Vitals.takeDamage({ hp: hp.value ?? combatant.hp ?? combatant.maxHp ?? 0, temp: hp.temp }, dmg);
      next = after.hp;
      nextTemp = after.temp;
    }

    if (toBoard) {
      // The mini may have no hit points yet; give it the statblock's maximum
      // so the board gets a proper bar, after which the board owns the count
      const max = hp.max || combatant.maxHp || null;
      const v = {
        id: combatant.creatureId, hp: hp.value, max: hp.max,
        temp: hp.temp, tempIndex: hp.tempIndex, tempMax: hp.tempMax,
      };
      const r = await Vitals.write(v, { hp: next, max, temp: nextTemp });
      if (r.ok) {
        combatant.hp = next; // kept in step, for when the bridge isn't there
        if (hp.tempIndex == null) combatant.temp = nextTemp;
        Encounters.noteBoardHp(combatant.creatureId, next, max ?? next, hp.tempIndex != null ? nextTemp : null);
        await saveCurrentEncounter();
        return true;
      }
      toast(`Couldn't set ${combatant.label}'s HP on the board (${r.error}).`, true);
      if (hp.source === "board") {
        Encounters.render();
        return false;
      }
      // Fall through: the panel keeps the count as it did before the bridge
    }

    combatant.hp = next;
    combatant.temp = nextTemp;
    await saveCurrentEncounter();
    return true;
  }

  /** Set a combatant's temp pool exactly: on its mini's Temp HP stat if there is one. */
  async function setCombatantTemp(combatant, raw) {
    const n = Number(String(raw ?? "").trim() || "0");
    if (!Number.isFinite(n) || n < 0) {
      Encounters.render();
      return toast("Temp HP must be 0 or more.", true);
    }
    const temp = Math.round(n);
    const hp = Encounters.hpFor(combatant);
    if (hp.tempIndex != null && writesBoard(combatant)) {
      const r = await Bridge.setStat(combatant.creatureId, hp.tempIndex, temp, Vitals.tempStatMax(hp.temp, hp.tempMax, temp));
      if (!r.ok) {
        Encounters.render();
        return toast(`Couldn't set ${combatant.label}'s temp HP on the board (${r.error}).`, true);
      }
      Encounters.noteBoardHp(combatant.creatureId, hp.value, hp.max, temp);
      return;
    }
    combatant.temp = temp;
    await saveCurrentEncounter();
  }

  async function linkCombatant(combatant) {
    if (combatant.creatureId) {
      combatant.creatureId = null;
      combatant.creatureName = null;
      await saveCurrentEncounter();
      return toast(`${combatant.label} unlinked.`);
    }
    state.linkingCombatant = combatant;
    await pickTarget();
  }

  async function removeCombatant(combatant) {
    Encounters.removeCombatant(Encounters.current, combatant.id);
    await saveCurrentEncounter();
  }

  /** Open a combatant's statblock, from the encounter or the turn order. */
  async function openCombatantStatblock(combatant) {
    const monster = combatant.cached || (await Monsters.get(combatant.slug));
    if (!monster) return toast("That statblock is no longer available.", true);
    await Bestiary.show(monster, combatantSpellContext(combatant));
    showBestiary();
  }

  /**
   * Where a combatant's spellcasting is kept.
   *
   * Two different things are being remembered and they belong in two different
   * places. What's *spent* is the individual's: three mages in a fight each have
   * their own slots, and killing one shouldn't refund the others. What's been
   * *changed* is the encounter's: a GM reskinning a fire cultist's fireball as
   * cold means every cultist in that fight, not one of them.
   */
  function combatantSpellContext(combatant) {
    const enc = Encounters.current;
    if (!enc) return scratchSpellContext(combatant.cached || { slug: combatant.slug, name: combatant.label });

    const tweaks = (enc.spellTweaks ||= {});
    return {
      label: combatant.label,
      persists: true,
      state: {
        uses: (combatant.spellUses ||= {}),
        overrides: (tweaks[combatant.slug] ||= {}),
      },
      onChange: () => saveCurrentEncounter(),
    };
  }

  /**
   * A statblock opened out of the search belongs to no fight, so its slots and
   * changes live for as long as the panel is open and no longer. Said out loud
   * in the panel rather than left to be discovered.
   */
  function scratchSpellContext(monster) {
    const scratch = (state.monsterScratch ||= {});
    const slug = monster.slug || monster.name;
    return {
      label: monster.name,
      persists: false,
      state: (scratch[slug] ||= { uses: {}, overrides: {} }),
      onChange: null,
    };
  }

  /**
   * Monsters. A GM-only view, because the whole point is running the other side
   * of the fight.
   */
  function showBestiary() {
    $("import-view").classList.add("hidden");
    $("sheet-view").classList.add("hidden");
    $("party-view").classList.add("hidden");
    $("bestiary-view").classList.remove("hidden");
    if (!$("bestiary-results").childElementCount) Bestiary.runSearch("");
  }

  function closeBestiary() {
    $("bestiary-view").classList.add("hidden");
    if (state.sheet) $("sheet-view").classList.remove("hidden");
    else $("import-view").classList.remove("hidden");
  }

  /**
   * Whose voice a monster roll goes out in.
   *
   * `chat.sendAsCreature` is GM-only and makes the line come from the mini
   * rather than from you, which is the difference between "Goblin hits for 5"
   * and a GM narrating their own dice. Kept separate from the attack target so
   * the two never get confused.
   */
  function renderSpeaker() {
    $("bestiary-speaker").textContent = state.speaker
      ? `Rolls post as ${state.speaker.name}`
      : "Rolls post from you";
  }

  async function pickSpeaker() {
    if (state.speaker) {
      state.speaker = null;
      renderSpeaker();
      return;
    }
    state.pickingSpeaker = true;
    await pickTarget();
  }

  /** Monster rolls take the same path as the character sheet's. */
  async function monsterRoll(spec, ev) {
    if (!state.ready) return toast("TaleSpire isn't ready yet.", true);
    try {
      await Rolls.stage({
        name: spec.name,
        roll: spec.roll,
        damage: spec.damage,
        damageName: spec.damageName,
        damageType: spec.damageType || null,
        mode: modeFromEvent(ev),
        // monster + damageExpr let a GM's attack against a target with a known
        // AC resolve itself; see resolveMonsterAttack
        context: {
          kind: spec.kind, creatureId: state.speaker?.id || null, target: state.target,
          monster: true, damageExpr: spec.damage || null, damageType: spec.damageType || null, source: spec.name,
        },
      });
      renderStaged();
    } catch (e) {
      toast(e.message, true);
    }
  }

  /** A monster saying what it just did, in its own voice where there is one. */
  async function monsterAnnounce(text) {
    try {
      await postChat(Rolls.bold(text), state.speaker?.id || null);
    } catch (e) {
      toast(e.message, true);
    }
  }

  /**
   * The GM view. Opened from the header, and only offered to a GM — a player's
   * client would render a list of names with every stat hidden, which is worse
   * than not offering it.
   */
  function showParty() {
    $("import-view").classList.add("hidden");
    $("sheet-view").classList.add("hidden");
    $("party-view").classList.remove("hidden");
    GM.refresh();
  }

  function closeParty() {
    $("party-view").classList.add("hidden");
    if (state.sheet) $("sheet-view").classList.remove("hidden");
    else $("import-view").classList.remove("hidden");
  }

  /** The Party button only makes sense once we know this client can GM. */
  function renderGmEntry() {
    $("open-party").classList.toggle("hidden", !state.isGM);
    $("open-bestiary").classList.toggle("hidden", !state.isGM);
    $("open-encounters").classList.toggle("hidden", !state.isGM);
    $("gm-menu-btn").classList.toggle("hidden", !state.isGM);
    if (!state.isGM) toggleGmMenu(false);
  }

  function toggleGmMenu(open) {
    const menu = $("gm-menu");
    const show = open ?? menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !show);
    $("gm-menu-btn").setAttribute("aria-expanded", show ? "true" : "false");
  }

  function showImport() {
    $("import-view").classList.remove("hidden");
    $("sheet-view").classList.add("hidden");
    renderLibrary();
  }

  /**
   * Recompute a stored sheet from the payload it was imported from.
   *
   * Sheets cache their computed values, so a normalizer fix only reached a
   * character if the player re-imported them — which is how a level-3 cleric
   * kept a feature list with no subclass in it. Play state is carried across
   * untouched; only the derived numbers change.
   */
  function rederive(sheet) {
    const fresh = DDB.normalize(sheet.source, { equipment: sheet.play?.equipment || {} });
    fresh.meta = { ...sheet.meta, importerVersion: DDB.NORMALIZER_VERSION };
    fresh.source = sheet.source;
    fresh.play = sheet.play;
    return fresh;
  }

  function openSheet(id) {
    let sheet = Store.getSheet(id);
    if (!sheet) return showImport();

    Store.ensurePlay(sheet);
    reconcileEffects(sheet.play);

    if (sheet.source && sheet.meta?.importerVersion !== DDB.NORMALIZER_VERSION) {
      try {
        sheet = rederive(sheet);
        Store.replaceSheet(id, sheet);
        console.log(`[Spirekeeper] re-derived ${sheet.identity?.name} for normalizer ${DDB.NORMALIZER_VERSION}`);
      } catch (e) {
        // A stale sheet that still renders beats no sheet at all.
        console.error("[Spirekeeper] could not re-derive sheet", e);
      }
    }

    state.sheet = sheet;
    state.granted = null;
    state.sheetId = id;
    state.pending = [];
    state.creatureId = Store.boundCreatureIds(id)[0] || null;
    lastBoardVitals = null;
    localStorage.setItem("sheetbridge:last", id);

    $("import-view").classList.add("hidden");
    $("sheet-view").classList.remove("hidden");
    render();
  }

  function renderLibrary() {
    const sheets = Store.listSheets();
    const list = $("library-list");
    list.replaceChildren();
    $("library").classList.toggle("hidden", sheets.length === 0);

    for (const sheet of sheets) {
      const id = sheet.meta.sheetId || Store.sheetId(sheet);
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.className = "name";
      name.innerHTML = `${escapeHtml(sheet.identity.name)} <span class="sub">${escapeHtml(describeClasses(sheet))}</span>`;
      name.onclick = () => openSheet(id);

      const del = document.createElement("button");
      del.className = "btn btn-small btn-ghost";
      del.textContent = "Remove";
      del.onclick = async () => {
        await Store.deleteSheet(id);
        if (state.sheetId === id) {
          state.sheet = null;
          state.sheetId = null;
          showImport();
        }
        renderLibrary();
      };

      li.append(name, del);
      list.appendChild(li);
    }

    renderUsage();
  }

  /**
   * How much of TaleSpire's storage the library occupies.
   *
   * Worth showing because the cost is invisible otherwise: each sheet carries a
   * copy of its D&D Beyond payload so equipment changes can re-derive the
   * numbers, and a GM holding a whole party is the only one who will ever come
   * near the limit. Storage is per machine, so a player keeping one character is
   * never at risk.
   */
  async function renderUsage() {
    const el = $("library-usage");
    if (!el) return;
    try {
      const { bytes, limit, compressed } = await Store.usage();
      const pct = Math.round((bytes / limit) * 100);
      const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
      el.textContent =
        `Using ${mb(bytes)} of ${mb(limit)} TaleSpire storage (${pct}%)` +
        (compressed ? ", compressed." : ".");
      el.classList.toggle("warn", pct >= 80);
    } catch {
      el.textContent = "";
    }
  }

  const describeClasses = (s) =>
    `${s.identity.species || ""} ${s.identity.classes.map((c) => `${c.name} ${c.level}`).join(" / ")}`.trim();

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /** Render a derivation as one line per contributing source, plus the total. */
  function breakdownText(rows, extra = []) {
    const all = [...(rows || []), ...extra];
    if (!all.length) return "";
    const total = all.reduce((t, r) => (r.override ? r.value : t + r.value), 0);
    const lines = all.map((r) => `${r.override ? "=" : DDB.signed(r.value)}  ${r.label}`);
    return [...lines, `${"-".repeat(3)}`, `${total} total`].join("\n");
  }

  function render() {
    const s = state.sheet;
    if (!s) return;

    $("char-name").textContent = s.identity.name;
    $("char-meta").textContent = describeClasses(s) + (s.identity.background ? ` · ${s.identity.background}` : "");

    const avatar = $("avatar");
    if (s.identity.avatarUrl) {
      avatar.src = s.identity.avatarUrl;
      avatar.classList.remove("hidden");
    } else {
      avatar.classList.add("hidden");
    }

    const acExtra = acBonus();
    $("v-ac").textContent = acExtra ? `${s.ac.value + acExtra}*` : s.ac.value;
    // Hovering shows the same itemisation D&D Beyond prints under Armor Class,
    // so a disagreement can be traced to the line that causes it.
    $("v-ac").title = breakdownText(
      s.ac.breakdown,
      acExtra ? [{ label: "Active effects", value: acExtra }] : []
    );
    $("v-init").textContent = DDB.signed(s.initiative);
    $("v-speed").textContent = s.speeds.walk ?? "—";
    $("v-pp").textContent = s.senses.passivePerception;
    $("v-prof").textContent = DDB.signed(s.proficiencyBonus);

    renderHp(s);
    renderHitDice(s);
    renderEffects();
    renderConcentration();
    renderConditions();
    renderBindBar();
    renderPending();
    renderStaged();
    renderAttacks(s);
    renderResources(s);
    renderSpells(s);
    renderGear(s);
    renderChecks(s);
    renderNotes();
    renderInfo(s);
  }

  // -------------------------------------------------------------------------
  // Active effects
  //
  // Buffs handed to you by other people — Bless, Bardic Inspiration, Shield of
  // Faith — exist nowhere in your imported sheet, because they come from someone
  // else's turn. They're tracked here and folded into rolls as they happen.
  // -------------------------------------------------------------------------

  // `conc` marks the spells that cost the caster their concentration. Granting one
  // drops whatever they were concentrating on before, and revokes what it gave.
  const EFFECT_PRESETS = [
    // `lasts` is a Turns.LASTS key: how long it runs once initiative is going
    { name: "Bless", bonus: "1d4", targets: ["attack", "save"], conc: true, lasts: "r10" },
    { name: "Bane", bonus: "-1d4", targets: ["attack", "save"], conc: true, lasts: "r10" },
    // Guidance runs its minute whether or not the die has been spent, and the
    // panel has no way to know which check the player is saving it for — so it
    // stays armed and the player ends it themselves (suspend, ×, or dropping
    // concentration). Marked `once`, it switched itself off after the first
    // check of the cast and silently stopped buffing the rest of the minute.
    { name: "Guidance", bonus: "1d4", targets: ["check"], conc: true, lasts: "r10" },
    { name: "Resistance", bonus: "1d4", targets: ["save"], once: true, conc: true, lasts: "r10" },
    { name: "Bardic Inspiration", bonus: "1d6", targets: ["attack", "save", "check"], once: true, lasts: "r100" },
    { name: "Shield of Faith", bonus: "+2", targets: ["ac"], conc: true, lasts: "r100" },
    { name: "Shield", bonus: "+5", targets: ["ac"], lasts: "start1" },
    { name: "Haste", bonus: "+2", targets: ["ac"], conc: true, lasts: "r10" },
    // Weapon effects replace part of an attack instead of adding to it, so they
    // carry an ability and/or damage die rather than just a bonus.
    {
      // Not a concentration spell in either edition — it runs its minute on its
      // own. It sat here marked `conc` for a while, which meant casting it
      // silently dropped whatever you were actually concentrating on.
      name: "Shillelagh",
      bonus: "+0",
      targets: ["weapon"],
      needsWeapon: true,
      useSpellAbility: true,
      die: "1d8",
      damageType: "Force",
      lasts: "r10",
    },
    { name: "Magic Weapon +1", bonus: "+1", targets: ["weapon"], needsWeapon: true, conc: true },
  ];

  /**
   * Re-derive the preset-owned facts on effects that were saved earlier.
   *
   * `addEffect` copies a preset's fields onto the stored effect, so a mistake in
   * the table above outlives the correction — Shillelagh was marked as costing
   * concentration, and a sheet that had it running kept holding the slot after
   * the flag was fixed; Guidance was marked `once`, and a sheet carrying one kept
   * spending it on the first check. Anything named after a preset takes the
   * preset's answer for both flags.
   */
  function reconcileEffects(play) {
    if (!play?.effects?.length) return;
    for (const fx of play.effects) {
      const preset = EFFECT_PRESETS.find((p) => p.name === fx.name);
      if (!preset) continue; // a custom effect is the player's own business
      fx.conc = Boolean(preset.conc);
      fx.once = Boolean(preset.once);
    }
    // A concentration record pointing at an effect that no longer costs it. A
    // spell cast without an effect (Moonbeam, Faerie Fire) has no effect id.
    if (play.concentration?.effectId && !play.effects.some((fx) => fx.id === play.concentration.effectId && fx.conc)) {
      play.concentration = null;
    }
  }

  /** "+2" and "-1" are flat; "1d4" and "-1d6" are dice. */
  const isDice = (bonus) => /d\d+/i.test(bonus || "");

  const signedBonus = (bonus) => {
    const b = String(bonus || "").trim();
    return /^[+-]/.test(b) ? b : `+${b}`;
  };

  const activeEffects = (targetKind) =>
    (state.sheet?.play?.effects || []).filter((e) => e.active && e.targets.includes(targetKind));

  /** Flat AC bonuses change a displayed number rather than a roll. */
  function acBonus() {
    return activeEffects("ac")
      .filter((e) => !isDice(e.bonus))
      .reduce((total, e) => total + (parseInt(signedBonus(e.bonus), 10) || 0), 0);
  }

  /**
   * Split the effects that apply to a roll into a flat modifier (appended to the
   * roll string) and dice (staged as their own groups, so advantage compares only
   * the d20s).
   */
  function effectsForRoll(kind) {
    const targetKind =
      kind === "attack" ? "attack" :
      kind === "save" ? "save" :
      kind === "check" ? "check" :
      kind === "damage" || kind === "healing" ? "damage" : null;

    if (!targetKind) return { flat: 0, dice: [], used: [] };

    const applicable = activeEffects(targetKind);
    let flat = 0;
    const dice = [];

    for (const e of applicable) {
      if (isDice(e.bonus)) dice.push({ name: e.name, roll: signedBonus(e.bonus).replace(/^\+/, "") });
      else flat += parseInt(signedBonus(e.bonus), 10) || 0;
    }
    return { flat, dice, used: applicable };
  }

  function addEffect(effect) {
    const play = state.sheet.play;
    const created = {
      id: effect.id || `fx-${Date.now()}-${play.effects.length}`,
      name: effect.name,
      bonus: effect.bonus,
      targets: effect.targets,
      once: Boolean(effect.once),
      conc: Boolean(effect.conc),
      // Weapon effects: which weapon, and what they replace on it.
      weapon: effect.weapon || null,
      ability: effect.ability || null,
      die: effect.die || null,
      damageType: effect.damageType || null,
      // A timer with no roll bonus (Turn Undead's minute) says what it is instead
      note: effect.note || null,
      // Something it does every turn (Twilight Sanctuary's temp HP); see lib/classfx.js
      recur: effect.recur || null,
      active: true,
      // Set when the effect came from somebody else's panel.
      fromId: effect.fromId || null,
      fromName: effect.fromName || null,
      // Set on the granter's copy: who it went to and whether they took it.
      grantedTo: effect.grantedTo || null,
      // Counted on its owner's turns (see lib/turns.js); a granted effect
      // arrives with the caster's countdown already set.
      expires: effect.expires ? { ...effect.expires } : Turns.expiryFor(effect.lasts || "", null, activeTurnFor(null)),
    };
    play.effects.push(created);
    renderEffects();
    render();
    savePlay();

    // Concentration applies whether the effect was granted to others or is just
    // running on you — Magic Weapon on your own weapon costs it either way.
    if (created.conc) startConcentration(created);

    return created;
  }

  function removeEffect(fx) {
    state.sheet.play.effects = state.sheet.play.effects.filter((e) => e !== fx);
    renderEffects();
    render();
    savePlay();
  }

  /** End an effect by hand: withdraw it from anyone holding it, and from concentration. */
  async function dismissEffect(fx) {
    if (fx.grantedTo?.length) {
      await Party.revoke(fx.id, fx.grantedTo.map((r) => r.id)).catch(() => {});
    }
    if (state.sheet.play.concentration?.effectId === fx.id) {
      state.sheet.play.concentration = null;
      renderConcentration();
    }
    removeEffect(fx);
  }

  function describeExpiry(fx) {
    const x = fx.expires;
    const me = myQueueId();
    const mine = x.of == null || x.of === state.creatureId || x.of === me;
    return Turns.describe(x, mine ? null : fx.fromName || "the caster", turnSeen?.active != null && turnSeen.active === (x.of ?? me));
  }

  // -------------------------------------------------------------------------
  // Turns (see lib/turns.js)
  //
  // Watches the initiative queue for whose turn it is. At each change it ends
  // effects whose time is up, and when your turn starts it resets this turn's
  // movement and actions. It counts and says what ended; it never stops you.
  // -------------------------------------------------------------------------

  let turnSeen = null; // { active, index, round } from the last queue seen
  let turnQueue = null;
  let tileFeet = null;

  const activeTurnFor = () => turnSeen?.active ?? null;

  /**
   * This sheet's entry in TaleSpire's initiative queue. The entry's id is
   * meant to be the creature's, but TaleSpire doesn't promise it (the Fights
   * view found they differ), so the linked mini's name is the fallback.
   */
  let linkedName = null;
  function myQueueId(queue = turnQueue) {
    if (!state.creatureId || !queue?.items?.length) return null;
    if (queue.items.some((i) => i.id === state.creatureId)) return state.creatureId;
    const n = String(linkedName || "").trim().toLowerCase();
    const byName = n ? queue.items.find((i) => String(i.name || "").trim().toLowerCase() === n) : null;
    return byName?.id || null;
  }

  async function feetPerTile() {
    if (tileFeet) return tileFeet;
    try {
      const u = await TS.rulers.getDistanceUnitsForThisCampaign();
      tileFeet = !failed(u) && u?.numberPerTile ? u.numberPerTile : 5;
    } catch {
      tileFeet = 5;
    }
    return tileFeet;
  }

  function onTurnQueue(queue) {
    turnQueue = queue;
    const play = state.sheet?.play;
    // The sheet remembers the last turn it saw, so a reload mid-fight doesn't
    // replay or lose a boundary
    const prev = play?.turn?.seen || turnSeen || {};
    const { boundaries, next, combatOver } = Turns.step(prev, queue);
    turnSeen = next;
    if (play) {
      play.turn = { ...(play.turn || {}), seen: next };
      if (combatOver) play.turn.mine = null;
      if (boundaries.length) {
        // Synchronous bookkeeping first, so an overlapping poll sees the new turn
        runBoundaries(boundaries).catch((e) => console.error("[Spirekeeper] turn", e));
      }
      if (boundaries.length || combatOver) savePlay();
    }
    if (boundaries.length && state.isGM) gmBoundaries(boundaries).catch((e) => console.error("[Spirekeeper] monster turn", e));
    if (combatOver) clearInitiativeValues();
    renderTurnBar();
  }

  /**
   * The GM's monsters at a turn boundary: when one's turn starts, its movement
   * resets and whatever lasted "until its next turn" (an AC bonus, Dodge) ends.
   */
  async function gmBoundaries(boundaries) {
    const enc = Encounters.current;
    if (!enc) return;
    // The Fights view hears about the queue after the sheet does; catch it up first
    Encounters.setQueue(turnQueue);
    const order = Encounters.turnOrder();
    let changed = false;
    for (const b of boundaries) {
      if (b.at !== "start") continue;
      const c = order.find((e) => e.id === b.of)?.combatant;
      if (!c) continue;
      changed = true;
      let pos = null;
      if (c.creatureId) {
        try {
          pos = (await Board.oneCreature(c.creatureId))?.position || null;
        } catch {
          /* counted from its first move */
        }
      }
      c.turnState = { moved: 0, dashes: 0, lastPos: pos };
      const ended = [];
      if (c.acBonus) {
        ended.push(`+${c.acBonus.amount} AC`);
        await setMonsterAcBonus(c, null);
      }
      if (c.dodge) {
        ended.push("Dodge");
        c.dodge = false;
      }
      if (ended.length) toast(`${c.label}'s turn: ${ended.join(", ")} ended.`);
    }
    if (changed) {
      await saveCurrentEncounter();
      Encounters.render();
    }
  }

  /** A monster's mini moved: count it if it's that monster's turn. */
  async function trackMonsterMove(creatureId) {
    const entry = Encounters.turnOrder().find((e) => e.active && e.combatant?.creatureId === creatureId);
    const c = entry?.combatant;
    if (!c) return;
    let pos = null;
    try {
      pos = (await Board.oneCreature(creatureId))?.position || null;
    } catch {
      return;
    }
    if (!pos) return;
    const t = (c.turnState ||= { moved: 0, dashes: 0, lastPos: null });
    if (t.lastPos) {
      const tiles = Turns.tilesBetween(t.lastPos, pos);
      if (tiles) t.moved += tiles * (await feetPerTile());
    }
    t.lastPos = pos;
    await saveCurrentEncounter();
    Encounters.render();
  }

  /**
   * An AC bonus until the monster's next turn. With the bridge and an AC stat
   * on its mini, the stat itself goes up, so players' attack rolls see it,
   * and comes back down when the bonus ends.
   */
  async function setMonsterAcBonus(c, n) {
    const prev = c.acBonus;
    if (prev?.written) {
      await Bridge.setStat(c.creatureId, prev.written.index, prev.written.before, prev.written.max);
    }
    c.acBonus = null;
    if (n) {
      c.acBonus = { amount: n };
      if (c.creatureId && Bridge.canWrite()) {
        try {
          const info = await Board.oneCreature(c.creatureId);
          const st = Vitals.findStat(info?.stats, Vitals.AC_NAME);
          if (st && st.value != null) {
            const r = await Bridge.setStat(c.creatureId, st.index, st.value + n, Math.max(st.max || 0, st.value + n));
            if (r.ok) c.acBonus.written = { index: st.index, before: st.value, max: st.max };
          }
        } catch {
          /* panel only */
        }
      }
    }
    await saveCurrentEncounter();
    Encounters.render();
  }

  async function runBoundaries(boundaries) {
    const play = state.sheet.play;
    const me = myQueueId();
    const ended = [];
    for (const b of boundaries) {
      queueRecurPrompts(b, me);
      for (const fx of Turns.tick(play.effects, b, me)) {
        if (!play.effects.includes(fx)) continue;
        if (play.concentration?.effectId === fx.id) await endConcentration({ silent: true });
        else await dismissEffect(fx);
        ended.push(fx.name);
      }
      if (me && b.of === me && b.at === "start") await startMyTurn();
      // Once per turn means anyone's turn: an opportunity attack can sneak too
      else if (b.at === "start" && play.turn?.mine) play.turn.mine.sneak = false;
    }
    renderEffects();
    savePlay();
    const myStart = me && boundaries.some((b) => b.of === me && b.at === "start");
    if (myStart) {
      const { speed, why } = currentSpeed();
      toast(`Your turn: ${speed} ft of movement${why ? ` (${why})` : ""}.${ended.length ? ` ${ended.join(", ")} ended.` : ""}`);
    } else if (ended.length) {
      toast(`${ended.join(", ")} ended.`);
    }
  }

  async function startMyTurn() {
    const play = state.sheet.play;
    let pos = null;
    try {
      pos = (await Board.oneCreature(state.creatureId))?.position || null;
    } catch {
      /* counted from the first move instead */
    }
    play.turn.mine = { round: turnSeen?.round || 1, moved: 0, dashes: 0, lastPos: pos, action: false, bonus: false, reaction: false };
    renderTurnBar();
  }

  function isMyTurn() {
    const me = myQueueId();
    return Boolean(me) && turnSeen?.active === me;
  }

  function currentSpeed() {
    const s = state.sheet;
    const mine = s?.play?.turn?.mine;
    return Turns.speedFor({
      walk: s?.speeds?.walk,
      conditions: (s?.play?.conditions || []).map((c) => c.name),
      effects: s?.play?.effects || [],
      dashes: isMyTurn() ? mine?.dashes || 0 : 0,
    });
  }

  /** Count the linked mini's moves while it's your turn. TaleSpire reports where it was dropped, not the path. */
  async function trackMovement(pos) {
    const mine = state.sheet?.play?.turn?.mine;
    if (!pos || !mine || !isMyTurn()) return;
    if (!mine.lastPos) {
      mine.lastPos = pos;
      return;
    }
    const tiles = Turns.tilesBetween(mine.lastPos, pos);
    mine.lastPos = pos;
    if (!tiles) return;
    mine.moved += tiles * (await feetPerTile());
    renderTurnBar();
    savePlay();
  }

  function ensureMine() {
    const play = state.sheet.play;
    play.turn = play.turn || {};
    if (!play.turn.mine) play.turn.mine = { round: turnSeen?.round || 1, moved: 0, dashes: 0, lastPos: null, action: false, bonus: false, reaction: false };
    return play.turn.mine;
  }

  function renderTurnBar() {
    const bar = $("turn-bar");
    const inQueue = Boolean(state.sheet && myQueueId());
    bar.classList.toggle("hidden", !inQueue);
    bar.replaceChildren();
    renderCombatCard();
    if (!inQueue) return;
    const mine = state.sheet.play.turn?.mine || null;
    const myTurn = isMyTurn();
    const { speed, why } = currentSpeed();
    const moved = myTurn ? mine?.moved || 0 : 0;
    const over = moved > speed;

    // Movement: a bar, then the numbers and the corrections
    if (myTurn) {
      const meter = document.createElement("div");
      meter.className = `turn-meter${over ? " is-over" : ""}`;
      meter.innerHTML = `<i style="width:${speed ? Math.min(100, (moved / speed) * 100) : 100}%"></i>`;
      bar.appendChild(meter);
    }
    const line = document.createElement("div");
    line.className = "turn-line";
    const move = document.createElement("span");
    move.innerHTML = myTurn
      ? `Moved <b>${moved}</b> / ${speed} ft` + (over ? ` <span class="is-over">${moved - speed} over</span>` : "") +
        (why ? ` · ${escapeHtml(why)}` : "")
      : `Speed ${speed} ft${why ? ` · ${escapeHtml(why)}` : ""}`;
    line.appendChild(move);

    const chips = document.createElement("span");
    chips.className = "turn-chips";
    // A reaction can be spent on anyone's turn; actions only on your own
    for (const [key, label] of [["action", "Action"], ["bonus", "Bonus"], ["reaction", "Reaction"]]) {
      if (key !== "reaction" && !myTurn) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "turn-chip";
      const spent = Boolean(mine?.[key]);
      chip.classList.toggle("is-spent", spent);
      chip.setAttribute("aria-pressed", spent ? "true" : "false");
      chip.textContent = label;
      chip.title = spent ? `${label} used; click to take it back` : `Mark your ${label.toLowerCase()} as used`;
      chip.onclick = () => {
        const m = ensureMine();
        m[key] = !m[key];
        renderTurnBar();
        savePlay();
      };
      chips.appendChild(chip);
    }

    if (myTurn) {
      const links = document.createElement("span");
      links.className = "turn-links";
      const tweak = (label, title, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "link-btn";
        b.textContent = label;
        b.title = title;
        b.onclick = () => {
          fn(ensureMine());
          renderTurnBar();
          savePlay();
        };
        links.appendChild(b);
      };
      tweak("Dash", "Add your speed again for this turn", (m) => (m.dashes += 1));
      tweak("−5", "Moved less than counted", (m) => (m.moved = Math.max(0, m.moved - 5)));
      tweak("+5", "Moved more than counted (difficult terrain, standing up)", (m) => (m.moved += 5));
      if (moved || mine?.dashes) tweak("reset", "Start this turn's movement over", (m) => { m.moved = 0; m.dashes = 0; });
      line.appendChild(links);
      const row = document.createElement("div");
      row.className = "turn-line";
      row.appendChild(chips);
      bar.append(line, row);
    } else {
      chips.style.marginLeft = "auto";
      line.appendChild(chips);
      bar.appendChild(line);
    }
  }

  /** The combat card shows in initiative, or once a target is picked. */
  function renderCombatCard() {
    const inInit = Boolean(turnQueue?.items?.length);
    const hasTarget = $("target-status").classList.contains("has-target");
    const show = Boolean(state.sheet) && (inInit || hasTarget);
    $("combat-card").classList.toggle("hidden", !show);
    $("pick-target-pill").classList.toggle("hidden", show || !state.sheet);
  }

  // --- effects that act every turn -----------------------------------------

  /** What "plus your Cleric level" and "your spellcasting modifier" mean for this sheet. */
  function recurContext() {
    const s = state.sheet;
    const caster = s?.spellcasting?.blocks?.find((b) => b.ability);
    return {
      levelOf: (cls) => (s?.identity?.classes || []).filter((c) => c.name.toLowerCase() === String(cls).toLowerCase()).reduce((t, c) => t + (c.level || 0), 0),
      spellMod: caster && caster.attackBonus != null ? caster.attackBonus - (s.proficiencyBonus || 0) : null,
    };
  }

  const turnPrompts = []; // { fx, recipient: { id, name }, at }

  /** A turn boundary: offer each running effect that acts on it. */
  function queueRecurPrompts(b, me) {
    for (const fx of state.sheet.play.effects) {
      const r = fx.recur;
      if (!r || !fx.active || r.at !== b.at) continue;
      const owner = fx.expires?.of ?? me;
      if (r.whose === "own" && b.of !== owner) continue;
      const recipient = r.whose === "own"
        ? { id: me, name: "you" }
        : { id: b.of, name: b.of === me ? "you" : (turnQueue?.items || []).find((i) => i.id === b.of)?.name || "that creature" };
      // One prompt per effect: a newer turn replaces an unanswered older one
      const old = turnPrompts.findIndex((p) => p.fx.id === fx.id);
      if (old !== -1) turnPrompts.splice(old, 1);
      turnPrompts.push({ fx, recipient, at: b.at });
    }
    renderTurnPrompts();
  }

  function renderTurnPrompts() {
    const box = $("turn-prompts");
    box.replaceChildren();
    box.classList.toggle("hidden", !turnPrompts.length);
    for (const p of turnPrompts) {
      const card = document.createElement("div");
      card.className = "turn-prompt card";
      const r = p.fx.recur;
      const whose = p.recipient.name === "you" ? "Your" : `${p.recipient.name}'s`;
      // A kept zone for this effect says whether they're actually in it
      let where = "";
      if (zoneShown && zoneShown.spell?.name === p.fx.name && p.recipient.id) {
        where = zoneShown.inside.some((c) => c.id === p.recipient.id) ? " · inside" : " · not inside";
      }
      card.innerHTML = `<span class="turn-prompt-text"><b>${escapeHtml(p.fx.name)}</b> · ${escapeHtml(whose)} turn ${p.at === "end" ? "ended" : "started"}${escapeHtml(where)}</span>`;
      card.appendChild(button(`Roll ${r.roll} ${r.label}`, "btn-gold is-fill", (mode) => {
        turnPrompts.splice(turnPrompts.indexOf(p), 1);
        renderTurnPrompts();
        rollRecur(p.fx, p.recipient, mode);
      }));
      card.appendChild(button("Skip", "btn-ghost", () => {
        turnPrompts.splice(turnPrompts.indexOf(p), 1);
        renderTurnPrompts();
      }));
      box.appendChild(card);
    }
  }

  /** Roll an effect's every-turn benefit for someone; temp HP lands when the dice do. */
  function rollRecur(fx, recipient, mode) {
    const r = fx.recur;
    const forWho = recipient?.name && recipient.name !== "you" ? ` for ${recipient.name}` : "";
    return doRoll({
      name: `${fx.name}: ${r.label}${forWho}`,
      damage: r.roll,
      damageName: `${fx.name} ${r.label}`,
      mode,
      kind: r.benefit === "temp" ? "temp" : r.benefit === "healing" ? "healing" : "damage",
      tempFor: recipient?.id || state.creatureId,
      tempName: recipient?.name || "you",
      source: fx.name,
    });
  }

  // -------------------------------------------------------------------------
  // Saving throws (see lib/saves.js)
  // -------------------------------------------------------------------------

  const saveSessions = []; // run on this panel
  const savePrompts = []; // saves asked of this sheet: { id, creatureId, ability, name }
  const pendingAsks = new Map(); // a player's request waiting for the GM's panel

  /**
   * Who's a player character: a mini owned by someone other than the GM.
   * Monsters get their stat block's save bonus when they're in the fight.
   */
  async function classifyCreatures(creatures, ability) {
    const ids = creatures.map((c) => c.id).filter(Boolean);
    let infos = [];
    try {
      infos = await Board.creatureInfo(ids);
    } catch {
      /* treat everyone as a monster */
    }
    const rows = [];
    for (const c of creatures) {
      const info = infos.find((i) => i?.id === c.id);
      const owners = (info?.ownerIds || []).filter((o) => o !== state.me?.id);
      const combatant = (Encounters.current?.combatants || []).find((x) => x.creatureId === c.id) || null;
      const pc = owners.length > 0 && !combatant;
      let bonus = null;
      if (!pc && combatant) {
        try {
          const m = combatant.cached || (await Monsters.get(combatant.slug));
          bonus = m?.abilities?.[ability]?.save ?? null;
        } catch {
          /* no stat block */
        }
      }
      rows.push({ id: c.id, name: combatant?.label || c.name || info?.name || "Unnamed", kind: pc ? "pc" : "monster", bonus, combatantId: combatant?.id || null, hidden: Boolean(c.hidden) });
    }
    return rows;
  }

  /**
   * Ask for saves. On the GM's panel the table opens here; a player's panel
   * sends the request to the GM's and runs it itself only if none answers.
   */
  async function requestSaves({ name, ability, dc, damage = null, half = true, creatures = [], zone = null }) {
    if (!creatures.length && !zone) return toast("Place the zone or lasso the targets first.", true);
    const session = Saves.create({ name, ability, dc, damage, half });
    if (!state.isGM) {
      const ask = { session, creatures };
      pendingAsks.set(session.id, ask);
      try {
        await Party.saveSession(session, creatures.map((c) => c.id), zone);
      } catch (e) {
        pendingAsks.delete(session.id);
        return toast(`Couldn't reach the table: ${e.message}`, true);
      }
      toast(`Asked the GM's panel to run the ${Saves.ABILITIES[session.ability]} save…`);
      ask.timer = setTimeout(() => {
        if (!pendingAsks.has(session.id)) return;
        pendingAsks.delete(session.id);
        toast("No GM panel answered, so the save runs here. Enter monsters' results with ✓ / ✗.");
        runSession(session, creatures);
      }, 3000);
      return;
    }
    await runSession(session, creatures);
  }

  async function runSession(session, creatures) {
    const rows = await classifyCreatures(creatures, session.ability);
    Saves.addRows(session, rows);
    if (!saveSessions.includes(session)) saveSessions.unshift(session);
    renderSaveSessions();
    const ability = Saves.ABILITIES[session.ability];
    for (const r of rows) {
      if (r.kind !== "pc") continue;
      if (r.id === state.creatureId) onSaveQuery({ id: session.id, creatureId: r.id, ability: session.ability, name: session.name });
      else await Party.saveQuery(session.id, r.id, session.ability, session.name).catch(() => {});
    }
    // The DC stays off the chat: it's the GM's to reveal
    const who = rows.filter((r) => !r.hidden).map((r) => r.name);
    if (who.length) await postChat(`${Rolls.bold(session.name)}: ${escapeText(ability)} save for ${escapeText(who.join(", "))}`, null);
  }

  /** The GM's panel receiving a player's request. */
  async function onSaveSession(msg) {
    if (!state.isGM) return;
    let session = saveSessions.find((x) => x.id === msg.id);
    if (!session) session = Saves.create({ id: msg.id, name: msg.name, ability: msg.ability, dc: msg.dc, damage: msg.damage, half: msg.half, from: "player" });
    let creatures = [];
    if (msg.zone) creatures = await zoneCreaturesFor(msg.zone);
    if (msg.creatureIds?.length) {
      let infos = [];
      try {
        infos = await Board.creatureInfo(msg.creatureIds);
      } catch {
        /* names unknown */
      }
      creatures.push(...msg.creatureIds.map((id) => ({ id, name: infos.find((i) => i?.id === id)?.name || "Unnamed" })));
    }
    await Party.saveAck(msg.id).catch(() => {});
    await runSession(session, creatures);
  }

  /** Who's inside a player's zone, as the GM's panel sees it: { r: rulerId, k: keptZoneId, sh, sz } */
  async function zoneCreaturesFor(zone) {
    let ruler = null;
    if (zone.k) {
      const info = await Bridge.zoneInfo(zone.k);
      if (info && !info.gone) ruler = Zones.rulerFromMarker(info, zone.r || zone.k);
    }
    if (!ruler && zone.r) {
      try {
        const infos = await TS.rulers.getMoreInfo([String(zone.r)]);
        ruler = Array.isArray(infos) ? infos.find((x) => String(x?.id) === String(zone.r)) || null : null;
      } catch {
        ruler = null;
      }
    }
    if (!ruler) return [];
    const result = await Zones.check(zone.sh || Zones.shapeOfRuler(ruler), ruler, { area: zone.sz ? { shape: zone.sh, size: zone.sz } : null });
    return result.inside;
  }

  function onSaveAck({ id }) {
    const ask = pendingAsks.get(id);
    if (!ask) return;
    clearTimeout(ask.timer);
    pendingAsks.delete(id);
    toast("The GM's panel is running the save.");
  }

  function onSaveQuery({ id, creatureId, ability, name }) {
    if (!state.sheet || creatureId !== state.creatureId) return;
    if (savePrompts.some((p) => p.id === id)) return;
    savePrompts.push({ id, creatureId, ability, name });
    renderSavePrompts();
    toast(`${Saves.ABILITIES[ability] || "A"} save asked for: ${name}.`);
  }

  function onSaveResult({ id, creatureId, total, natural }) {
    const session = saveSessions.find((x) => x.id === id);
    if (!session) return;
    Saves.record(session, creatureId, total, natural);
    renderSaveSessions();
  }

  /** This sheet's save, rolled with its own bonus. */
  function rollSavePrompt(p, mode) {
    const sv = (state.sheet.savingThrows || []).find((x) => Saves.abilityKey(x.name) === p.ability);
    const bonus = sv?.value ?? state.sheet.abilities?.[p.ability]?.mod ?? 0;
    savePrompts.splice(savePrompts.indexOf(p), 1);
    renderSavePrompts();
    return doRoll({
      name: `${Saves.ABILITIES[p.ability]} save (${p.name})`,
      roll: `d20${DDB.signed(bonus)}`,
      mode,
      kind: "save",
      saveFor: { session: p.id, creatureId: p.creatureId },
    });
  }

  function renderSavePrompts() {
    const box = $("save-prompts");
    box.replaceChildren();
    box.classList.toggle("hidden", !savePrompts.length);
    for (const p of savePrompts) {
      const card = document.createElement("div");
      card.className = "save-prompt card";
      card.innerHTML = `<span class="save-prompt-text"><b>Save asked:</b> ${escapeHtml(Saves.ABILITIES[p.ability])} save · ${escapeHtml(p.name)}</span>`;
      card.appendChild(button("Roll", "btn-gold is-fill", (mode) => rollSavePrompt(p, mode)));
      card.appendChild(button("✕", "btn-ghost", () => {
        savePrompts.splice(savePrompts.indexOf(p), 1);
        renderSavePrompts();
      }));
      box.appendChild(card);
    }
  }

  /** Monsters' saves in one throw, one d20 group each. */
  async function rollMonsterSaves(session) {
    const rows = session.rows.filter((r) => r.kind === "monster" && r.total == null);
    if (!rows.length) return;
    const ability = Saves.ABILITIES[session.ability];
    const groupIds = {};
    const groups = rows.map((r, i) => {
      const name = `${r.name}${rows.filter((x) => x.name === r.name).length > 1 ? ` #${i + 1}` : ""}: ${ability} save`;
      groupIds[name] = r.id;
      return { name, roll: `d20${DDB.signed(r.bonus ?? 0)}` };
    });
    try {
      await Rolls.stage({ name: `${session.name}: monster saves`, groups, context: { kind: "saveGroup", saveSession: session.id, groupIds } });
      renderStaged();
    } catch (e) {
      toast(e.message, true);
    }
  }

  /** Each creature's damage: full on a fail, half on a success, then its defenses. */
  async function applySaveDamage(session) {
    if (!session.rolled) return;
    const lines = [];
    const notes = [];
    await undoable(`${session.name} damage`, async () => {
      for (const row of session.rows) {
        const parts = Saves.damageFor(session, row);
        if (!parts) continue;
        const combatant = row.combatantId ? (Encounters.current?.combatants || []).find((c) => c.id === row.combatantId) : null;
        const def = combatant ? await defensesForCombatant(combatant) : Vitals.reportedFor(row.id)?.defenses || null;
        const { total, rows: typed } = Damage.apply(parts, def);
        const changed = typed.filter((t) => t.mode !== "normal").map((t) => `${t.type} ${t.mode === "resist" ? "resisted" : t.mode === "vuln" ? "doubled" : "immune"}`);
        if (total <= 0) {
          lines.push(`${row.name} ${row.pass ? "saved" : "failed"}, no damage${changed.length ? ` (${changed.join(", ")})` : ""}`);
          continue;
        }
        if (combatant) {
          await setCombatantHp(combatant, `-${total}`);
        } else if (row.id === state.creatureId && state.sheet) {
          applyHp(-total);
        } else if (row.kind === "monster" && !Bridge.canWrite()) {
          notes.push(`${row.name}: apply ${total} by hand`);
        } else {
          await applyMonsterDamage({ id: row.id, name: row.name }, total, session.name, null, false, changed.join(", "));
          continue; // it posted its own line
        }
        lines.push(`${row.name} ${row.pass ? "saved" : "failed"}: ${total}${changed.length ? ` (${changed.join(", ")})` : ""}`);
      }
      session.applied = true;
    });
    if (lines.length) await postChat(`${Rolls.bold(session.name)}: ${escapeText(lines.join("; "))}`, null);
    if (notes.length) toast(notes.join(". "), true);
    renderSaveSessions();
  }

  function renderSaveSessions() {
    const box = $("save-sessions");
    box.replaceChildren();
    box.classList.toggle("hidden", !saveSessions.length);
    for (const session of saveSessions) {
      const card = document.createElement("div");
      card.className = "save-session card";
      const head = document.createElement("div");
      head.className = "save-head";
      head.innerHTML = `<b>${escapeHtml(Saves.ABILITIES[session.ability])} save · ${escapeHtml(session.name)}</b>`;
      const dc = document.createElement("input");
      dc.type = "number";
      dc.className = "save-dc";
      dc.value = session.dc ?? "";
      dc.placeholder = "DC";
      dc.title = "The DC; players never see it";
      dc.onchange = () => {
        Saves.setDc(session, dc.value);
        renderSaveSessions();
      };
      const dcLabel = document.createElement("label");
      dcLabel.className = "save-dc-label";
      dcLabel.append("DC ", dc);
      const done = session.rows.filter((r) => r.pass != null).length;
      const count = document.createElement("span");
      count.className = "save-count";
      count.textContent = `${done}/${session.rows.length}`;
      const close = button("✕", "btn-ghost", () => {
        saveSessions.splice(saveSessions.indexOf(session), 1);
        renderSaveSessions();
      });
      close.title = "Close";
      head.append(dcLabel, count, close);
      card.appendChild(head);
      if (session.damage) {
        const sub = document.createElement("p");
        sub.className = "hint save-sub";
        sub.textContent = `Fail: ${session.damage.expr}${session.damage.type ? ` ${session.damage.type}` : ""} · Success: ${session.half ? "half damage" : "no damage"}`;
        card.appendChild(sub);
      }

      const list = document.createElement("div");
      list.className = "save-rows";
      for (const r of session.rows) {
        const row = document.createElement("div");
        row.className = "save-row";
        const verdict = r.pass == null ? "" : r.pass ? '<span class="save-pass">SUCCESS</span>' : '<span class="save-fail">FAIL</span>';
        row.innerHTML =
          `<span class="save-who">${r.kind === "monster" ? '<i class="save-kind">M</i>' : ""}${escapeHtml(r.name)}${r.hidden ? ' <small>(hidden)</small>' : ""}</span>` +
          `<span class="save-total">${r.total != null ? `<b>${r.total}</b>` : r.kind === "pc" ? '<span class="hint">waiting…</span>' : r.bonus != null ? `<span class="hint">${DDB.signed(r.bonus)}</span>` : '<span class="hint">no stat block</span>'}</span>` +
          `<span class="save-verdict">${verdict}</span>`;
        for (const [label, val] of [["✓", true], ["✗", false]]) {
          const b = document.createElement("button");
          b.className = `save-mark${r.manual && r.pass === val ? " is-on" : ""}`;
          b.textContent = label;
          b.title = val ? "Count it as a success" : "Count it as a failure";
          b.onclick = () => {
            Saves.override(session, r.id, r.manual && r.pass === val ? null : val);
            renderSaveSessions();
          };
          row.appendChild(b);
        }
        list.appendChild(row);
      }
      card.appendChild(list);

      const actions = document.createElement("div");
      actions.className = "save-actions";
      if (session.rows.some((r) => r.kind === "monster" && r.total == null && r.pass == null)) {
        actions.appendChild(button("Roll monsters", "btn-gold", () => rollMonsterSaves(session)));
      }
      if (session.damage && !session.rolled) {
        actions.appendChild(button(`Roll ${session.damage.expr}`, "btn-gold", (mode) =>
          doRoll({ name: `${session.name} damage`, damage: session.damage.expr, damageType: session.damage.type, mode, kind: "saveDamage", saveSession: session.id })));
      }
      if (session.rolled && !session.applied) {
        const apply = button(`Apply ${session.rolled.total}${session.half ? " (half on a save)" : ""}`, "btn-gold is-fill", () => applySaveDamage(session));
        apply.disabled = !session.rows.some((r) => r.pass != null);
        actions.appendChild(apply);
      }
      if (session.applied) {
        const note = document.createElement("span");
        note.className = "hint";
        note.textContent = "Applied. ↶ Undo in Recent events reverses it.";
        actions.appendChild(note);
      }
      card.appendChild(actions);
      box.appendChild(card);
    }
  }

  /** The creatures a save is for: the open zone of this spell, else the lasso, else the target. */
  async function saveTargets(spellName) {
    if (zoneShown && zoneShown.spell?.name === spellName) {
      if (state.isGM) return { creatures: zoneShown.inside };
      return { creatures: [], zone: { r: zoneShown.rulerId, k: zoneShown.keptId || null, sh: zoneShown.shape, sz: zoneShown.area?.size || null } };
    }
    try {
      const sel = await TS.creatures.getSelectedCreatures();
      const ids = Array.isArray(sel) ? sel.map((x) => x.id || x) : [];
      if (ids.length) {
        const infos = await Board.creatureInfo(ids);
        return { creatures: ids.map((id) => ({ id, name: infos.find((i) => i?.id === id)?.name || "Unnamed" })) };
      }
    } catch {
      /* no selection */
    }
    if (state.target) return { creatures: [{ id: state.target.id, name: state.target.name }] };
    return { creatures: [] };
  }

  /** A spell's save, with its damage at the level cast. */
  async function requestSpellSaves(sp, block, level) {
    const rolls = DDB.upcastRolls(sp, level || sp.level);
    const half = /half as much damage|half damage/i.test(sp.description || "");
    const targets = await saveTargets(sp.name);
    await requestSaves({
      name: sp.name,
      ability: sp.saveAbility,
      dc: block?.saveDc,
      damage: rolls.damage ? { expr: rolls.damage, type: Damage.typeOf(sp.damage?.[0]?.type) } : null,
      half,
      ...targets,
    });
  }

  // -------------------------------------------------------------------------
  // History: recent events and undo
  //
  // Every chat line this panel posts is logged with its time. Actions that
  // change the sheet run inside undoable(): it keeps the play state from just
  // before, and any board writes made along the way (Bridge reports them with
  // the values they replaced). Undo pops the newest and puts both back. It's
  // a stack, so an older action is undone by undoing what came after it.
  //
  // Not undone: dice already rolled, and messages already sent to other
  // panels (a revoked Bless isn't granted back). The chat says what was undone.
  // -------------------------------------------------------------------------

  const eventLog = []; // { at, html, undoId }
  const undoStack = []; // { id, label, sheetId, before, board: [] }
  let tx = null;
  let undoSeq = 0;
  const LOG_MAX = 60;
  const UNDO_MAX = 25;

  /** TextMeshPro's <b> and <color> to HTML, everything else escaped. */
  function chatToHtml(line) {
    return escapeHtml(line)
      .replace(/&lt;(\/?)b&gt;/g, "<$1b>")
      .replace(/&lt;color=(#[0-9a-fA-F]{3,8})&gt;/g, '<span style="color:$1">')
      .replace(/&lt;\/color&gt;/g, "</span>");
  }

  async function postChat(line, speakerId) {
    logEvent(chatToHtml(line));
    await Rolls.post(line, speakerId);
  }

  function logEvent(html) {
    eventLog.unshift({ at: new Date(), html, undoId: null });
    if (tx) tx.logged.push(eventLog[0]);
    eventLog.length = Math.min(eventLog.length, LOG_MAX);
    renderEventLog();
  }

  const playSnapshot = () => (state.sheet ? JSON.parse(JSON.stringify(state.sheet.play)) : null);

  /**
   * Run an action as one undoable step. Nested calls (a smite casting a spell
   * inside a damage roll) join the outer step. Sync actions commit at once,
   * so nothing that runs after them in the same tick is swept in.
   */
  function undoable(label, fn) {
    if (tx || restoring) return fn();
    const mine = { label, sheetId: state.sheetId, before: playSnapshot(), board: [], logged: [] };
    tx = mine;
    let result;
    try {
      result = fn();
    } catch (e) {
      tx = null;
      throw e;
    }
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        if (tx === mine) tx = null;
        commit(mine);
      });
    }
    tx = null;
    commit(mine);
    return result;
  }

  function commit(t) {
    const now = playSnapshot();
    const sheetChanged = t.before && JSON.stringify(stripTurn(t.before)) !== JSON.stringify(stripTurn(now));
    if (!sheetChanged && !t.board.length) return;
    const entry = { id: ++undoSeq, label: t.label, sheetId: t.sheetId, before: sheetChanged ? t.before : null, board: t.board };
    undoStack.push(entry);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    // The step's last chat line carries the undo mark; a silent step logs its label
    if (t.logged.length) t.logged[0].undoId = entry.id;
    else {
      eventLog.unshift({ at: new Date(), html: escapeHtml(capitalise(t.label)), undoId: entry.id });
      eventLog.length = Math.min(eventLog.length, LOG_MAX);
    }
    renderEventLog();
  }

  const capitalise = (t) => String(t || "").charAt(0).toUpperCase() + String(t || "").slice(1);
  // Turn bookkeeping is never undone: rewinding whose turn it is would replay boundaries
  const stripTurn = (play) => (play ? { ...play, turn: undefined } : play);

  /** A board write, from the bridge: part of the current step, or a step of its own. */
  function onBoardWrite(rec) {
    if (restoring) return;
    if (rec.before.value === rec.after.value && rec.before.max === rec.after.max) return;
    if (tx) {
      tx.board.push(rec);
      return;
    }
    const what = rec.kind === "hp"
      ? `${rec.name || "A mini"}: HP ${rec.before.value} → ${rec.after.value}`
      : `${rec.name || "A mini"}: ${rec.statName || "stat"} ${rec.before.value} → ${rec.after.value}`;
    undoStack.push({ id: ++undoSeq, label: what, sheetId: null, before: null, board: [rec] });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    eventLog.unshift({ at: new Date(), html: escapeHtml(what), undoId: undoSeq });
    eventLog.length = Math.min(eventLog.length, LOG_MAX);
    renderEventLog();
  }

  let restoring = false;

  async function undoLast() {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    if (entry.before && entry.sheetId !== state.sheetId) {
      return toast("That was on another character's sheet; switch to it to undo.", true);
    }
    undoStack.pop();
    restoring = true;
    try {
      const notes = [];
      if (entry.before && state.sheet) {
        const play = state.sheet.play;
        const condBefore = new Set(entry.before.conditions.map((c) => c.name));
        const condNow = new Set(play.conditions.map((c) => c.name));
        const revoked = (play.effects || []).filter((e) => e.grantedTo?.length && !entry.before.effects.some((b) => b.id === e.id));
        const turn = play.turn;
        state.sheet.play = { ...entry.before, turn };
        // Conditions follow onto the mini; HP and temp go out with the vitals report
        for (const n of condNow) if (!condBefore.has(n)) pushConditionToBoard(n, false);
        for (const n of condBefore) if (!condNow.has(n)) pushConditionToBoard(n, true);
        if (revoked.length) notes.push("effects already sent to others weren't taken back");
        render();
        renderResources(state.sheet);
        savePlay();
        reportVitals();
      }
      // Board writes in reverse, back to what they replaced
      for (const rec of [...entry.board].reverse()) {
        const r = rec.kind === "hp"
          ? await Bridge.setHp(rec.id, rec.before.value, rec.before.max, { quiet: true })
          : await Bridge.setStat(rec.id, rec.index, rec.before.value, rec.before.max, { quiet: true });
        if (!r.ok) notes.push(`couldn't restore ${rec.name || "a mini"} (${r.error})`);
      }
      if (entry.board.length && state.isGM) GM.refresh?.();
      const item = eventLog.find((e) => e.undoId === entry.id);
      if (item) item.undone = true;
      await postChat(`undid: ${escapeText(entry.label)}${notes.length ? ` ${Rolls.dim(`(${notes.join("; ")})`)}` : ""}`, state.creatureId);
    } finally {
      restoring = false;
      renderEventLog();
    }
  }

  let logOpen = true;
  function renderEventLog() {
    const box = $("event-log");
    if (!box) return;
    box.classList.toggle("hidden", !eventLog.length && !undoStack.length);
    const list = $("event-list");
    list.classList.toggle("hidden", !logOpen);
    $("event-toggle").textContent = logOpen ? "▾ hide" : "▸ show";
    const last = undoStack[undoStack.length - 1];
    const undo = $("event-undo");
    undo.disabled = !last;
    undo.textContent = last ? `↶ Undo` : "↶ Undo";
    undo.title = last ? `Undo: ${last.label}` : "Nothing to undo";
    list.replaceChildren();
    for (const e of eventLog.slice(0, 30)) {
      const row = document.createElement("li");
      row.className = `event${e.undone ? " is-undone" : ""}${last && e.undoId === last.id ? " is-next" : ""}`;
      const t = e.at;
      row.innerHTML = `<time>${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}</time><span>${e.html}</span>`;
      if (last && e.undoId === last.id) {
        const b = document.createElement("button");
        b.className = "link-btn";
        b.textContent = "undo";
        b.title = `Undo: ${last.label}`;
        b.onclick = undoLast;
        row.appendChild(b);
      }
      list.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------
  // Concentration
  //
  // Only meaningful because effects can be granted: concentration is the thing
  // that takes them back. One spell at a time; starting a second ends the first
  // and pulls every effect it handed out.
  // -------------------------------------------------------------------------

  async function startConcentration(effect) {
    const play = state.sheet.play;

    // Cast Bless, then add the Bless effect: same concentration, now with its effect
    const sameSpell = play.concentration && !play.concentration.effectId && play.concentration.name === effect.name;
    if (play.concentration && play.concentration.effectId !== effect.id && !sameSpell) {
      await endConcentration({ silent: true });
      toast(`Concentration moved to ${effect.name}.`);
    }

    play.concentration = { ...(sameSpell ? play.concentration : {}), name: effect.name, effectId: effect.id };
    renderConcentration();
    savePlay();
  }

  async function endConcentration({ silent = false } = {}) {
    const play = state.sheet.play;
    const conc = play.concentration;
    if (!conc) return;

    const granted = play.effects.find((e) => e.id === conc.effectId);

    // Pull it back from everyone who took it.
    if (granted?.grantedTo?.length) {
      try {
        await Party.revoke(granted.id, granted.grantedTo.map((r) => r.id));
      } catch (e) {
        toast(`Could not tell everyone it ended: ${e.message}`, true);
      }
    }

    if (granted) removeEffect(granted);
    // A zone kept on the board for this spell goes when concentration does
    if (conc.zoneId) removeKeptZone(conc.zoneId);
    play.concentration = null;
    renderConcentration();
    savePlay();

    if (!silent) {
      await announce(`stops concentrating on ${Rolls.bold(conc.name)}`);
      toast(`${conc.name} ended.`);
    }
  }

  // -------------------------------------------------------------------------
  // Spell zones (see lib/zones.js)
  // -------------------------------------------------------------------------

  let zoneShown = null; // the result on the card

  /**
   * The minis a zone is checked against. The bridge (GM's machine) knows every
   * mini on the board; otherwise it's the minis this panel knows: the party and
   * linked combatants for a GM, a player's own mini, and anything lassoed.
   */
  async function zoneCreatures() {
    const all = await Bridge.creatures();
    if (all) return { creatures: all, source: "every mini on the board" };

    const ids = new Set();
    if (state.creatureId) ids.add(state.creatureId);
    if (state.isGM) {
      // The party list fills when the Party view opens; load it if it hasn't
      if (!GM.rows?.length) await GM.refresh();
      for (const r of GM.rows || []) ids.add(r.id);
      for (const c of Encounters.current?.combatants || []) if (c.creatureId) ids.add(c.creatureId);
    }
    let selected = [];
    try {
      const sel = await TS.creatures.getSelectedCreatures();
      if (Array.isArray(sel)) selected = sel.map((x) => x.id || x);
    } catch {
      /* none */
    }
    for (const id of selected) ids.add(id);
    const infos = await Board.creatureInfo([...ids]);
    const creatures = infos.filter((i) => i?.position).map((i) => ({
      id: i.id,
      name: i.name || "Unnamed",
      x: i.position.x, y: i.position.y, z: i.position.z,
      scale: i.morphs?.[i.activeMorphIndex ?? 0]?.scale || 1,
      hidden: Boolean(i.isExplicitlyHidden),
    }));
    const parts = [state.isGM ? "party and linked fight minis" : "your mini"];
    if (selected.length) parts.push(`${selected.length} selected`);
    return { creatures, source: parts.join(" and ") };
  }

  /** Show who's inside. A player's panel also asks the GM's, which can see every mini. */
  function showZone(result) {
    const prev = zoneShown && zoneShown.rulerId === result.rulerId ? zoneShown : null;
    zoneShown = {
      ...result,
      gmNames: null,
      awaitingGm: !state.isGM,
      // Moving a kept zone's ruler leaves the old marker; Keep again replaces it
      keptId: prev?.keptId || null,
      keep: prev?.keptId ? "moved" : null,
    };
    renderZoneCard();
    watchZone();
    if (!state.isGM) {
      Party.zoneQuery(result.rulerId, result.shape, result.area?.size ?? null, zoneShown.keptId).catch(() => {});
      setTimeout(() => {
        if (zoneShown?.rulerId === result.rulerId && zoneShown.awaitingGm) {
          zoneShown.awaitingGm = false;
          renderZoneCard();
        }
      }, 2500);
    }
  }

  /**
   * While the card is open, re-check who's inside: minis walk in and out, and
   * a kept marker can be dragged, which TaleSpire never reports to symbiotes.
   * The GM's bridge reads the marker where it is now (GET /zone-info) and
   * every mini once a second. A player's panel asks the GM's every few seconds.
   */
  let zoneWatch = null;
  let zoneTicks = 0;
  function watchZone() {
    if (zoneWatch) return;
    let busy = false;
    zoneWatch = setInterval(async () => {
      const z = zoneShown;
      if (!z) {
        clearInterval(zoneWatch);
        zoneWatch = null;
        return;
      }
      if (busy) return;
      busy = true;
      try {
        zoneTicks += 1;
        if (Bridge.canWrite()) await recheckZone(z);
        else if (!state.isGM && zoneTicks % 3 === 0) {
          Party.zoneQuery(z.rulerId, z.shape, z.area?.size ?? null, z.keptId).catch(() => {});
        }
      } catch (e) {
        console.warn("[Spirekeeper] zone re-check", e);
      } finally {
        busy = false;
      }
    }, 1000);
  }

  async function recheckZone(z) {
    let ruler = z.ruler;
    let markerMoved = false;
    // Once the ruler has moved on from a kept zone, the ruler is what matters
    if (z.keptId && z.keep !== "moved") {
      const info = await Bridge.zoneInfo(z.keptId);
      if (info?.gone) {
        if (zoneShown === z && z.keep !== "Its marker has been removed from the board.") {
          z.keptId = null;
          // A strip with stale names helps nobody: stop tracking and say why
          if (z.min) {
            closeZoneCard(z);
            toast(`${z.spell?.name || "The zone"}'s marker was removed from the board.`);
          } else {
            setKeepState(z.rulerId, "Its marker has been removed from the board.");
          }
        }
        return;
      }
      const fromMarker = info && Zones.rulerFromMarker(info, z.rulerId);
      if (fromMarker) {
        markerMoved = JSON.stringify(fromMarker) !== JSON.stringify(z.markerRuler || null);
        ruler = fromMarker;
      }
    }
    if (!ruler) return;
    const next = await Zones.check(z.shape, ruler, { spell: z.spell, area: z.area });
    if (zoneShown !== z) return; // closed, or replaced by a new placement meanwhile
    const ids = (r) => r.inside.map((c) => c.id).join(",");
    const changed = ids(next) !== ids(z) || next.size !== z.size;
    if (z.keptId) z.markerRuler = ruler;
    if (!changed && !markerMoved) return;
    Object.assign(z, { inside: next.inside, checked: next.checked, source: next.source, size: next.size, offBy: next.offBy });
    if (changed) renderZoneCard();
  }

  function renderZoneCard() {
    const card = $("zone-card");
    const z = zoneShown;
    card.classList.toggle("hidden", !z);
    card.classList.toggle("is-min", Boolean(z?.min));
    card.replaceChildren();
    if (!z) return padForZoneCard();
    if (z.min) {
      renderZoneStrip(card, z);
      return padForZoneCard();
    }

    const head = document.createElement("div");
    head.className = "zone-head";
    head.innerHTML =
      `<strong>${escapeHtml(z.spell?.name || "Zone")}</strong>` +
      `<span class="sub">${escapeHtml(Zones.describeArea(z.area) || z.shape)}` +
      `${z.size ? ` · ruler ${z.size} ${escapeHtml(z.units)}` : ""}</span>`;
    card.appendChild(head);

    if (z.offBy) {
      const warn = document.createElement("p");
      warn.className = "zone-warn";
      warn.textContent = `The ruler is ${z.size} ${z.units}; ${z.spell?.name || "the spell"} is ${z.area.size}. Re-place it if that's not on purpose.`;
      card.appendChild(warn);
    }

    // The GM's answer wins for a player: it saw every mini
    const names = zoneNames(z);
    const list = document.createElement("div");
    list.className = "zone-list";
    if (!names.length) {
      list.textContent = z.awaitingGm ? "Asking the GM's panel…" : "Nobody inside.";
    } else {
      for (const n of names) {
        const chip = document.createElement("span");
        chip.className = "zone-chip";
        chip.textContent = n;
        list.appendChild(chip);
      }
      if (z.gmMore) list.appendChild(document.createTextNode(` +${z.gmMore} more`));
    }
    card.appendChild(list);

    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = z.gmNames
      ? "Checked by the GM's panel against every mini it can see."
      : `Checked ${z.checked} ${z.checked === 1 ? "mini" : "minis"}: ${z.source}.` +
        (!state.isGM && !z.awaitingGm ? " No GM panel answered; lasso minis to include them." : "");
    card.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "zone-actions";
    if (z.spell?.requiresSavingThrow && (z.inside.length || !state.isGM)) {
      const block = (state.sheet?.spellcasting?.blocks || []).find((b) => b.ability) || null;
      const ask = button("Ask for saves", "btn-gold", () => requestSpellSaves(z.spell, block, z.spell.level));
      ask.title = "Everyone inside rolls the save; players never see the DC";
      actions.appendChild(ask);
    }
    if (names.length) {
      actions.appendChild(button("Post to chat", "", () =>
        announce(`${Rolls.bold(z.spell?.name || "Zone")}: ${names.filter((n) => !/\(hidden\)$/.test(n)).join(", ") || "nobody"} inside`)));
    }
    if (Bridge.canWrite() || !state.isGM) {
      const keep = button("Keep on board", "btn-ghost", () => keepZone(z));
      keep.title = "Leave this area on the board as a TaleSpire marker" +
        (z.spell?.concentration ? "; it goes when you stop concentrating" : "");
      if (z.keep === "keeping") keep.disabled = true;
      if (z.keep === "kept") keep.textContent = "Kept ✓";
      actions.appendChild(keep);
    }
    actions.appendChild(button("Minimize", "btn-ghost", () => {
      z.min = true;
      renderZoneCard();
    }));
    actions.appendChild(button("Close", "btn-ghost", () => closeZoneCard(z)));
    card.appendChild(actions);

    // Keep's progress shows on the card itself: a toast would sit underneath it
    const keepNote = {
      keeping: state.isGM || Bridge.canWrite() ? "Putting it on the board…" : "Asking the GM's panel to put it on the board…",
      kept: Bridge.canWrite() ? "On the board for everyone. Drag the marker and this list follows it." : "On the board for everyone.",
      moved: "The ruler moved since you kept it. Keep again to replace the marker.",
    }[z.keep] || z.keep;
    if (keepNote) {
      const p = document.createElement("p");
      p.className = "zone-keep" + (z.keepError ? " is-error" : "");
      p.textContent = keepNote;
      card.appendChild(p);
    }
    padForZoneCard();
  }

  function zoneNames(z) {
    return z.gmNames
      ? z.gmNames
      : z.inside.filter((c) => state.isGM || !c.hidden).map((c) => (state.isGM && c.hidden ? `${c.name} (hidden)` : c.name));
  }

  /**
   * The card shrunk to one line, so a kept zone keeps being tracked without
   * covering the sheet. Tap it to open the card again.
   */
  function renderZoneStrip(card, z) {
    const names = zoneNames(z);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "zone-strip";
    open.title = "Show the zone card";
    const who = names.length ? names.join(", ") : z.awaitingGm ? "checking…" : "nobody inside";
    open.innerHTML = `<strong>◎ ${escapeHtml(z.spell?.name || "Zone")}</strong>` +
      `<span class="zone-strip-who">${names.length ? `${names.length}: ` : ""}${escapeHtml(who)}</span>`;
    open.addEventListener("click", () => {
      z.min = false;
      renderZoneCard();
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "zone-strip-x";
    close.title = "Stop tracking this zone (a kept marker stays on the board)";
    close.setAttribute("aria-label", "Stop tracking this zone");
    close.textContent = "×";
    close.addEventListener("click", () => closeZoneCard(z));
    card.append(open, close);
  }

  function closeZoneCard(z) {
    Zones.release(z.rulerId);
    if (zoneShown === z) zoneShown = null;
    renderZoneCard();
  }

  /** Room at the bottom of the page so the card or strip never hides the last of the sheet. */
  function padForZoneCard() {
    const card = $("zone-card");
    const h = card.classList.contains("hidden") ? 0 : card.offsetHeight;
    document.body.style.paddingBottom = h ? `${h + 20}px` : "";
    document.body.style.setProperty("--zone-card-h", `${h ? h + 8 : 0}px`); // toasts sit above it
  }

  /** Leave the placed ruler on the board as a TaleSpire area marker, via the GM's bridge. */
  function setKeepState(rulerId, keep, error = false) {
    if (!zoneShown || String(zoneShown.rulerId) !== String(rulerId)) return;
    zoneShown.keep = keep;
    zoneShown.keepError = error;
    renderZoneCard();
  }

  async function keepZone(z) {
    const name = z.spell?.name || "Zone";
    const replacing = z.keptId;
    setKeepState(z.rulerId, "keeping");
    if (Bridge.canWrite()) {
      const r = await Bridge.keepZone(z.rulerId, name, z.geometry);
      if (!r.ok) return setKeepState(z.rulerId, `Couldn't keep the zone: ${r.error}.`, true);
      if (replacing) removeKeptZone(replacing);
      keptOnCard(z.rulerId, r.id);
      zoneKeptLocally(name, r.id, z.spell);
    } else {
      const ask = { name, spell: z.spell, replacing };
      pendingKeeps.set(String(z.rulerId), ask);
      try {
        await Party.zoneKeep(z.rulerId, name, z.geometry);
      } catch (e) {
        pendingKeeps.delete(String(z.rulerId));
        return setKeepState(z.rulerId, `Couldn't reach the GM's panel: ${e.message}`, true);
      }
      setTimeout(() => {
        if (pendingKeeps.get(String(z.rulerId)) === ask) {
          pendingKeeps.delete(String(z.rulerId));
          setKeepState(z.rulerId, "No GM panel answered. The GM needs Spirekeeper open, with the bridge plugin.", true);
        }
      }, 5000);
    }
  }

  function keptOnCard(rulerId, zoneId) {
    if (zoneShown && String(zoneShown.rulerId) === String(rulerId)) {
      zoneShown.keptId = zoneId;
      zoneShown.min = true; // kept: get out of the way, keep tracking
    }
    setKeepState(rulerId, "kept");
  }

  const pendingKeeps = new Map(); // rulerId -> { name, spell } a player asked the GM to keep

  /** A kept concentration spell's zone rides on concentration, so dropping it clears the board. */
  async function zoneKeptLocally(name, zoneId, spell) {
    toast(`${name} is on the board.`);
    if (!state.sheet || !spell?.concentration) return;
    const play = state.sheet.play;
    if (play.concentration && play.concentration.name !== name) {
      await endConcentration();
    }
    const previous = play.concentration?.zoneId;
    if (previous && previous !== zoneId) removeKeptZone(previous);
    play.concentration = { ...(play.concentration || {}), name, effectId: play.concentration?.effectId || null, zoneId };
    renderConcentration();
    savePlay();
  }

  function removeKeptZone(zoneId) {
    if (Bridge.canWrite()) {
      Bridge.removeZone(zoneId).then((r) => {
        if (!r.ok) toast(`Couldn't clear the zone from the board (${r.error}).`, true);
      });
    } else {
      Party.zoneRemove(zoneId).catch(() => {});
    }
  }

  // GM side of a player's zone requests
  async function onZoneQuery({ rulerId, shape, size, zoneId }) {
    if (!state.isGM) return;
    let ruler = null;
    // A kept zone is checked where its marker is now, which may have moved
    const info = zoneId ? await Bridge.zoneInfo(zoneId) : null;
    if (info && !info.gone) ruler = Zones.rulerFromMarker(info, rulerId);
    if (ruler) {
      const area = size ? { shape, size } : null;
      const result = await Zones.check(shape || Zones.shapeOfRuler(ruler), ruler, { area }, { hideHidden: true });
      await Party.zoneReply(rulerId, result.inside.map((c) => c.name)).catch(() => {});
      return;
    }
    try {
      const infos = await TS.rulers.getMoreInfo([String(rulerId)]);
      ruler = Array.isArray(infos) ? infos.find((r) => String(r?.id) === String(rulerId)) || infos[0] : null;
    } catch {
      return;
    }
    if (!ruler || ruler.beingEdited) return;
    const area = size ? { shape, size } : null;
    const result = await Zones.check(shape || Zones.shapeOfRuler(ruler), ruler, { area }, { hideHidden: true });
    await Party.zoneReply(rulerId, result.inside.map((c) => c.name)).catch(() => {});
  }

  function onZoneReply({ rulerId, names, more }) {
    if (state.isGM || !zoneShown || String(zoneShown.rulerId) !== String(rulerId)) return;
    zoneShown.gmNames = names;
    zoneShown.gmMore = more;
    zoneShown.awaitingGm = false;
    renderZoneCard();
  }

  async function onZoneKeep({ rulerId, name, geometry }) {
    if (!state.isGM || !Bridge.canWrite()) return;
    const r = await Bridge.keepZone(rulerId, name, geometry);
    if (r.ok) await Party.zoneKept(rulerId, r.id).catch(() => {});
    else {
      console.warn("[Spirekeeper] couldn't keep a player's zone", r.error);
      await Party.zoneKept(rulerId, null, r.error).catch(() => {});
    }
  }

  function onZoneKept({ rulerId, zoneId, error }) {
    const ask = pendingKeeps.get(String(rulerId));
    if (!ask) return;
    pendingKeeps.delete(String(rulerId));
    if (error || !zoneId) return setKeepState(rulerId, `The GM's panel couldn't keep it: ${error || "no zone id"}.`, true);
    if (ask.replacing) removeKeptZone(ask.replacing);
    keptOnCard(rulerId, zoneId);
    zoneKeptLocally(ask.name, zoneId, ask.spell);
  }

  function onZoneRemove({ zoneId }) {
    if (!state.isGM || !Bridge.canWrite() || !zoneId) return;
    Bridge.removeZone(zoneId);
  }

  function renderConcentration() {
    const bar = $("concentration");
    const conc = state.sheet?.play?.concentration;
    bar.classList.toggle("hidden", !conc);
    if (conc) $("conc-label").textContent = `Conc: ${conc.name}`;
    $("concentration").title = conc ? `Concentrating on ${conc.name}. × drops it.` : "";
  }

  // -------------------------------------------------------------------------
  // Granting effects to other players
  // -------------------------------------------------------------------------

  async function openGrantDialog(fx) {
    const panel = $("grant-panel");
    const box = $("grant-recipients");
    box.replaceChildren();
    $("grant-title").textContent = `Grant ${fx.name}`;

    let players = [];
    try {
      players = await Party.reachablePlayers();
    } catch (e) {
      return toast(`Could not list players: ${e.message}`, true);
    }

    const others = players.filter((p) => p.id !== state.me?.id);

    if (!others.length) {
      box.innerHTML = '<p class="hint">Nobody else is on this board.</p>';
    }

    for (const p of others) {
      const label = document.createElement("label");
      label.className = "grant-recipient";
      label.innerHTML =
        `<input type="checkbox" value="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" data-reachable="${p.reachable}">` +
        `<span>${escapeHtml(p.name)}</span>` +
        `<span class="sub">${p.reachable ? "panel open" : "no mod / panel closed — chat only"}</span>`;
      box.appendChild(label);
    }

    panel.classList.remove("hidden");

    $("grant-cancel").onclick = () => panel.classList.add("hidden");

    $("grant-confirm").onclick = async () => {
      const chosen = [...box.querySelectorAll("input:checked")].map((c) => ({
        id: c.value,
        name: c.dataset.name,
        reachable: c.dataset.reachable === "true",
      }));
      panel.classList.add("hidden");
      if (chosen.length) await grantEffect(fx, chosen);
    };
  }

  async function grantEffect(fx, recipients) {
    const reachable = recipients.filter((r) => r.reachable);
    const unreachable = recipients.filter((r) => !r.reachable);

    fx.grantedTo = recipients.map((r) => ({ id: r.id, name: r.name, status: r.reachable ? "pending" : "chat" }));

    if (reachable.length) {
      try {
        await Party.grant(fx, reachable.map((r) => r.id), { ...state.me, creatureId: fx.expires?.of ?? myQueueId() ?? state.creatureId });
      } catch (e) {
        toast(`Could not send: ${e.message}`, true);
        for (const r of fx.grantedTo) if (r.status === "pending") r.status = "failed";
      }
    }

    // Chat reaches everyone regardless of what they have installed, so anyone we
    // can't deliver to at least hears about it.
    if (unreachable.length) {
      await announce(
        `grants ${Rolls.bold(fx.name)} (${signedBonus(fx.bonus)} ${fx.targets.join(", ")}) to ${unreachable.map((r) => r.name).join(", ")}`
      );
    }

    if (fx.conc) await startConcentration(fx);

    renderEffects();
    savePlay();
  }

  // --- inbound ---

  function onEffectGranted(incoming) {
    // Consent, not push: the recipient decides. Prompts stack if several arrive.
    const inbox = $("effect-inbox");

    const card = document.createElement("div");
    card.className = "inbox-card";
    card.innerHTML =
      `<span class="inbox-text"><b>${escapeHtml(incoming.fromName || "Someone")}</b> is granting you ` +
      `<b>${escapeHtml(incoming.name)}</b> <span class="sub">${escapeHtml(signedBonus(incoming.bonus))} ${escapeHtml(incoming.targets.join(", "))}</span></span>`;

    const accept = document.createElement("button");
    accept.className = "btn btn-small btn-primary";
    accept.textContent = "Accept";
    accept.onclick = async () => {
      addEffect(incoming);
      card.remove();
      await Party.acknowledge(incoming.id, incoming.fromId, state.me.id, true).catch(() => {});
      toast(`${incoming.name} applied.`);
    };

    const decline = document.createElement("button");
    decline.className = "btn btn-small btn-ghost";
    decline.textContent = "Decline";
    decline.onclick = async () => {
      card.remove();
      await Party.acknowledge(incoming.id, incoming.fromId, state.me.id, false).catch(() => {});
    };

    card.append(accept, decline);
    inbox.appendChild(card);
  }

  function onEffectRevoked(effectId) {
    const fx = (state.sheet?.play?.effects || []).find((e) => e.id === effectId);
    if (!fx) return;
    removeEffect(fx);
    toast(`${fx.name} ended${fx.fromName ? ` (${fx.fromName} stopped concentrating)` : ""}.`);
  }

  function onEffectAck({ effectId, playerId, accepted }) {
    const fx = (state.sheet?.play?.effects || []).find((e) => e.id === effectId);
    const entry = fx?.grantedTo?.find((r) => r.id === playerId);
    if (!entry) return;
    entry.status = accepted ? "accepted" : "declined";
    renderEffects();
    savePlay();
  }



  /**
   * Rebuild an attack with any weapon effects applied.
   *
   * Shillelagh is the awkward case the additive model can't express: it swaps the
   * ability used for attack and damage AND the damage die, so the attack has to be
   * recomputed from its parts rather than nudged by a bonus.
   */
  function applyWeaponEffects(attack) {
    const s = state.sheet;
    const fx = activeEffects("weapon").filter((e) => !e.weapon || e.weapon === attack.name);
    if (!fx.length) return { ...attack, modifiedBy: [] };

    let flat = 0;
    let ability = null;
    let dice = null;
    let damageType = attack.damageType;
    const names = [];

    for (const e of fx) {
      names.push(e.name);
      if (e.ability && s.abilities[e.ability]) ability = e.ability;
      if (e.die) dice = e.die;
      if (e.damageType) damageType = e.damageType;
      const n = parseInt(signedBonus(e.bonus), 10);
      if (!isNaN(n)) flat += n;
    }

    // Nothing structural changed — just nudge the existing numbers. This is also
    // the safe path for sheets imported before the attack breakdown existed.
    if (!ability && !dice) {
      return {
        ...attack,
        toHit: attack.toHit + flat,
        attackRoll: `d20${DDB.signed(attack.toHit + flat)}`,
        damageRoll: flat ? `${attack.damageRoll}${DDB.signed(flat)}` : attack.damageRoll,
        damageType,
        modifiedBy: names,
      };
    }

    // Swapping the ability or die means rebuilding the attack from its parts.
    // Sheets stored by an older version don't carry them, so recover what we can
    // from the damage string rather than producing NaN.
    const parts = attackParts(attack);
    const abilityMod = ability ? s.abilities[ability].mod : parts.abilityMod;
    const finalDice = dice || parts.damageDice;
    const toHit = abilityMod + (attack.proficient ? s.proficiencyBonus : 0) + parts.magicBonus + flat;
    const damageMod = abilityMod + parts.magicBonus + flat;

    return {
      ...attack,
      toHit,
      attackRoll: `d20${DDB.signed(toHit)}`,
      damageRoll: `${finalDice}${damageMod ? DDB.signed(damageMod) : ""}`,
      damageType,
      modifiedBy: names,
    };
  }

  /**
   * Recover an attack's components. Sheets imported before the normalizer split
   * these out only have the assembled strings, and they live in storage across
   * upgrades, so read the pieces back out of "1d4+2" rather than trusting the
   * fields to exist.
   */
  function attackParts(attack) {
    if (attack.damageDice != null && attack.abilityMod != null) {
      return { damageDice: attack.damageDice, abilityMod: attack.abilityMod, magicBonus: attack.magicBonus || 0 };
    }
    const m = /^(\d*d\d+)\s*([+-]\s*\d+)?/.exec(attack.damageRoll || "");
    return {
      damageDice: m?.[1] || "1d4",
      abilityMod: m?.[2] ? parseInt(m[2].replace(/\s+/g, ""), 10) : 0,
      magicBonus: 0,
    };
  }

  /** Weapon effects need to know which weapon before they can be added. */
  function openWeaponPicker(preset) {
    const panel = $("weapon-pick-panel");
    const list = $("weapon-pick-list");
    list.replaceChildren();
    $("weapon-pick-title").textContent = `${preset.name} — apply to which weapon?`;

    const weapons = state.sheet.attacks;
    if (!weapons.length) {
      toast("No weapons on this sheet to apply it to.", true);
      return;
    }

    for (const w of weapons) {
      const b = document.createElement("button");
      b.className = "btn btn-small";
      b.textContent = w.name;
      b.onclick = () => {
        panel.classList.add("hidden");
        const ability = preset.useSpellAbility
          ? state.sheet.spellcasting.blocks.find((blk) => blk.ability)?.ability || null
          : null;
        addEffect({ ...preset, weapon: w.name, ability });
      };
      list.appendChild(b);
    }

    panel.classList.remove("hidden");
    $("weapon-pick-cancel").onclick = () => panel.classList.add("hidden");
  }

  /** Buffs as green pills in the header, so they're in view on every tab. */
  function renderEffectPills() {
    const box = $("effect-pills");
    box.replaceChildren();
    for (const fx of state.sheet?.play?.effects || []) {
      const pill = document.createElement("span");
      pill.className = `pill pill-buff${fx.active ? "" : " is-off"}`;
      pill.textContent = fx.name;
      pill.title = [
        fx.weapon ? `${fx.weapon}` : (fx.targets || []).length ? `${signedBonus(fx.bonus)} to ${fx.targets.join(", ")}` : fx.note,
        fx.expires ? describeExpiry(fx) : null,
        fx.fromName ? `from ${fx.fromName}` : null,
        fx.active ? null : "suspended",
      ].filter(Boolean).join(" · ");
      box.appendChild(pill);
    }
  }

  function renderEffects() {
    renderEffectPills();
    const presets = $("effect-presets");
    presets.replaceChildren();
    for (const preset of EFFECT_PRESETS) {
      const b = document.createElement("button");
      b.className = "btn btn-small btn-ghost";
      b.textContent = `+ ${preset.name}`;
      b.title = `${signedBonus(preset.bonus)} to ${preset.targets.join(", ")}${preset.once ? " (once)" : ""}${preset.conc ? " · concentration" : ""}`;
      b.onclick = () => (preset.needsWeapon ? openWeaponPicker(preset) : addEffect(preset));
      presets.appendChild(b);
    }

    const list = $("effect-list");
    list.replaceChildren();
    const effects = state.sheet?.play?.effects || [];

    for (const fx of effects) {
      const row = document.createElement("div");
      row.className = `effect${fx.active ? "" : " is-off"}`;

      const RECEIPT = { pending: "…", accepted: "✓", declined: "✗", chat: "chat", failed: "!" };
      const receipts = (fx.grantedTo || []).map((r) => `${r.name} ${RECEIPT[r.status] || ""}`).join(", ");

      const timerOnly = !fx.weapon && !(fx.targets || []).length;
      const detail = [
        timerOnly ? fx.note || null : fx.weapon ? fx.weapon : signedBonus(fx.bonus),
        fx.die ? `${fx.die}${fx.damageType ? ` ${fx.damageType}` : ""}` : null,
        fx.ability ? `uses ${fx.ability.toUpperCase()}` : null,
        fx.weapon || timerOnly ? null : fx.targets.join(", "),
        fx.once ? "once" : null,
        fx.conc ? "concentration" : null,
        fx.expires ? describeExpiry(fx) : null,
        fx.fromName ? `from ${fx.fromName}` : null,
        receipts ? `→ ${receipts}` : null,
      ].filter(Boolean).join(" · ");

      const label = document.createElement("button");
      label.className = "effect-label";
      label.innerHTML = `<b>${escapeHtml(fx.name)}</b> <span class="sub">${escapeHtml(detail)}</span>`;
      label.title = "Click to suspend or resume";
      label.onclick = () => {
        fx.active = !fx.active;
        renderEffects();
        render();
        savePlay();
      };
      row.appendChild(label);

      // Only offer to hand out effects you own — a buff someone gave you is
      // theirs to withdraw, not yours to pass along.
      if (!fx.fromId) {
        const share = document.createElement("button");
        share.className = "btn btn-small btn-ghost";
        share.textContent = "Grant…";
        share.title = "Send this to other players";
        share.onclick = () => openGrantDialog(fx);
        row.appendChild(share);
      }

      const remove = document.createElement("button");
      remove.className = "btn btn-small btn-ghost";
      remove.textContent = "×";
      remove.title = fx.fromId ? "Remove" : "Remove (and withdraw from anyone holding it)";
      remove.onclick = () => dismissEffect(fx);
      // An effect that gives something every turn can be rolled by hand any time
      if (fx.recur && fx.active) {
        const again = button(`↻ ${fx.recur.roll} ${fx.recur.label}`, "btn-gold", (mode) =>
          rollRecur(fx, { id: state.creatureId, name: "you" }, mode));
        again.title = fx.recur.whose === "any"
          ? `Roll ${fx.name} for yourself. During initiative you're offered it as each creature's turn ${fx.recur.at === "end" ? "ends" : "starts"}.`
          : `Roll ${fx.name}`;
        row.appendChild(again);
      }
      remove.textContent = "End";
      remove.className = "btn btn-small btn-gold is-fill";

      row.append(remove);
      list.appendChild(row);
    }
  }

  /**
   * Maximum HP after changes like Aid (+5) or Life Drain (-7). The imported
   * maximum is left alone; the changes sit beside it and all end on a long rest.
   */
  function effectiveMaxHp(s) {
    const mods = s.play?.maxHpMods || [];
    return Math.max(1, s.hp.max + mods.reduce((t, m) => t + (m.amount || 0), 0));
  }

  function renderHp(s) {
    const play = s.play;
    const max = effectiveMaxHp(s);
    const mods = play.maxHpMods || [];
    $("v-hp").textContent = `${play.hp.current}/${max}${mods.length ? "*" : ""}`;
    $("v-temp").textContent = play.hp.temp ? `+${play.hp.temp} temp` : "";
    // Temp HP shows as a blue segment after the green, scaled to the maximum
    const whole = Math.max(max, play.hp.current + play.hp.temp);
    const ratio = max ? play.hp.current / max : 0;
    $("hp-fill").style.width = `${(play.hp.current / whole) * 100}%`;
    $("hp-temp-fill").style.width = `${(play.hp.temp / whole) * 100}%`;
    const meter = $("hp-fill").parentElement;
    meter.classList.toggle("is-bloodied", ratio <= 0.5 && ratio > 0.25);
    meter.classList.toggle("is-critical", ratio <= 0.25);
    $("v-hp").title = [
      play.hp.temp ? `${play.hp.current} HP plus ${play.hp.temp} temporary` : "",
      mods.length
        ? `Maximum ${max}: ${s.hp.max} ${mods.map((m) => `${DDB.signed(m.amount)} ${m.name}`).join(" ")}`
        : "",
      breakdownText(s.hp.breakdown),
    ]
      .filter(Boolean)
      .join("\n\n");
    renderMaxHpMods(s);
  }

  function renderMaxHpMods(s) {
    const box = $("maxhp-mods");
    if (!box) return;
    box.replaceChildren();
    for (const m of s.play.maxHpMods || []) {
      const chip = document.createElement("span");
      chip.className = `maxhp-mod${m.amount < 0 ? " is-down" : ""}`;
      chip.title = "Ends on a long rest";
      const label = document.createElement("span");
      label.textContent = `${m.name} ${DDB.signed(m.amount)} max`;
      const x = document.createElement("button");
      x.className = "chip-btn";
      x.textContent = "×";
      x.title = "End this change now";
      x.onclick = () => removeMaxHpMod(m.id);
      chip.append(label, x);
      box.appendChild(chip);
    }
  }

  /**
   * Raise or lower maximum HP. A raise like Aid lifts current HP by the same
   * amount; a drop like Life Drain only pulls current HP down if it's now over
   * the new maximum.
   */
  function addMaxHpMod(amount, name) {
    if (!amount) return;
    const s = state.sheet;
    const play = s.play;
    play.maxHpMods = play.maxHpMods || [];
    const label = String(name || "").trim() || (amount > 0 ? "Bonus" : "Drain");
    play.maxHpMods.push({ id: `m-${Date.now().toString(36)}`, name: label, amount });
    if (amount > 0) play.hp.current += amount;
    play.hp.current = Math.max(0, Math.min(effectiveMaxHp(s), play.hp.current));
    renderHp(s);
    savePlay();
    reportVitals();
    announce(`max HP ${DDB.signed(amount)} (${label}): now ${play.hp.current}/${effectiveMaxHp(s)}`).catch(() => {});
  }

  /** Ending a change: when Aid ends the maximum drops, and current HP with it only if above. */
  function removeMaxHpMod(id) {
    const s = state.sheet;
    const play = s.play;
    play.maxHpMods = (play.maxHpMods || []).filter((m) => m.id !== id);
    play.hp.current = Math.min(effectiveMaxHp(s), play.hp.current);
    renderHp(s);
    savePlay();
    reportVitals();
  }

  /**
   * Tell the GM's panel this character's HP, maximum and temp pool. With the
   * bridge the GM writes them onto the mini; without it, the GM's automated
   * monster attacks still know about temp HP. Debounced: one report per burst.
   */
  let vitalsTimer = null;
  function reportVitals() {
    if (!state.sheet || !state.creatureId) return;
    clearTimeout(vitalsTimer);
    const creatureId = state.creatureId;
    vitalsTimer = setTimeout(() => {
      const s = state.sheet;
      if (!s || state.creatureId !== creatureId) return;
      Party.reportVitals(creatureId, s.play.hp.current, effectiveMaxHp(s), s.play.hp.temp || 0, Damage.pack(Damage.defensesOf(s.defenses)))
        .catch((e) => console.warn("[Spirekeeper] vitals report", e.message));
    }, 300);
  }

  /**
   * The linked mini changed on the board: the GM applied damage through the
   * bridge, or edited it in TaleSpire. Follow the board, but only when the
   * board itself moved, so a stale board value never overwrites a change made
   * here a moment ago that the GM hasn't written yet.
   */
  let lastBoardVitals = null;
  async function followLinkedMini() {
    const s = state.sheet;
    if (!s || !state.creatureId) return;
    let info;
    try {
      info = await Board.oneCreature(state.creatureId);
    } catch {
      return;
    }
    if (!info) return;
    linkedName = info.name || linkedName;
    trackMovement(info.position);
    const hasHp = Boolean(info.hp && info.hp.max > 0);
    const tempStat = Vitals.tempStatOf(info);
    const seen = {
      hp: hasHp ? info.hp.value : null,
      temp: tempStat ? tempStat.value : null,
      conditions: Statuses.on(info).conditions,
    };
    const before = lastBoardVitals;
    lastBoardVitals = seen;

    const play = s.play;
    const notes = [];

    // Conditions: the statuses the GM has paired. On the first look only add
    // what the board shows; after that, follow what changed on the board.
    const has = (name) => play.conditions.some((c) => c.name === name);
    const added = seen.conditions.filter((c) => !before || !before.conditions.includes(c));
    const removed = before ? before.conditions.filter((c) => !seen.conditions.includes(c)) : [];
    for (const name of added) {
      if (has(name)) continue;
      play.conditions.push({ name, level: name === "Exhaustion" ? 1 : null });
      notes.push(`now ${name}`);
    }
    for (const name of removed) {
      if (!has(name)) continue;
      play.conditions = play.conditions.filter((c) => c.name !== name);
      notes.push(`no longer ${name}`);
    }

    // Hit points: only once the board has moved, never on the first look
    if (before && hasHp) {
      if (seen.hp !== before.hp && seen.hp !== play.hp.current) {
        play.hp.current = Math.max(0, Math.min(effectiveMaxHp(s), seen.hp));
        notes.push(`HP ${play.hp.current}/${effectiveMaxHp(s)}`);
      }
      if (tempStat && seen.temp !== before.temp && seen.temp !== play.hp.temp) {
        play.hp.temp = Math.max(0, seen.temp || 0);
        notes.push(`${play.hp.temp} temp HP`);
      }
    }

    if (notes.length) {
      renderHp(s);
      renderConditions();
      savePlay();
      toast(`From the board: ${notes.join(", ")}.`);
    }
  }

  /** The GM set this character's temp pool (campaigns without a Temp HP stat). */
  /**
   * Temp HP someone gave you (Twilight Sanctuary): it doesn't stack, so the
   * bigger pool wins, same as granting it yourself.
   */
  function onTempGrant({ creatureId, temp, source }) {
    if (!state.sheet || (creatureId !== state.creatureId && creatureId !== myQueueId())) return;
    const n = Math.max(0, Math.round(Number(temp) || 0));
    if (n > (state.sheet.play.hp.temp || 0)) {
      grantTempHp(n);
      toast(`${source || "An effect"} gave you ${n} temp HP.`);
    } else {
      toast(`${source || "An effect"} offered ${n} temp HP; you already have ${state.sheet.play.hp.temp}.`);
    }
  }

  function onTempFromGm({ creatureId, temp }) {
    if (!state.sheet || creatureId !== state.creatureId) return;
    state.sheet.play.hp.temp = Math.max(0, Number(temp) || 0);
    renderHp(state.sheet);
    savePlay();
  }

  /** The GM's monster hit this character and there's no bridge: apply it here. */
  function onHitFromGm({ creatureId, amount, source }) {
    if (!state.sheet || creatureId !== state.creatureId) return;
    const n = Math.max(0, Math.round(Number(amount) || 0));
    if (!n) return;
    const tempBefore = state.sheet.play.hp.temp || 0;
    applyHp(-n);
    const absorbed = Math.min(tempBefore, n);
    toast(`${source || "The GM"} hits you for ${n}${absorbed ? ` (${absorbed} from temp HP)` : ""}.`);
  }

  /** A player added or removed a paired condition; as GM, set the status on their mini. */
  async function onConditionFromPlayer({ creatureId, emoteId, on }) {
    if (!state.isGM || !Bridge.canWrite() || !creatureId || !emoteId) return;
    const r = await Bridge.setEmote(creatureId, emoteId, on);
    if (!r.ok) console.warn("[Spirekeeper] could not set a player's status", r.error);
  }

  /** The GM adding or removing a condition from a party row. */
  async function setPartyCondition(row, condition, on) {
    const emoteId = Statuses.emoteFor(condition);
    if (!emoteId) return toast(`${condition} isn't paired with a TaleSpire status yet.`, true);
    const r = await Bridge.setEmote(row.id, emoteId, on);
    if (!r.ok) return toast(`Couldn't ${on ? "set" : "clear"} ${condition} on ${row.name} (${r.error}).`, true);
  }

  /**
   * The GM's pairing list: every TaleSpire status by name (from the bridge's
   * catalog), with a condition picker, a note of which minis wear it now, and a
   * suggestion where the names match. Without the bridge it falls back to the
   * statuses seen on minis.
   */
  function renderStatusMap() {
    const box = $("status-map");
    if (!box) return;
    box.replaceChildren();
    const items = Statuses.list();
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = Bridge.status.available
        ? "Reading TaleSpire's statuses…"
        : "With the bridge running this lists every TaleSpire status by name. Without it, set a status on a mini and it appears here.";
      box.appendChild(p);
      return;
    }

    const suggested = items.filter((it) => !it.condition && it.suggestion).length;
    if (suggested) {
      const bar = document.createElement("div");
      bar.className = "status-map-bar";
      const btn = document.createElement("button");
      btn.className = "btn btn-small btn-primary";
      btn.textContent = `Pair ${suggested} suggested`;
      btn.title = "Pair every status whose name matches a condition";
      btn.onclick = async () => {
        const n = await Statuses.acceptSuggestions();
        toast(`Paired ${n} ${n === 1 ? "status" : "statuses"}.`);
      };
      bar.append(btn);
      box.appendChild(bar);
    }

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "status-map-row";
      const label = document.createElement("div");
      label.className = "status-map-name";
      const title = document.createElement("span");
      title.textContent = it.name || (it.names.length ? `Status on ${it.names.join(", ")}` : "Unnamed status");
      label.appendChild(title);
      const sub = [
        it.name && it.names.length ? `on ${it.names.join(", ")}` : null,
        !it.condition && it.suggestion ? `suggested: ${it.suggestion}` : null,
      ].filter(Boolean);
      if (sub.length) {
        const small = document.createElement("span");
        small.className = "sub";
        small.textContent = sub.join(" · ");
        label.appendChild(small);
      }
      label.title = `Status ${it.emoteId}`;
      const pick = document.createElement("select");
      pick.setAttribute("aria-label", `Condition for ${it.name || "this status"}`);
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "— not a condition";
      pick.appendChild(none);
      for (const name of CONDITION_NAMES) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        pick.appendChild(opt);
      }
      pick.value = it.condition || "";
      pick.onchange = () => Statuses.setMapping(it.emoteId, pick.value || null, true);
      row.append(label, pick);
      box.appendChild(row);
    }
  }

  /** A player's panel reported its vitals; as GM, keep the mini in step. */
  async function onVitalsFromPlayer({ creatureId, hp, max, temp, defenses }) {
    if (!state.isGM || !creatureId) return;
    Vitals.report(creatureId, { hp, max, temp, defenses: defenses != null ? Damage.unpack(defenses) : Vitals.reportedFor(creatureId)?.defenses || null });
    GM.refresh();
    if (!Bridge.canWrite()) return;
    let info;
    try {
      info = await Board.oneCreature(creatureId);
    } catch {
      return;
    }
    if (!info) return;
    const v = Vitals.read(info);
    const r = await Vitals.write(v, { hp, max, temp });
    if (!r.ok) console.warn("[Spirekeeper] could not write reported vitals", r.error);
  }

  /**
   * Temporary hit points don't stack — you take whichever pool is larger, so
   * granting 5 temp to someone already sitting on 8 does nothing. Say so rather
   * than silently ignoring the click.
   */
  function grantTempHp(amount) {
    if (amount <= 0) return;
    const play = state.sheet.play;

    if (amount <= play.hp.temp) {
      toast(`Already have ${play.hp.temp} temp HP — temp HP doesn't stack, so this is ignored.`);
      return;
    }

    play.hp.temp = amount;
    renderHp(state.sheet);
    savePlay();
    reportVitals();
    toast(`Temp HP set to ${amount}.`);
  }

  /** "=20": set current HP outright, leaving temp HP alone. */
  function setHp(n) {
    const play = state.sheet.play;
    play.hp.current = Math.max(0, Math.min(effectiveMaxHp(state.sheet), n));
    renderHp(state.sheet);
    savePlay();
    reportVitals();
  }

  /** Damage eats temporary hit points first, then real ones. */
  function applyHp(delta) {
    const play = state.sheet.play;

    if (delta < 0 && play.hp.temp > 0) {
      const absorbed = Math.min(play.hp.temp, -delta);
      play.hp.temp -= absorbed;
      delta += absorbed;
    }

    play.hp.current = Math.max(0, Math.min(effectiveMaxHp(state.sheet), play.hp.current + delta));
    renderHp(state.sheet);
    savePlay();
    reportVitals();
  }

  function renderHitDice(s) {
    const box = $("hit-dice");
    box.replaceChildren();
    if (!s.hp.hitDice.length) return;

    for (const hd of s.hp.hitDice) {
      const used = s.play.hitDiceUsed[hd.die] || 0;
      const left = hd.total - used;

      const chip = document.createElement("div");
      chip.className = "hd-chip";
      chip.innerHTML = `<span>${hd.die}</span>`;
      chip.appendChild(pips(left, hd.total));
      chip.insertAdjacentHTML("beforeend", `<span class="hd-count">${left}/${hd.total}</span>`);

      const spend = document.createElement("button");
      spend.className = "btn btn-small";
      spend.textContent = "Spend";
      spend.disabled = left <= 0;
      spend.onclick = () => spendHitDie(hd);

      // The rules let you choose which dice a long rest returns, so allow moving
      // one back by hand rather than trusting our distribution.
      const undo = document.createElement("button");
      undo.className = "btn btn-small btn-ghost";
      undo.textContent = "↺";
      undo.title = "Give one die back";
      undo.disabled = used <= 0;
      undo.onclick = () => {
        s.play.hitDiceUsed[hd.die] = Math.max(0, used - 1);
        renderHitDice(s);
        savePlay();
      };

      chip.append(spend, undo);
      if (hd.classes?.length > 1) chip.title = `Shared pool: ${hd.classes.join(", ")}`;
      box.appendChild(chip);
    }
  }

  /**
   * Spending a hit die is a real roll: die + CON modifier, healed on the result.
   * Routed through the dice tray so the table sees it like any other roll.
   */
  async function spendHitDie(hd) {
    const s = state.sheet;
    const conMod = s.abilities.con.mod;
    const used = s.play.hitDiceUsed[hd.die] || 0;
    if (used >= hd.total) return;

    s.play.hitDiceUsed[hd.die] = used + 1;
    renderHitDice(s);
    savePlay();

    await doRoll({
      name: `Hit die ${hd.die}`,
      damage: `1${hd.die}${conMod ? DDB.signed(conMod) : ""}`,
      kind: "hitdie",
    });
  }

  async function shortRest() {
    const s = state.sheet;

    // Warlock slots and short-rest resources come back; hit dice do not.
    if (s.spellcasting.pact) s.play.pactUsed = 0;
    for (const r of s.resources) {
      if (r.resetsOn === "short rest") s.play.resourcesUsed[r.name] = 0;
    }
    for (const sp of allSpells(s)) {
      if (sp.limitedUse?.resetsOn === "short rest") spellUsesUsed(s.play)[sp.name] = 0;
    }

    render();
    savePlay();
    await announce("takes a short rest");
    toast("Short rest — short-rest resources restored. Spend hit dice to heal.");
  }

  async function longRest() {
    const s = state.sheet;

    // Every maximum HP change here (Aid, Life Drain) ends on a long rest
    s.play.maxHpMods = [];
    s.play.hp.current = s.hp.max;
    s.play.hp.temp = 0;
    reportVitals();
    for (const slot of s.spellcasting.slots) s.play.slotsUsed[slot.level] = 0;
    s.play.pactUsed = 0;
    for (const r of s.resources) s.play.resourcesUsed[r.name] = 0;
    // Every free cast comes back: a long rest ends a short-rest day too.
    s.play.spellUsesUsed = {};
    await endConcentration({ silent: true });
    s.play.effects = []; // buffs don't survive the night

    // You regain up to half your TOTAL hit dice, minimum one — not half of each
    // pool. For a multiclass character those differ: a Fighter 5 / Wizard 5 has
    // ten dice and gets five back, where halving each pool would give four.
    // RAW the player picks which dice return; this restores the most-spent pools
    // first and leaves the ↺ buttons for redistributing.
    const totalDice = s.hp.hitDice.reduce((t, hd) => t + hd.total, 0);
    let toRestore = Math.max(1, Math.floor(totalDice / 2));

    const spent = s.hp.hitDice
      .map((hd) => ({ die: hd.die, used: s.play.hitDiceUsed[hd.die] || 0 }))
      .filter((p) => p.used > 0)
      .sort((a, b) => b.used - a.used);

    for (const pool of spent) {
      if (toRestore <= 0) break;
      const give = Math.min(pool.used, toRestore);
      s.play.hitDiceUsed[pool.die] = pool.used - give;
      toRestore -= give;
    }

    render();
    savePlay();
    await announce("takes a long rest");
    toast("Long rest — HP, slots and resources restored.");
  }

  // -------------------------------------------------------------------------
  // Pending damage
  //
  // Hit or miss is the DM's call, so an attack rolls the d20 alone and parks its
  // damage here. When the DM says it landed, one click rolls it — and if the d20
  // came up 20, the crit button is offered alongside.
  // -------------------------------------------------------------------------

  /**
   * What we've put in the tray and are still waiting on.
   *
   * TaleSpire offers no way to pull dice back out, so a misclick can't be undone
   * from here — the dice have to be dismissed in the game's own tray. What the
   * panel can do is stop waiting on them, so a roll you didn't want doesn't get
   * announced or arm a damage button when it eventually lands.
   */
  function renderStaged() {
    const box = $("staged-roll");
    const rolls = Rolls.staged();
    box.replaceChildren();
    box.classList.toggle("hidden", rolls.length === 0);
    if (!rolls.length) return;

    const label = document.createElement("span");
    const names = rolls.map((r) => r.name + (r.mode && r.mode !== Rolls.MODE.NORMAL ? ` (${r.mode})` : ""));
    const waited = Math.max(...rolls.map((r) => r.waitingMs || 0));
    label.className = "staged-label";
    label.textContent = `Waiting on ${names.join(", ")}${waited > 20000 ? ` · ${Math.round(waited / 1000)}s` : ""}`;
    label.title = `Dropped automatically after ${Math.round(Rolls.STALE_AFTER_MS / 1000)}s. The dice themselves are dismissed in TaleSpire's tray.`;
    box.appendChild(label);

    const drop = document.createElement("button");
    drop.className = "btn btn-small btn-ghost";
    drop.textContent = "Ignore";
    drop.title = "Stop waiting on these dice. Dismiss the dice themselves in TaleSpire's tray.";
    drop.onclick = () => {
      const n = Rolls.forgetAll();
      renderStaged();
      toast(n ? "Ignoring those dice — dismiss them in the tray." : "Nothing staged.");
    };
    box.appendChild(drop);
  }

  /** The riders a hit could take, from the sheet as it stands now. */
  function hitRiders(hit) {
    const s = state.sheet;
    if (!s) return [];
    const mine = s.play.turn?.mine;
    const slotLevels = [];
    for (const slot of s.spellcasting?.slots || []) {
      if (slot.available) slotLevels.push({ level: slot.level, left: slot.available - (s.play.slotsUsed[slot.level] || 0), kind: "slot" });
    }
    const pact = s.spellcasting?.pact;
    if (pact) slotLevels.push({ level: pact.level, left: pact.available - (s.play.pactUsed || 0), kind: "pact" });
    return ClassFx.ridersFor(
      { spells: allSpells(s), features: s.features, identity: s.identity },
      { ...hit, concentration: s.play.concentration?.name || "", sneakUsed: Boolean(mine?.sneak) && Boolean(turnQueue?.items?.length), slotLevels },
      (sp, level) => DDB.upcastRolls(sp, level).damage
    );
  }

  function renderPending() {
    const box = $("pending-damage");
    box.replaceChildren();
    box.classList.toggle("hidden", state.pending.length === 0);

    for (const entry of state.pending) {
      const card = document.createElement("div");
      card.className = "pending-card card";
      const row = document.createElement("div");
      row.className = "pending-row";

      const label = document.createElement("span");
      label.className = "pending-label";
      label.innerHTML = `<b>Hit!</b> ${escapeHtml(entry.name)} rolled ${entry.total}${entry.crit ? " · <b>CRIT</b>" : ""}`;
      row.appendChild(label);

      const dmg = ClassFx.withRiders(entry.damage, entry.riders || []);
      if (entry.crit) {
        row.appendChild(
          button(`Crit ${Rolls.critical(dmg)}`, "btn-gold is-fill", (mode) => rollPending(entry, true, mode))
        );
      }
      row.appendChild(
        button(`Damage ${dmg}`, entry.crit ? "btn-gold" : "btn-gold is-fill", (mode) => rollPending(entry, false, mode))
      );

      const dismiss = document.createElement("button");
      dismiss.className = "btn btn-small btn-ghost";
      dismiss.textContent = "Miss";
      dismiss.onclick = () => {
        state.pending = state.pending.filter((e) => e !== entry);
        renderPending();
      };
      row.appendChild(dismiss);
      card.appendChild(row);

      if (entry.riders?.length) {
        const riders = document.createElement("div");
        riders.className = "riders";
        for (const r of entry.riders) riders.appendChild(riderChip(entry, r));
        card.appendChild(riders);
      }
      box.appendChild(card);
    }
  }

  /** One rider: tap to add it to the damage; a smite also picks its slot level. */
  function riderChip(entry, r) {
    const wrap = document.createElement("span");
    wrap.className = "rider";
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `rider-chip${r.on ? " is-on" : ""}`;
    chip.disabled = Boolean(r.disabled);
    chip.setAttribute("aria-pressed", r.on ? "true" : "false");
    chip.innerHTML = `${r.on ? "✓" : "+"} ${escapeHtml(r.name)} <b>${escapeHtml(r.dice || "")}</b>` +
      (r.note ? ` <small>${escapeHtml(r.note)}</small>` : "");
    chip.title = r.kind === "smite"
      ? `Cast ${r.name} with this hit; the slot is spent when you roll damage`
      : r.kind === "sneak" ? "Once per turn, with advantage or an ally beside the target" : "";
    chip.onclick = () => {
      r.on = !r.on;
      renderPending();
    };
    wrap.appendChild(chip);

    if (r.kind === "smite" && r.levels.length > 1) {
      const pick = document.createElement("select");
      pick.className = "rider-level";
      pick.setAttribute("aria-label", `${r.name} slot level`);
      for (const o of r.levels) {
        const opt = document.createElement("option");
        opt.value = `${o.kind}:${o.level}`;
        opt.textContent = `${o.kind === "pact" ? "Pact " : "L"}${o.level} (${o.left})`;
        opt.disabled = o.left <= 0;
        pick.appendChild(opt);
      }
      pick.value = `${r.slotKind}:${r.level}`;
      pick.onchange = () => {
        const [kind, lvl] = pick.value.split(":");
        r.slotKind = kind;
        r.level = Number(lvl);
        r.dice = DDB.upcastRolls(r.spell, r.level).damage || r.dice;
        r.on = true;
        renderPending();
      };
      wrap.appendChild(pick);
    }
    return wrap;
  }

  async function rollPending(entry, crit, mode) {
    state.pending = state.pending.filter((e) => e !== entry);
    renderPending();
    const riders = (entry.riders || []).filter((r) => r.on && !r.disabled);
    // Pay for what was added: a smite's slot, Sneak Attack's once per turn
    for (const r of riders) {
      if (r.kind === "smite") await castSpell(r.spell, r.level, r.slotKind);
      if (r.kind === "sneak" && turnQueue?.items?.length) {
        ensureMine().sneak = true;
        savePlay();
      }
    }
    const added = riders.map((r) => r.name);
    const twice = (expr) => (crit ? Rolls.critical(expr) : expr);
    // Each rider is its own typed group, so resistances apply per type
    const riderType = (r) =>
      r.kind === "sneak" ? entry.damageType : Damage.typeOf(r.note) || (r.kind === "always" ? "radiant" : null);
    await doRoll({
      name: `${entry.name} damage${crit ? " (crit)" : ""}${added.length ? ` + ${added.join(", ")}` : ""}`,
      damage: twice(entry.damage),
      damageType: entry.damageType || null,
      extraDamage: riders.filter((r) => r.dice).map((r) => ({ name: r.name, roll: twice(r.dice), type: riderType(r) })),
      mode,
      kind: "damage",
    });
  }

  // -------------------------------------------------------------------------
  // Conditions
  //
  // TaleSpire minis have no condition concept — `creatureInfo` exposes hp, stats,
  // flying, hidden and a list of persistent emote ids, and nothing writable. So
  // conditions live here. The import seeds them; after that the table owns them.
  // -------------------------------------------------------------------------

  const CONDITION_NAMES = [
    "Blinded", "Charmed", "Deafened", "Exhaustion", "Frightened", "Grappled",
    "Incapacitated", "Invisible", "Paralyzed", "Petrified", "Poisoned", "Prone",
    "Restrained", "Stunned", "Unconscious", "Concentrating", "Dodging", "Hidden",
  ];

  function renderConditions() {
    const play = state.sheet.play;
    const box = $("conditions");
    box.replaceChildren();


    for (const c of play.conditions) {
      const chip = document.createElement("span");
      chip.className = "condition";

      const label = document.createElement("span");
      label.textContent = c.level ? `${c.name} ${c.level}` : c.name;
      const help = DDB.conditionHelp(c.name, c.level);
      if (help) {
        label.className = "condition-name";
        label.title = conditionTooltip(c.name, help);
      }
      chip.appendChild(label);

      // Exhaustion is the one condition with levels, so it gets steppers.
      if (c.name === "Exhaustion") {
        const down = document.createElement("button");
        down.className = "chip-btn";
        down.textContent = "−";
        down.title = "Lower a level";
        down.onclick = () => {
          c.level = Math.max(1, (c.level || 1) - 1);
          renderConditions();
          savePlay();
        };
        const up = document.createElement("button");
        up.className = "chip-btn";
        up.textContent = "+";
        up.title = "Raise a level";
        up.onclick = () => {
          c.level = Math.min(6, (c.level || 1) + 1);
          renderConditions();
          savePlay();
        };
        chip.append(down, up);
      }

      const remove = document.createElement("button");
      remove.className = "chip-btn";
      remove.textContent = "×";
      remove.title = "Remove";
      remove.onclick = () => removeCondition(c);

      chip.appendChild(remove);
      box.appendChild(chip);
    }

    // Keep the picker to conditions not already applied.
    const pick = $("condition-pick");
    const current = new Set(play.conditions.map((c) => c.name));
    pick.replaceChildren();
    const label = document.createElement("option");
    label.value = "";
    label.textContent = "+ Condition";
    pick.appendChild(label);
    for (const name of CONDITION_NAMES) {
      if (current.has(name)) continue;
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      pick.appendChild(opt);
    }
    pick.value = "";
    $("condition-add").disabled = pick.options.length === 0;

    renderConditionEffects();
    renderConditionPreview();
  }

  /** Full rules for the hover, with the line that affects you put first. */
  function conditionTooltip(name, help) {
    return [name.toUpperCase(), "", ...help.rules.map((r) => `• ${r}`)].join("\n");
  }

  /**
   * What the active conditions do to *you*, spelled out under the chips.
   *
   * The panel deliberately doesn't fold these into rolls — a rules engine that
   * silently applies Disadvantage is worse than one that reminds you to hold
   * Ctrl — so the reminder has to be visible without hovering anything.
   */
  function renderConditionEffects() {
    const list = $("condition-effects");
    list.replaceChildren();

    for (const c of state.sheet.play.conditions) {
      const help = DDB.conditionHelp(c.name, c.level);
      if (!help) continue;
      const li = document.createElement("li");
      li.innerHTML =
        `<b>${escapeHtml(c.level ? `${c.name} ${c.level}` : c.name)}</b> ` +
        `<span>${escapeHtml(help.self)}</span>`;
      li.title = conditionTooltip(c.name, help);
      list.appendChild(li);
    }
  }

  /** Say what a condition does before it is added, not after. */
  function renderConditionPreview() {
    const el = $("condition-preview");
    const pick = $("condition-pick");
    const help = pick.value ? DDB.conditionHelp(pick.value) : null;
    // Named, because this sits directly above the list of conditions you already
    // have and would otherwise read as one of them.
    el.textContent = help ? `${pick.value}: ${help.self}` : "";
    el.title = help ? conditionTooltip(pick.value, help) : "";
  }

  async function removeCondition(c) {
    const play = state.sheet.play;
    play.conditions = play.conditions.filter((x) => x !== c);
    renderConditions();
    savePlay();
    pushConditionToBoard(c.name, false);
    await announce(`is no longer ${Rolls.bold(c.name)}`);
  }

  async function addCondition(name) {
    const play = state.sheet.play;
    if (!name || play.conditions.some((c) => c.name === name)) return;
    play.conditions.push({ name, level: name === "Exhaustion" ? 1 : null });
    renderConditions();
    savePlay();
    pushConditionToBoard(name, true);
    await announce(`is ${Rolls.bold(name)}`);
  }

  /**
   * Put a condition's paired TaleSpire status on this character's mini, or
   * take it off. Only conditions the GM has paired with a status can reach the
   * board; the rest stay in the panel as before. A player's panel can't write
   * to the board, so it asks the GM's bridge over sync.
   */
  function pushConditionToBoard(name, on) {
    const emoteId = Statuses.emoteFor(name);
    if (!emoteId || !state.creatureId) return;
    if (Bridge.canWrite()) {
      Bridge.setEmote(state.creatureId, emoteId, on).then((r) => {
        if (!r.ok) toast(`Couldn't ${on ? "set" : "clear"} ${name} on the mini (${r.error}).`, true);
      });
    } else {
      Party.condition(state.creatureId, emoteId, on).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Initiative
  //
  // `TS.initiative` is read-only — getQueue() and nothing else — so a rolled
  // initiative can't be written into TaleSpire's tracker. We roll it properly,
  // post it to chat, and read the queue back to show whose turn it is.
  // -------------------------------------------------------------------------

  async function rollInitiative(mode) {
    const s = state.sheet;
    await doRoll({
      name: "Initiative",
      roll: `d20${DDB.signed(s.initiative)}`,
      mode,
      kind: "check", // buffs that apply to checks apply here too
      initiativeFor: state.creatureId ? { id: state.creatureId, dex: s.abilities?.dex?.score ?? null } : null,
    });
  }

  // --- initiative into TaleSpire's order --------------------------------------
  //
  // TaleSpire's initiative is an order of minis with no numbers, so the GM's
  // panel keeps the numbers rolled this fight and, through the bridge, sorts
  // TaleSpire's order by them: highest first, ties to the higher Dexterity.
  // Minis already in the order without a number keep their places after.

  const initValues = new Map(); // creature id -> { value, dex }

  async function placeInInitiative(entries) {
    if (!state.isGM || !Bridge.canWrite()) return;
    for (const e of entries) if (e?.id && Number.isFinite(e.value)) initValues.set(e.id, { value: e.value, dex: e.dex ?? 0 });
    const now = await Bridge.initiative();
    if (!now) return;
    const ids = now.items.filter((i) => i.kind === "creature").map((i) => i.id);
    for (const e of entries) if (e?.id && !ids.includes(e.id)) ids.push(e.id);
    const ranked = ids.filter((id) => initValues.has(id)).sort((a, b) => {
      const x = initValues.get(a);
      const y = initValues.get(b);
      return y.value - x.value || (y.dex ?? 0) - (x.dex ?? 0);
    });
    const unranked = ids.filter((id) => !initValues.has(id));
    const r = await Bridge.setInitiative([...ranked, ...unranked]);
    if (!r.ok) return toast(`Couldn't update TaleSpire's initiative (${r.error}).`, true);
    refreshInitiative();
  }

  /** A new fight starts from nothing: forget last fight's numbers when initiative ends. */
  function clearInitiativeValues() {
    initValues.clear();
  }

  /** Roll initiative for every linked monster in the fight, one throw, and place them. */
  async function rollMonsterInitiative() {
    const enc = Encounters.current;
    const rows = (enc?.combatants || []).filter((c) => c.creatureId && !initValues.has(c.creatureId));
    if (!rows.length) return toast("Every linked monster already has initiative (link minis to roll for them).");
    const groupIds = {};
    const groups = [];
    for (const c of rows) {
      let dex = 0;
      let score = 10;
      try {
        const m = c.cached || (await Monsters.get(c.slug));
        dex = m?.abilities?.dex?.mod ?? 0;
        score = m?.abilities?.dex?.score ?? 10;
      } catch {
        /* +0 */
      }
      const name = `${c.label}: initiative`;
      groupIds[name] = { id: c.creatureId, dex: score };
      groups.push({ name, roll: `d20${DDB.signed(dex)}` });
    }
    try {
      await Rolls.stage({ name: "Monster initiative", groups, context: { kind: "initiativeGroup", groupIds } });
      renderStaged();
    } catch (e) {
      toast(e.message, true);
    }
  }

  /**
   * TaleSpire owns the turn queue; `getQueue` is read-only and there is no
   * writer. Two places show it — the character sheet's initiative line and the
   * GM's encounter tracker — and for a while two functions of this name existed,
   * one per consumer. The later declaration silently replaced the earlier, so
   * the encounter tracker never received a queue unless an `initiativeUpdated`
   * event happened to arrive. One function now feeds both.
   */
  async function refreshInitiative() {
    let queue = null;
    try {
      const result = await TS.initiative.getQueue();
      if (failed(result)) console.warn("[Spirekeeper] getQueue failed:", result.cause);
      else queue = result;
    } catch (e) {
      console.warn("[Spirekeeper] getQueue threw:", e.message);
    }

    renderInitiative(queue);
    Encounters.setQueue(queue);
    return queue;
  }

  function renderInitiative(queue) {
    onTurnQueue(queue);
    const el = $("init-queue");

    if (!queue || !queue.items?.length) {
      el.textContent = "Not in initiative";
      el.classList.remove("is-turn");
      renderCombatCard();
      return;
    }

    const active = queue.items[queue.activeItemIndex];
    const meId = myQueueId(queue);
    const mine = meId
      ? queue.items.findIndex((i) => i.id === meId)
      : -1;

    const round = turnSeen?.round ? `<b>Round ${turnSeen.round}</b> ` : "";
    if (mine >= 0 && mine === queue.activeItemIndex) {
      el.innerHTML = `${round}<span class="badge">your turn</span>`;
      el.classList.add("is-turn");
    } else {
      el.classList.remove("is-turn");
      const position = mine >= 0 ? ` · you're ${mine + 1}/${queue.items.length}` : "";
      el.innerHTML = `${round}<span class="status">${escapeHtml(active?.name || "—")}'s turn${position}</span>`;
    }
    renderCombatCard();
  }

  function renderBindBar() {
    const status = $("bind-status");
    const btn = $("bind-btn");

    if (state.creatureId) {
      status.textContent = "linked";
      status.title = "Linked to a mini: rolls post as this character";
      status.classList.add("is-bound");
      btn.textContent = "unlink";
      btn.onclick = async () => {
        await Store.unbind(state.creatureId);
        state.creatureId = null;
        renderBindBar();
      };
    } else {
      status.textContent = state.selection.length ? "A mini is selected" : "No mini linked";
      status.title = "";
      status.classList.remove("is-bound");
      btn.textContent = state.selection.length ? "link it" : "link selected mini";
      btn.onclick = bindSelected;
    }
  }

  async function bindSelected() {
    const selected = await TS.creatures.getSelectedCreatures();
    if (failed(selected) || !selected.length) return toast("Select a mini on the board first.", true);
    if (selected.length > 1) return toast("Select exactly one mini.", true);

    await Store.bind(selected[0].id, state.sheetId);
    state.creatureId = selected[0].id;
    lastBoardVitals = null;
    renderBindBar();
    reportVitals();
    followLinkedMini();
    toast("Mini linked.");
  }

  // --- actions -------------------------------------------------------------

  /** A crit doubles the dice, not the modifier: 1d8+3 becomes 2d8+3. */
  const critOf = (roll) => String(roll || "").replace(/(\d*)d(\d+)/g, (_, n, d) => `${(parseInt(n || "1", 10)) * 2}d${d}`);

  function sectionTitle(text, extra) {
    const h = document.createElement("h2");
    h.className = "sec-title";
    h.textContent = text;
    if (extra) h.appendChild(extra);
    return h;
  }

  function renderAttacks(s) {
    const box = $("attacks");
    box.replaceChildren();
    box.appendChild(sectionTitle("Attacks"));

    if (!s.attacks.length) {
      box.insertAdjacentHTML("beforeend", '<p class="hint">No weapons on this sheet.</p>');
      return;
    }

    for (const raw of s.attacks) {
      const a = applyWeaponEffects(raw);
      const card = document.createElement("div");
      card.className = "card attack-card";
      const notes = [
        a.equipped ? null : "not equipped",
        a.proficient ? null : "not proficient",
      ].filter(Boolean);
      // "5/5 ft." is how D&D Beyond writes plain melee reach
      const where = String(a.range || (a.kind === "melee" ? `${(a.properties || []).includes("Reach") ? 10 : 5} ft` : ""))
        .replace(/^(\d+)\/\1 ft\.?$/, "$1 ft").replace(/ ft\.$/, " ft");
      card.innerHTML =
        `<div class="attack-top"><b>${escapeHtml(a.name)}</b>` +
        (a.modifiedBy.length ? `<span class="tag" title="${escapeHtml(a.modifiedBy.join(", "))}">✦ ${escapeHtml(a.modifiedBy[0])}</span>` : "") +
        `<span class="attack-sub">${escapeHtml([a.damageType ? a.damageType.toLowerCase() : null, where].filter(Boolean).join(" · "))}</span></div>` +
        (notes.length ? `<div class="attack-note">${escapeHtml(notes.join(" · "))}</div>` : "");

      const tiles = document.createElement("div");
      tiles.className = "attack-tiles";
      // To hit rolls the attack. Damage waits for the hit to be called (see
      // renderPending), so its tiles are for reading, not clicking.
      const hit = document.createElement("button");
      hit.className = "roll-tile is-roll";
      hit.title = `Roll ${a.name} to hit. Shift-click for advantage, Ctrl-click for disadvantage.`;
      hit.innerHTML = `<span>To hit</span><b>${escapeHtml(DDB.signed(a.toHit))}</b>`;
      hit.onclick = (ev) =>
        doRoll({
          name: a.name, roll: a.attackRoll, mode: modeFromEvent(ev), kind: "attack", damage: null, parkedDamage: a.damageRoll,
          parkedType: Damage.typeOf(a.damageType),
          hit: { weapon: true, melee: a.kind === "melee", finesse: (a.properties || []).includes("Finesse") },
        });
      const dmg = document.createElement("div");
      dmg.className = "roll-tile";
      dmg.title = "Rolled once the hit is called";
      dmg.innerHTML = `<span>Damage</span><b>${escapeHtml(a.damageRoll || "—")}</b>`;
      const crit = document.createElement("div");
      crit.className = "roll-tile is-crit";
      crit.title = "On a critical hit the dice double";
      crit.innerHTML = `<span>Crit</span><b>${escapeHtml(critOf(a.damageRoll) || "—")}</b>`;
      tiles.append(hit, dmg, crit);
      card.appendChild(tiles);

      // Against the picked target: in reach, in range, long range or out
      const t = state.target;
      const verdict = t ? Range.attackAt(a, t.distance, { enemyAdjacent: Boolean(t.enemyAdjacent) && a.kind !== "melee" }) : null;
      if (verdict) {
        const line = document.createElement("div");
        line.className = `attack-range${verdict.ok ? "" : " is-out"}${verdict.disadvantage ? " is-disadv" : ""}`;
        line.textContent = `${t.name} ${t.distance} ft: ${verdict.text}`;
        card.appendChild(line);
      }
      box.appendChild(card);
    }
  }

  function renderResources(s) {
    const box = $("resources");
    box.replaceChildren();
    if (!s.resources.length && !s.choiceActions?.length) return;

    box.appendChild(sectionTitle("Class features"));
    const card = document.createElement("div");
    card.className = "card feature-card";
    for (const r of s.resources) card.appendChild(resourceRow(s, r));
    // Choices that cost nothing to pick, so they get no counter, just the menu
    for (const a of s.choiceActions || []) card.appendChild(featureRow(a, null));
    box.appendChild(card);
  }

  // Which feature rows are open, by name, so a re-render keeps them open
  const openFeatures = new Set();

  /** Pips for uses left, drawn rather than typed: ●●○ reads at a glance. */
  function pips(left, max) {
    const el = document.createElement("span");
    el.className = "pips";
    el.setAttribute("aria-label", `${left} of ${max} left`);
    if (max > 8) {
      el.textContent = "";
      return el;
    }
    for (let i = 0; i < max; i += 1) {
      const dot = document.createElement("i");
      if (i >= left) dot.className = "is-used";
      el.appendChild(dot);
    }
    return el;
  }

  /** A limited-use feature: name, pips, Use. Its options and text open on tap. */
  function resourceRow(s, r) {
    if (ClassFx.isPool(r)) return poolRow(s, r);
    const used = s.play.resourcesUsed[r.name] || 0;
    const left = r.max - used;
    const spend = () => {
      s.play.resourcesUsed[r.name] = used + 1;
      renderResources(s);
      savePlay();
    };
    const row = featureRow(r, spend, left);
    const head = row.querySelector(".feature-head");
    const count = document.createElement("span");
    count.className = "feature-count";
    count.textContent = `${left}/${r.max}`;
    count.title = `Back on a ${r.resetsOn}`;
    head.insertBefore(count, head.querySelector(".feature-use"));
    head.insertBefore(pips(left, r.max), count);

    const undo = document.createElement("button");
    undo.className = "link-btn";
    undo.textContent = "give one back";
    undo.disabled = used <= 0;
    undo.onclick = () => {
      s.play.resourcesUsed[r.name] = Math.max(0, used - 1);
      renderResources(s);
      savePlay();
    };
    const foot = row.querySelector(".feature-foot");
    foot.insertAdjacentHTML("afterbegin", `<span class="hint">Back on a ${escapeHtml(r.resetsOn)}.</span>`);
    foot.appendChild(undo);
    return row;
  }

  /**
   * A pool spent in amounts: Lay on Hands, Sorcery Points. Type how many and
   * spend them; Lay on Hands heals that much, you if no one else is targeted.
   */
  function poolRow(s, r) {
    const used = s.play.resourcesUsed[r.name] || 0;
    const left = Math.max(0, r.max - used);
    const heals = ClassFx.poolHeals(r);
    const row = document.createElement("div");
    row.className = "feature is-pool";
    const open = openFeatures.has(r.name);
    row.classList.toggle("is-open", open);

    const head = document.createElement("div");
    head.className = "feature-head";
    const name = document.createElement("button");
    name.className = "feature-name";
    name.innerHTML = `<b>${escapeHtml(r.name)}</b><small>${escapeHtml(firstSentence(r.description))}</small>`;
    name.onclick = () => {
      if (openFeatures.has(r.name)) openFeatures.delete(r.name);
      else openFeatures.add(r.name);
      renderResources(s);
    };
    const count = document.createElement("span");
    count.className = "feature-count";
    count.innerHTML = `<b>${left}</b>/${r.max}`;
    count.title = `Back on a ${r.resetsOn}`;
    const amount = document.createElement("input");
    amount.type = "number";
    amount.min = "1";
    amount.max = String(left);
    amount.placeholder = "pts";
    amount.className = "pool-amount";
    amount.setAttribute("aria-label", `${r.name}: how many`);
    const go = document.createElement("button");
    go.className = "btn btn-small btn-gold feature-use";
    go.textContent = heals ? "Heal" : "Spend";
    go.disabled = left <= 0;
    go.onclick = () => undoable(`${heals ? "used" : "spent"} ${r.name}`, async () => {
      const n = parseInt(amount.value, 10);
      if (!Number.isFinite(n) || n <= 0) return toast(`How many ${heals ? "hit points" : "points"}?`, true);
      if (n > left) return toast(`Only ${left} left in ${r.name}.`, true);
      s.play.resourcesUsed[r.name] = used + n;
      savePlay();
      renderResources(s);
      const target = state.target && state.target.id !== state.creatureId ? state.target : null;
      if (heals) {
        await announce(`uses ${Rolls.bold(r.name)}: restores ${n} HP${target ? ` to ${escapeText(target.name)}` : ""}`);
        if (!target) {
          applyHp(n);
          toast(`Healed yourself ${n}. Pick a target first to heal someone else.`);
        }
      } else {
        await announce(`spends ${n} ${Rolls.bold(r.name)}`);
      }
    });
    amount.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go.click();
    });
    head.append(name, count, amount, go);
    row.appendChild(head);

    if (open) {
      const body = document.createElement("p");
      body.className = "option-detail feature-body";
      body.textContent = r.description || "";
      row.appendChild(body);
      const foot = document.createElement("div");
      foot.className = "feature-foot";
      foot.innerHTML = `<span class="hint">Back on a ${escapeHtml(r.resetsOn)}.</span>`;
      const back = document.createElement("button");
      back.className = "link-btn";
      back.textContent = "refill";
      back.disabled = used <= 0;
      back.onclick = () => {
        s.play.resourcesUsed[r.name] = 0;
        renderResources(s);
        savePlay();
      };
      foot.appendChild(back);
      row.appendChild(foot);
    }
    return row;
  }

  /**
   * One feature row. With options (Channel Divinity), Use opens the row so
   * you pick which one; without, it's spent straight away.
   */
  function featureRow(owner, spend, left = Infinity) {
    const row = document.createElement("div");
    row.className = "feature";
    const open = openFeatures.has(owner.name);
    row.classList.toggle("is-open", open);
    const options = owner.options || [];

    const head = document.createElement("div");
    head.className = "feature-head";
    const name = document.createElement("button");
    name.className = "feature-name";
    name.setAttribute("aria-expanded", open ? "true" : "false");
    name.innerHTML = `<b>${escapeHtml(owner.name)}</b>` +
      `<small>${escapeHtml(options.length ? options.map((o) => o.name).join(" · ") : firstSentence(owner.description))}</small>`;
    const toggle = () => {
      if (openFeatures.has(owner.name)) openFeatures.delete(owner.name);
      else openFeatures.add(owner.name);
      renderResources(state.sheet);
    };
    name.onclick = toggle;
    head.appendChild(name);

    const use = document.createElement("button");
    use.className = "btn btn-small btn-gold feature-use";
    use.textContent = spend ? "Use" : "Announce";
    use.disabled = spend ? left <= 0 : false;
    head.appendChild(use);
    row.appendChild(head);

    // The option picker and description; its own button is driven from the head
    const body = optionRow(owner, spend, left);
    body.classList.add("feature-body");
    const bodyUse = body.querySelector(":scope > button");
    bodyUse?.classList.add("hidden");
    use.onclick = () => {
      // With options (Channel Divinity), the first press opens the row to pick one
      if (options.length && !openFeatures.has(owner.name)) return toggle();
      bodyUse?.click();
    };
    row.appendChild(body);
    const foot = document.createElement("div");
    foot.className = "feature-foot";
    row.appendChild(foot);
    if (!open) {
      body.classList.add("hidden");
      foot.classList.add("hidden");
    }
    return row;
  }

  const firstSentence = (text) => {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    const m = /^(.{0,90}?[.!?])(\s|$)/.exec(t);
    return m ? m[1] : t.length > 90 ? `${t.slice(0, 88)}…` : t;
  };

  /**
   * The choice menu shared by limited-use resources and free options.
   * `spend` is null for things that cost nothing.
   */
  // The option last picked for each feature, so spending a use doesn't reset it
  const chosenOptions = new Map();

  function optionRow(owner, spend, left = Infinity) {
    const box = document.createElement("div");
    box.className = "option-row";

    const options = owner.options || [];
    let selected = options[chosenOptions.get(owner.name) || 0] || options[0] || null;

    const detail = document.createElement("p");
    detail.className = "option-detail";

    // An option with an area gets a Zone button, like a spell's
    const extras = document.createElement("div");
    extras.className = "option-extras";
    function drawExtras() {
      extras.replaceChildren();
      const subject = selected || owner;
      const area = ClassFx.areaOf(subject, Zones.areaOf);
      if (area) {
        const z = button(`◇ Zone ${Zones.describeArea(area)}`, "btn-ghost", () =>
          Zones.cast({ name: subject.name, aoe: `${area.size} ft. ${area.shape}`, description: "" }));
        z.title = "Place TaleSpire's ruler for this area and see who's inside";
        extras.appendChild(z);
      }
      const lasts = ClassFx.lastsOf(subject);
      if (lasts) {
        const note = document.createElement("span");
        note.className = "hint";
        note.textContent = `Using it starts a ${Turns.LASTS[lasts].label.toLowerCase()} timer.`;
        extras.appendChild(note);
      }
    }

    function describe() {
      drawExtras();
      if (!selected) {
        detail.textContent = owner.description || "";
        return;
      }
      const bits = [
        selected.save ? `${selected.save.ability} save DC ${selected.save.dc}` : null,
        selected.roll,
        selected.activation,
      ].filter(Boolean);
      detail.textContent = `${bits.join(" · ")}${bits.length ? " — " : ""}${selected.description || ""}`;
    }

    if (options.length) {
      const pick = document.createElement("select");
      pick.className = "option-pick";
      pick.setAttribute("aria-label", `${owner.name} option`);
      for (const [i, o] of options.entries()) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = o.name + (o.roll ? ` (${o.roll})` : "");
        pick.appendChild(opt);
      }
      pick.value = String(Math.max(0, options.indexOf(selected)));
      pick.onchange = () => {
        selected = options[Number(pick.value)];
        chosenOptions.set(owner.name, Number(pick.value));
        describe();
      };
      box.appendChild(pick);
    }

    const use = document.createElement("button");
    use.className = "btn btn-small";
    use.textContent = spend ? "Use" : "Announce";
    use.disabled = spend ? left <= 0 : false;
    use.onclick = () => undoable(`used ${selected ? `${owner.name}: ${selected.name}` : owner.name}`, async () => {
      if (spend) spend();

      const label = selected ? `${owner.name}: ${selected.name}` : owner.name;
      const save = selected?.save ? ` — ${selected.save.ability} save DC ${selected.save.dc}` : "";
      await announce(`uses ${Rolls.bold(label)}${save}`);

      // An option that runs for a while gets a timed effect, so it ends itself
      const lasts = ClassFx.lastsOf(selected || owner);
      if (lasts) {
        const area = ClassFx.areaOf(selected || owner, Zones.areaOf);
        addEffect({
          name: selected ? selected.name : owner.name,
          bonus: "+0",
          targets: [],
          lasts,
          recur: ClassFx.recurOf(selected || owner, recurContext()),
          note: [area ? Zones.describeArea(area) : null, selected?.save ? `${selected.save.ability.slice(0, 3).toUpperCase()} DC ${selected.save.dc}` : null].filter(Boolean).join(" · "),
        });
      }

      // Roll whatever the chosen option actually rolls.
      if (selected?.roll) {
        // Not necessarily damage — Divine Spark's 1d8 is a heal or a hit depending
        // on which half of the feature you used — so the roll carries its own name.
        await doRoll({ name: label, damage: selected.roll, damageName: label, kind: "damage" });
      }
    });
    box.appendChild(use);

    describe();
    box.append(detail, extras);
    return box;
  }

  // --- spells --------------------------------------------------------------

  /**
   * Fill in spells a feature grants that D&D Beyond never exported.
   *
   * `spellcasting.granted` holds names and nothing else, because the names are
   * all the character payload contains. The details come from the bundled 2024
   * SRD. Resolved once per sheet and cached, so the Spells tab stays synchronous.
   */
  async function fillGrantedSpells(s) {
    const wanted = s.spellcasting?.granted || [];
    if (!wanted.length || state.granted) return;

    const filled = [];
    for (const g of wanted) {
      let rec = null;
      try {
        rec = await Spells.find(g.name);
      } catch (e) {
        console.error("[Spirekeeper] bundled spells unavailable", e);
        return; // no bundle, no fill — leave the list alone rather than half-render
      }
      // A granted spell is cast with the granting class's ability, which is what
      // decides whether it heals for its dice or its dice plus a modifier.
      const block = s.spellcasting.blocks.find((b) => b.className === g.className);
      const abilityMod = block?.ability ? s.abilities[block.ability]?.mod || 0 : 0;

      filled.push({
        ...g,
        spell: rec
          ? Spells.toSheetSpell(rec, { characterLevel: s.identity?.level || 1, abilityMod })
          : null,
      });
    }

    state.granted = filled;
    renderSpells(s);
  }

  function renderSpells(s) {
    renderSlots(s);

    const box = $("spells");
    box.replaceChildren();

    if ((s.spellcasting?.granted || []).length && !state.granted) fillGrantedSpells(s);

    const many = s.spellcasting.blocks.length > 1;
    for (const block of s.spellcasting.blocks) {
      // One caster: the class is implied and the DC sits with the slots. Several:
      // each block says whose it is and its own numbers.
      if (many || !block.ability) {
        const head = sectionTitle(block.ability
          ? `${block.className} · DC ${block.saveDc} · ${DDB.signed(block.attackBonus)}`
          : block.className);
        head.classList.add("spell-block");
        box.appendChild(head);
      }

      const byLevel = {};
      for (const sp of block.spells) (byLevel[sp.level] ||= []).push(sp);

      for (const lvl of Object.keys(byLevel).sort((a, b) => a - b)) {
        box.appendChild(sectionTitle(lvl === "0" ? "Cantrips" : `Level ${lvl}`));
        const list = document.createElement("div");
        list.className = "card spell-list";
        for (const sp of byLevel[lvl]) list.appendChild(spellCard(sp, block));
        box.appendChild(list);
      }
    }

    renderGrantedSpells(s, box);
  }

  /**
   * Spells a subclass grants, grouped under the feature that grants them.
   *
   * These are always prepared and cost no preparation, so they sit apart from
   * the imported list rather than inside it — and the heading says where the
   * details came from, because it was not D&D Beyond.
   */
  function renderGrantedSpells(s, box) {
    const filled = state.granted || [];
    if (!filled.length) return;

    const bySource = new Map();
    for (const g of filled) {
      if (!bySource.has(g.source)) bySource.set(g.source, []);
      bySource.get(g.source).push(g);
    }

    for (const [source, entries] of bySource) {
      const block =
        s.spellcasting.blocks.find((b) => b.className === entries[0].className) || s.spellcasting.blocks[0];

      const head = sectionTitle(`${source} · always prepared`);
      head.title =
        "D&D Beyond names these in your subclass but doesn't include them in its export, " +
        "so the details come from the bundled 2024 SRD.";
      box.appendChild(head);
      const list = document.createElement("div");
      list.className = "card spell-list";
      box.appendChild(list);

      for (const g of entries.sort((a, b) => (a.spell?.level ?? 9) - (b.spell?.level ?? 9))) {
        if (!g.spell) {
          const miss = document.createElement("div");
          miss.className = "hint dimmed";
          miss.textContent = `${titleCase(g.name)}: granted at level ${g.atLevel}, not in the bundled SRD.`;
          list.appendChild(miss);
          continue;
        }
        list.appendChild(spellCard(g.spell, block));
      }
    }
  }

  const titleCase = (t) =>
    String(t || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());

  /** Slot pips double as the tracker: click one to spend or give back. */
  function renderSlots(s) {
    const box = $("slots");
    box.replaceChildren();
    const caster = s.spellcasting.blocks.find((b) => b.ability);
    if (caster && s.spellcasting.blocks.filter((b) => b.ability).length === 1) {
      const dc = document.createElement("span");
      dc.className = "slot-dc";
      dc.innerHTML = `Save DC <b>${caster.saveDc}</b> · Attack <b>${escapeHtml(DDB.signed(caster.attackBonus))}</b>`;
      box.appendChild(dc);
    }

    for (const slot of s.spellcasting.slots) {
      if (!slot.available) continue;
      const used = s.play.slotsUsed[slot.level] || 0;
      box.appendChild(slotChip(`L${slot.level}`, slot.available, used, (n) => {
        s.play.slotsUsed[slot.level] = n;
      }));
    }

    const pact = s.spellcasting.pact;
    if (pact) {
      box.appendChild(
        slotChip(`Pact L${pact.level}`, pact.available, s.play.pactUsed || 0, (n) => {
          s.play.pactUsed = n;
        })
      );
    }

    renderSlotDerivation(s);
  }

  /**
   * Spell slots are the most-derived number on the sheet and the easiest to get
   * quietly wrong, so for a multiclass caster the panel shows its working rather
   * than asking you to trust it.
   */
  function renderSlotDerivation(s) {
    const note = $("slots-note");
    const d = s.spellcasting.derivation;
    note.replaceChildren();

    if (!d || d.contributions.length < 2) return;

    const parts = d.contributions.map((c) => {
      const who = c.subclass ? `${c.className} (${c.subclass})` : c.className;
      return `${who} ${c.level} → ${c.contributes}`;
    });

    note.textContent = `Caster level ${d.effectiveLevel}: ${parts.join(", ")}`;
    if (s.spellcasting.pact) {
      note.textContent += ". Warlock levels feed pact magic separately.";
    }
  }

  function slotChip(label, available, used, setUsed) {
    const left = available - used;
    const chip = document.createElement("button");
    chip.className = `slot${left === 0 ? " is-empty" : ""}`;
    chip.title = `${left} of ${available} left. Click to spend one, right-click to give one back.`;
    chip.innerHTML = `<span class="slot-label">${escapeHtml(label)}</span>`;
    chip.appendChild(pips(left, available));
    if (available > 8) chip.insertAdjacentHTML("beforeend", `<span class="slot-count">${left}/${available}</span>`);

    chip.onclick = () => {
      if (used >= available) return;
      undoable(`spent a ${label} slot`, () => {
        setUsed(used + 1);
        renderSlots(state.sheet);
        savePlay();
      });
    };
    chip.oncontextmenu = (ev) => {
      ev.preventDefault();
      if (used <= 0) return;
      undoable(`gave back a ${label} slot`, () => {
        setUsed(used - 1);
        renderSlots(state.sheet);
        savePlay();
      });
    };
    return chip;
  }

  /**
   * Free uses spent on spells that come with their own, keyed by spell name.
   *
   * Seeded by the store, but created on demand here too: a sheet imported before
   * spells could be tracked has play state without the map.
   */
  const spellUsesUsed = (play) => (play.spellUsesUsed ||= {});

  /** Every spell on the sheet, wherever it came from. */
  const allSpells = (s) => [
    ...(s.spellcasting?.blocks || []).flatMap((b) => b.spells),
    ...(state.granted || []).map((g) => g.spell).filter(Boolean),
  ];

  /** Ways this spell could be paid for, given what's left. */
  function castableLevels(s, spell) {
    const out = [];

    // A spell can arrive with its own uses and no need for a slot at all — Magic
    // Initiate grants Goodberry with one free cast per long rest. That use is
    // offered as another way to pay, alongside any slots, because a player with
    // slots to spare may want to keep the free one.
    if (spell.limitedUse) {
      const used = spellUsesUsed(s.play)[spell.name] || 0;
      out.push({ level: spell.level, left: spell.limitedUse.max - used, kind: "free" });
    }

    if (spell.level === 0) return out;

    for (const slot of s.spellcasting.slots) {
      if (slot.level < spell.level || !slot.available) continue;
      const left = slot.available - (s.play.slotsUsed[slot.level] || 0);
      out.push({ level: slot.level, left, kind: "slot" });
    }

    const pact = s.spellcasting.pact;
    if (pact && pact.level >= spell.level) {
      out.push({ level: pact.level, left: pact.available - (s.play.pactUsed || 0), kind: "pact" });
    }
    return out;
  }

  /** What a spell does in a few words, for its row: "conc. · WIS DC 13 · 20 ft cube · 1d8". */
  function spellSummary(sp, block) {
    const area = Zones.areaOf(sp);
    const dice = sp.damage?.[0]?.roll || sp.healing;
    return [
      sp.concentration ? "conc." : null,
      /bonus/i.test(sp.castingTime || "") ? "bonus action" : /reaction/i.test(sp.castingTime || "") ? "reaction" : null,
      sp.requiresSavingThrow && block?.saveDc ? `${String(sp.saveAbility || "").slice(0, 3).toUpperCase()} DC ${block.saveDc}`.trim() : null,
      sp.requiresAttackRoll && block?.attackBonus != null ? `${DDB.signed(block.attackBonus)} to hit` : null,
      area ? Zones.describeArea(area) : null,
      dice ? (sp.healing && !sp.damage?.length ? `${dice} healing` : dice) : null,
      sp.limitedUse ? "free use" : null,
    ].filter(Boolean).join(" · ");
  }

  // Which spells are open, so casting (which re-renders) keeps the roll buttons in view
  const openSpells = new Set();

  function spellCard(sp, block) {
    const card = document.createElement("div");
    card.className = "spell";

    const head = document.createElement("div");
    head.className = "spell-head";
    const name = document.createElement("button");
    name.className = "spell-name";
    name.innerHTML =
      `<span class="caret" aria-hidden="true">▸</span>` +
      `<span><b>${sp.prepared ? '<span class="prepared-dot" title="Prepared">●</span> ' : ""}${escapeHtml(sp.name)}</b>` +
      `<small>${escapeHtml(spellSummary(sp, block))}</small></span>`;
    head.appendChild(name);

    // Cast right from the row: the cheapest way to pay for it, which the open
    // card lets you change (upcasting, pact slot, free use)
    const options = castableLevels(state.sheet, sp);
    const first = options.find((o) => o.kind === "free" && o.left > 0) || options.find((o) => o.left > 0);
    const cast = document.createElement("button");
    cast.className = "btn btn-small btn-gold";
    cast.textContent = "Cast";
    if (sp.level === 0 || !options.length) {
      cast.title = "Say you cast it; the open card has the rolls";
      cast.onclick = async () => {
        await announce(`casts ${Rolls.bold(sp.name)}`);
        open(true);
      };
    } else {
      cast.disabled = !first;
      cast.title = first
        ? first.kind === "free" ? "Uses a free use" : first.kind === "pact" ? "Uses a pact slot" : `Uses a level ${first.level} slot`
        : "Nothing left to cast it with";
      cast.onclick = async () => {
        await castSpell(sp, first.level, first.kind);
        openSpells.add(sp.name);
        renderSpells(state.sheet); // slot counts and the next cheapest slot changed
      };
    }
    head.appendChild(cast);

    const body = document.createElement("div");
    body.className = "spell-body hidden";

    function open(show) {
      // Rebuild on open so slot counts and upcast dice are always current.
      body.replaceChildren();
      if (show) buildSpellBody(body, sp, block);
      body.classList.toggle("hidden", !show);
      card.classList.toggle("is-open", show);
      name.querySelector(".caret").textContent = show ? "▾" : "▸";
      if (show) openSpells.add(sp.name);
      else openSpells.delete(sp.name);
    }
    name.onclick = () => open(body.classList.contains("hidden"));

    card.append(head, body);
    if (openSpells.has(sp.name)) open(true);
    return card;
  }

  function buildSpellBody(body, sp, block) {
    const s = state.sheet;

    // How this spell is currently set to be paid for, and at what level.
    // Upcasting changes the dice, so everything below re-renders when it changes.
    let chosen = sp.level;
    let chosenKind = "slot";

    const meta = document.createElement("p");
    meta.className = "sp-meta";
    meta.textContent = [sp.castingTime, sp.range, sp.duration, sp.components].filter(Boolean).join(" · ");

    const desc = document.createElement("div");
    desc.className = "sp-desc";
    desc.textContent = sp.description || "";

    const levelRow = document.createElement("div");
    levelRow.className = "spell-levels";

    const actions = document.createElement("div");
    actions.className = "spell-actions";

    let options = castableLevels(s, sp);

    // Spend what the spell brought with it first — that's what it's for.
    if (options.some((o) => o.kind === "free" && o.left > 0)) chosenKind = "free";

    /**
     * Re-read what's left and redraw. Called after casting, so a free use that
     * was just spent shows as spent instead of inviting a second one.
     */
    function refresh() {
      options = castableLevels(s, sp);
      // Only the free use falls back: dropping to a slot of the spell's own level
      // is the same choice the card opens on. Never step up to a bigger slot on
      // the player's behalf — that would change the dice without being asked.
      if (chosenKind === "free" && !options.some((o) => o.kind === "free" && o.left > 0)) {
        chosen = sp.level;
        chosenKind = "slot";
      }
      drawLevels();
      drawActions();
    }

    function drawLevels() {
      levelRow.replaceChildren();
      if (!options.length) return;

      const caption = document.createElement("span");
      caption.className = "sp-tag";
      caption.textContent = sp.limitedUse ? "Cast using" : "Cast at";
      levelRow.appendChild(caption);

      for (const opt of options) {
        const b = document.createElement("button");
        b.className = `level-chip${chosen === opt.level && chosenKind === opt.kind ? " is-active" : ""}${opt.left <= 0 ? " is-empty" : ""}`;
        b.textContent =
          opt.kind === "free" ? `Free ${opt.left}/${sp.limitedUse.max}` :
          opt.kind === "pact" ? `Pact ${opt.level}` : `L${opt.level}`;
        b.title =
          opt.kind === "free"
            ? `${opt.left} left, back on a ${sp.limitedUse.resetsOn}`
            : `${opt.left} left`;
        b.onclick = () => {
          chosen = opt.level;
          chosenKind = opt.kind;
          drawLevels();
          drawActions();
        };
        levelRow.appendChild(b);
      }
    }

    function drawActions() {
      actions.replaceChildren();
      const rolls = DDB.upcastRolls(sp, chosen);

      if (sp.requiresAttackRoll && block.attackBonus != null) {
        const dmgHint = rolls.damage ? ` · ${rolls.damage}` : "";
        actions.appendChild(
          button(`Attack ${DDB.signed(block.attackBonus)}${dmgHint}`, "btn-gold is-fill", (mode) =>
            doRoll({
              name: sp.name,
              roll: `d20${DDB.signed(block.attackBonus)}`,
              mode,
              kind: "attack",
              parkedDamage: rolls.damage,
              parkedType: Damage.typeOf(sp.damage?.[0]?.type),
              hit: { spellAttack: true },
            })
          )
        );
      }

      if (sp.requiresSavingThrow && block.saveDc) {
        const ask = button(`Request ${String(sp.saveAbility || "").slice(0, 3).toUpperCase()} saves`, "btn-gold", () => requestSpellSaves(sp, block, chosen));
        ask.title = "Ask the creatures in this spell's zone (or the lassoed ones) to save. Players roll on their own panels and never see the DC.";
        actions.appendChild(ask);
        actions.appendChild(
          button(`Post DC ${block.saveDc}`, "btn-ghost", () =>
            announce(`casts ${Rolls.bold(sp.name)} — ${sp.saveAbility || ""} save DC ${block.saveDc}`.trim())
          )
        );
      }

      if (rolls.damage && !sp.requiresAttackRoll) {
        actions.appendChild(
          button(`Damage ${rolls.damage}`, "", (mode) =>
            doRoll({ name: sp.name, damage: rolls.damage, damageType: Damage.typeOf(sp.damage?.[0]?.type), mode, kind: "damage" })
          )
        );
      }

      if (rolls.healing) {
        actions.appendChild(
          button(`Heal ${rolls.healing}`, "", (mode) =>
            doRoll({ name: sp.name, damage: rolls.healing, damageName: `${sp.name} healing`, mode, kind: "healing" })
          )
        );
      }

      // Conditional variants are offered, never auto-selected: the panel can't
      // see whether the target is already hurt.
      for (const v of sp.variants || []) {
        actions.appendChild(
          button(`${v.roll} instead`, "", (mode) =>
            doRoll({ name: sp.name, damage: v.roll, mode, kind: "damage" })
          )
        ).title = `If ${v.when}`;
      }

      if (options.length) {
        const opt = options.find((o) => o.level === chosen && o.kind === chosenKind);
        const cast = button(
          opt?.kind === "free" ? `Cast (free use)` :
          opt?.kind === "pact" ? `Cast (pact slot)` : `Cast (uses L${chosen} slot)`,
          "btn-gold",
          async () => {
            await castSpell(sp, chosen, chosenKind);
            refresh();
          }
        );
        cast.disabled = !opt || opt.left <= 0;
        actions.appendChild(cast);
      }

      const area = Zones.areaOf(sp);
      if (area) {
        const z = button(`◇ Zone ${Zones.describeArea(area)}`, "btn-ghost", () => Zones.cast(sp));
        z.title = "Place TaleSpire's ruler for this spell's area and see who's inside";
        actions.appendChild(z);
      }

      actions.appendChild(button("Post to chat", "btn-ghost", () => announce(`casts ${Rolls.bold(sp.name)}`)));
    }

    drawLevels();
    drawActions();
    const parts = [meta, desc, levelRow, actions];
    const reachFt = Range.spellRangeFt(sp.range);
    const t = state.target;
    if (t?.distance != null && reachFt != null && reachFt > 0) {
      const line = document.createElement("p");
      const ok = t.distance <= reachFt;
      line.className = `attack-range${ok ? "" : " is-out"}`;
      line.textContent = `${t.name} is ${t.distance} ft away: ${ok ? "in range" : "out of range"} (${reachFt} ft)`;
      parts.splice(1, 0, line);
    }
    body.append(...parts);
  }

  /** Spend the slot or the use and say so. Rolling is separate — cast, then roll. */
  async function castSpell(sp, level, kind) {
    const s = state.sheet;

    if (kind === "free") {
      const uses = spellUsesUsed(s.play);
      const used = uses[sp.name] || 0;
      if (used >= sp.limitedUse.max) return toast(`No free uses of ${sp.name} left.`, true);
      uses[sp.name] = used + 1;

      savePlay();
      await announce(`casts ${Rolls.bold(sp.name)} ${Rolls.dim("(free use)")}`);
      if (sp.concentration) await concentrateOnSpell(sp);
      return;
    }

    if (kind === "pact") {
      const pact = s.spellcasting.pact;
      if (!pact || s.play.pactUsed >= pact.available) return toast("No pact slots left.", true);
      s.play.pactUsed += 1;
    } else {
      const slot = s.spellcasting.slots.find((x) => x.level === level);
      const used = s.play.slotsUsed[level] || 0;
      if (!slot || used >= slot.available) return toast(`No level ${level} slots left.`, true);
      s.play.slotsUsed[level] = used + 1;
    }

    renderSlots(s);
    savePlay();

    const at = level > sp.level ? ` at level ${level}` : "";
    await announce(`casts ${Rolls.bold(sp.name)}${at}`);
    if (sp.concentration) await concentrateOnSpell(sp);
  }

  /**
   * Casting a concentration spell ends the one before it, along with
   * anything it granted and any zone it kept on the board. Recasting the
   * same spell is a new casting too.
   */
  async function concentrateOnSpell(sp) {
    const play = state.sheet.play;
    const before = play.concentration;
    if (before) {
      await endConcentration({ silent: true });
      await announce(`stops concentrating on ${Rolls.bold(before.name)}`);
    }
    play.concentration = { name: sp.name, effectId: null, zoneId: null };
    renderConcentration();
    savePlay();
    toast(before ? `Concentrating on ${sp.name}; ${before.name} ended.` : `Concentrating on ${sp.name}.`);
  }

  // -------------------------------------------------------------------------
  // Session notes
  //
  // Somewhere to write "the innkeeper is lying" down mid-session without leaving
  // TaleSpire for another window. Notes live in play state, so they belong to the
  // character, survive a re-import and outlast a rest — and they are never posted
  // anywhere. This is a scratchpad, not a message.
  // -------------------------------------------------------------------------

  const notesOf = (play) => (play.notes ||= []);

  function addNote(text) {
    const body = String(text || "").trim();
    if (!body) return;

    notesOf(state.sheet.play).unshift({
      id: `note-${Date.now()}`,
      at: new Date().toISOString(),
      text: body,
    });
    renderNotes();
    savePlay();
  }

  function removeNote(note) {
    const play = state.sheet.play;
    play.notes = notesOf(play).filter((n) => n !== note);
    renderNotes();
    savePlay();
  }

  /** Time alone for a note from today, date and time for anything older. */
  function noteWhen(note) {
    const at = new Date(note.at);
    if (Number.isNaN(at.getTime())) return "";

    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const stamp = at.toDateString() === new Date().toDateString()
      ? time
      : `${at.toLocaleDateString()} ${time}`;

    return note.editedAt ? `${stamp} · edited` : stamp;
  }

  function renderNotes() {
    const host = $("notes");
    if (!host) return;
    host.replaceChildren();

    const notes = state.sheet ? notesOf(state.sheet.play) : [];

    if (!notes.length) {
      const empty = document.createElement("p");
      empty.className = "notes-empty";
      empty.textContent = "Nothing written down yet.";
      host.appendChild(empty);
      return;
    }

    for (const note of notes) {
      const row = document.createElement("div");
      row.className = "note";

      const body = document.createElement("div");
      body.className = "note-body";

      // Edited in place: fixing a name shouldn't mean deleting the note and
      // typing it again. `plaintext-only` keeps pasted markup out of the store.
      const text = document.createElement("div");
      text.className = "note-text";
      text.contentEditable = "plaintext-only";
      text.textContent = note.text;
      text.title = "Click to edit";
      text.onblur = () => {
        const next = text.textContent.trim();
        if (next === note.text) return;
        if (!next) return removeNote(note); // emptied is deleted
        note.text = next;
        note.editedAt = new Date().toISOString();
        renderNotes();
        savePlay();
      };

      const when = document.createElement("div");
      when.className = "note-when";
      when.textContent = noteWhen(note);

      body.append(text, when);
      row.appendChild(body);

      // Two clicks to delete. Everything else on the panel can be re-derived from
      // the import or given back with ↺; a note that's gone is gone.
      const remove = document.createElement("button");
      remove.className = "btn btn-small btn-ghost";
      remove.textContent = "×";
      remove.title = "Delete this note";
      let armed = null;
      remove.onclick = () => {
        if (armed) {
          clearTimeout(armed);
          return removeNote(note);
        }
        remove.textContent = "Delete?";
        armed = setTimeout(() => {
          armed = null;
          remove.textContent = "×";
        }, 3000);
      };

      row.appendChild(remove);
      host.appendChild(row);
    }
  }

  // --- checks --------------------------------------------------------------

  function renderChecks(s) {
    const saves = $("saves");
    saves.replaceChildren();

    // A caveat like "advantage to avoid the Poisoned condition" usually applies to
    // every save at once. Printed on all six rows it swamps the panel, so rows get
    // a marker and the wording goes in one footnote below.
    const caveats = [...new Set(s.savingThrows.flatMap((sv) => sv.conditionalAdvantage))];

    const short = (name) => String(name || "").slice(0, 3).toUpperCase();
    for (const sv of s.savingThrows) {
      const tile = rollTile({
        label: short(sv.name),
        value: DDB.signed(sv.value),
        prof: sv.proficient,
        mark: sv.conditionalAdvantage.length ? "adv*" : "",
        title: `${sv.name} save${sv.proficient ? " (proficient)" : ""}` +
          (sv.conditionalAdvantage.length ? `\nAdvantage ${sv.conditionalAdvantage.join("; ")}` : ""),
        onRoll: (mode) =>
          doRoll({ name: `${sv.name} save`, roll: `d20${DDB.signed(sv.value)}`, mode, kind: "save" }),
      });
      saves.appendChild(tile);
    }

    const note = $("saves-note");
    note.replaceChildren();
    if (caveats.length) {
      note.textContent = `adv*: advantage ${caveats.join("; ")}`;
    }

    const abilities = $("abilities");
    abilities.replaceChildren();
    for (const [, ab] of Object.entries(s.abilities)) {
      abilities.appendChild(
        rollTile({
          label: short(ab.name),
          value: DDB.signed(ab.mod),
          score: ab.score,
          title: `${ab.name} check`,
          onRoll: (mode) =>
            doRoll({ name: `${ab.name} check`, roll: `d20${DDB.signed(ab.mod)}`, mode, kind: "check" }),
        })
      );
    }

    const skills = $("skills");
    skills.replaceChildren();
    for (const sk of s.skills) {
      const row = document.createElement("button");
      row.className = "skill-row";
      const level = sk.expertise ? "expertise" : sk.proficient ? "proficient" : "";
      row.title = `Roll ${sk.name}${level ? ` (${level})` : ""}`;
      row.innerHTML =
        `<i class="skill-dot${sk.expertise ? " is-expert" : sk.proficient ? " is-prof" : ""}" aria-hidden="true"></i>` +
        `<span class="skill-name">${escapeHtml(sk.name)} <small>${escapeHtml(sk.ability.toUpperCase())}</small></span>` +
        `<b>${escapeHtml(DDB.signed(sk.value))}</b>`;
      row.onclick = (ev) => doRoll({ name: sk.name, roll: `d20${DDB.signed(sk.value)}`, mode: modeFromEvent(ev), kind: "check" });
      skills.appendChild(row);
    }
  }

  /** A tile that rolls: label on top, the modifier in gold, the score under it. */
  function rollTile({ label, value, score, prof, mark, title, onRoll }) {
    const tile = document.createElement("button");
    tile.className = `ability-tile${prof ? " is-prof" : ""}`;
    tile.title = `${title}. Shift-click for advantage, Ctrl-click for disadvantage.`;
    tile.innerHTML =
      `<span class="ability-label">${escapeHtml(label)}${prof ? ' <i aria-label="proficient">●</i>' : ""}${mark ? ` <em>${escapeHtml(mark)}</em>` : ""}</span>` +
      `<b>${escapeHtml(String(value))}</b>` +
      (score != null ? `<small>${escapeHtml(String(score))}</small>` : "");
    tile.onclick = (ev) => onRoll(modeFromEvent(ev));
    return tile;
  }

  function renderInfo(s) {
    const senses = [
      `Passive perception ${s.senses.passivePerception}`,
      `passive investigation ${s.senses.passiveInvestigation}`,
      `passive insight ${s.senses.passiveInsight}`,
      s.senses.darkvision ? `darkvision ${s.senses.darkvision} ft.` : null,
      s.defenses.resistances.length ? `Resistances: ${s.defenses.resistances.join(", ")}` : null,
    ].filter(Boolean);
    $("senses").textContent = senses.join(" · ");

    const features = $("features");
    features.replaceChildren();
    for (const f of s.features) {
      const li = document.createElement("li");
      li.innerHTML = `${escapeHtml(f.name)} <span class="sub">${escapeHtml(f.source || "")}</span>`;
      features.appendChild(li);
    }

    $("meta-block").textContent =
      `Imported ${s.meta.fetchedAt ? new Date(s.meta.fetchedAt).toLocaleString() : "—"} from ${s.meta.source} · importer v${s.meta.importerVersion}`;
  }

  // -------------------------------------------------------------------------
  // Gear
  // -------------------------------------------------------------------------

  /**
   * Re-derive the whole sheet with a changed equipment state.
   *
   * Nothing is patched in place: armour class depends on ability scores, which
   * depend on which rings are on, so the only reliable answer is to run the
   * normaliser again. Play state (hit points, spent slots, conditions) is keyed
   * by name rather than position, so it survives the swap untouched.
   */
  async function setEquipment(itemId, patch) {
    const sheet = state.sheet;
    if (!sheet?.source) {
      toast("Re-import this character to change equipment.", true);
      return;
    }

    const play = sheet.play;
    const equipment = { ...(play.equipment || {}) };
    equipment[itemId] = { ...(equipment[itemId] || {}), ...patch };

    let fresh;
    try {
      fresh = DDB.normalize(sheet.source, { equipment });
    } catch (e) {
      toast(`Could not recalculate: ${e.message}`, true);
      return;
    }

    fresh.meta = sheet.meta;
    fresh.source = sheet.source;
    fresh.play = { ...play, equipment };

    state.sheet = fresh;
    state.granted = null;
    await Store.replaceSheet(state.sheetId, fresh);
    render();
  }

  function gearRow(item) {
    const row = document.createElement("div");
    row.className = `gear-row${item.equipped ? " is-worn" : ""}`;

    const label = document.createElement("div");
    label.className = "gear-name";
    const detail = [
      item.kind,
      item.quantity > 1 ? `×${item.quantity}` : null,
      item.armorClass != null ? `AC ${item.armorClass}` : null,
      item.stowed ? "packed" : null,
    ].filter(Boolean);
    label.innerHTML =
      `${escapeHtml(item.name)}<span class="sub">${escapeHtml(detail.join(" · "))}</span>` +
      (item.grants.length ? `<span class="gear-grants">${escapeHtml(item.grants.join(" · "))}</span>` : "");
    row.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "gear-controls";

    if (item.canEquip) {
      const worn = document.createElement("button");
      worn.className = `chip${item.equipped ? " is-on" : ""}`;
      worn.textContent = item.equipped ? "Worn" : "Wear";
      worn.title = "Equipping changes armour class, ability scores and saves";
      worn.onclick = () => setEquipment(item.id, { equipped: !item.equipped });
      controls.appendChild(worn);
    }

    if (item.canAttune) {
      const att = document.createElement("button");
      att.className = `chip${item.attuned ? " is-on" : ""}`;
      att.textContent = item.attuned ? "Attuned" : "Attune";
      att.title = "An unattuned item grants nothing that requires attunement";
      att.onclick = () => setEquipment(item.id, { attuned: !item.attuned });
      controls.appendChild(att);
    }

    row.appendChild(controls);
    return row;
  }

  function renderGear(s) {
    const attuned = s.inventory.filter((i) => i.attuned).length;
    const overLimit = attuned > s.attunementLimit;
    $("gear-note").textContent = s.source
      ? `${attuned} of ${s.attunementLimit} attunement slots used.` +
        (overLimit ? " Over the limit — D&D Beyond allows three." : "")
      : "Imported before equipment tracking — re-import to change what's worn.";
    $("gear-note").classList.toggle("warn", overLimit);

    const worn = s.inventory.filter((i) => i.equipped);
    const carried = s.inventory.filter((i) => !i.equipped);

    const fill = (id, items) => {
      const host = $(id);
      host.replaceChildren();
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "Nothing here.";
        host.appendChild(empty);
        return;
      }
      for (const item of items) host.appendChild(gearRow(item));
    };

    fill("gear-worn", worn);
    fill("gear-carried", carried);
  }

  // -------------------------------------------------------------------------
  // Rolling
  // -------------------------------------------------------------------------

  async function doRoll(spec) {
    if (!state.ready) return toast("TaleSpire isn't ready yet.", true);

    const fx = effectsForRoll(spec.kind);

    // Flat buffs fold into the roll string; buff dice stay in their own groups.
    const withFlat = (rollStr) =>
      rollStr && fx.flat ? `${rollStr}${DDB.signed(fx.flat)}` : rollStr;

    try {
      await Rolls.stage({
        name: spec.name,
        roll: withFlat(spec.roll),
        damage: withFlat(spec.damage),
        damageName: spec.damageName,
        damageType: spec.damageType || null,
        extraDamage: spec.extraDamage || null,
        bonuses: fx.dice,
        mode: spec.mode || state.mode,
        // parkedDamage rides along so the result handler can arm a damage button
        // once the DM calls the hit.
        context: {
          kind: spec.kind, target: state.target, parkedDamage: spec.parkedDamage || null, parkedType: spec.parkedType || null, hit: spec.hit || null,
          ...(spec.kind === "temp" ? { tempFor: spec.tempFor || null, tempName: spec.tempName || null, source: spec.source || null } : {}),
          ...(spec.saveFor ? { saveFor: spec.saveFor } : {}),
          ...(spec.initiativeFor ? { initiativeFor: spec.initiativeFor } : {}),
          ...(spec.saveSession ? { saveSession: spec.saveSession } : {}),
        },
      });
      renderStaged();

      // Guidance and Bardic Inspiration are spent by being used.
      const spent = fx.used.filter((e) => e.once);
      if (spent.length) {
        for (const e of spent) e.active = false;
        renderEffects();
        render();
        savePlay();
        toast(`${spent.map((e) => e.name).join(", ")} used up.`);
      }
    } catch (e) {
      toast(e.message, true);
    }
  }

  /**
   * Called from the global onRollResults handler once dice have actually landed.
   */
  async function onRollLanded(summary) {
    renderStaged();
    let line = Rolls.describe(summary);
    const ctx = summary.context || {};
    const target = ctx.target;

    // Hit or miss is only decidable when we could read the target's AC — which a
    // player's client cannot do for a mini it doesn't own. Silence beats a guess.
    let verdict = null;
    if (ctx.kind === "attack" && target?.ac != null && summary.total != null) {
      verdict = summary.natural === 20 || (summary.natural !== 1 && summary.total >= target.ac);
      line += ` ${Rolls.bold(verdict ? "HIT" : "MISS")} ${Rolls.dim(`vs ${escapeText(target.name)} AC ${target.ac}`)}`;
    } else if (ctx.kind === "attack" && target) {
      line += ` ${Rolls.dim(`vs ${escapeText(target.name)}`)}`;
    }

    // Healing from a hit die is applied straight away — nobody adjudicates a rest.
    if (ctx.kind === "hitdie" && summary.damage != null) {
      applyHp(summary.damage);
      line += ` ${Rolls.dim("healed")}`;
    }

    // Initiative: into TaleSpire's order (here if this is the GM's panel, else via the GM's)
    if (ctx.initiativeFor && summary.total != null) {
      if (state.isGM && Bridge.canWrite()) placeInInitiative([{ id: ctx.initiativeFor.id, value: summary.total, dex: ctx.initiativeFor.dex }]);
      else Party.initiative(ctx.initiativeFor.id, summary.total, ctx.initiativeFor.dex).catch(() => {});
    }
    if (ctx.kind === "initiativeGroup") {
      const entries = (summary.groups || []).filter((g) => g.total != null).map((g) => ({ ...ctx.groupIds[g.name], value: g.total }));
      await placeInInitiative(entries);
      await postChat(`${Rolls.bold("Initiative")}: ${escapeText((summary.groups || []).map((g) => `${g.name.replace(/: initiative$/, "")} ${g.total}`).join(", "))}`, null);
      return;
    }

    // A save someone asked for: back to whichever panel is running it
    if (ctx.saveFor && summary.total != null) {
      const own = saveSessions.find((x) => x.id === ctx.saveFor.session);
      if (own) {
        Saves.record(own, ctx.saveFor.creatureId, summary.total, summary.natural);
        renderSaveSessions();
      } else {
        await Party.saveResult(ctx.saveFor.session, ctx.saveFor.creatureId, summary.total, summary.natural).catch(() => {});
      }
    }
    // Monsters' saves, all in one throw
    if (ctx.kind === "saveGroup") {
      const session = saveSessions.find((x) => x.id === ctx.saveSession);
      if (session) {
        for (const g of summary.groups || []) {
          const id = ctx.groupIds?.[g.name];
          if (id && g.total != null) Saves.record(session, id, g.total, g.natural);
        }
        renderSaveSessions();
        const list = (summary.groups || []).map((g) => `${g.name.replace(/:.*$/, "")} ${g.total}`).join(", ");
        await postChat(`${Rolls.bold(session.name)} ${Rolls.dim(`${Saves.ABILITIES[session.ability]} saves:`)} ${escapeText(list)}`, null);
      }
      return;
    }
    // A save's damage, rolled once for everyone
    if (ctx.kind === "saveDamage") {
      const session = saveSessions.find((x) => x.id === ctx.saveSession);
      if (session && summary.damage != null) {
        session.rolled = { parts: summary.damageParts?.length ? summary.damageParts : [{ type: session.damage?.type || null, amount: summary.damage }], total: summary.damage };
        renderSaveSessions();
      }
    }

    // Temp HP from an effect: yours applies here, anyone else's goes to their panel
    if (ctx.kind === "temp" && summary.damage != null) {
      const amount = summary.damage;
      if (!ctx.tempFor || ctx.tempFor === state.creatureId || ctx.tempFor === myQueueId()) {
        grantTempHp(amount);
        line += ` ${Rolls.dim("temp HP")}`;
      } else {
        line += ` ${Rolls.dim(`temp HP for ${escapeText(ctx.tempName || "them")}`)}`;
        await Party.tempGrant(ctx.tempFor, amount, ctx.source).catch(() => {});
      }
    }

    // The extra dice of a monster's crit, rolled after the attack landed
    if (ctx.kind === "critExtra") {
      const adj = afterDefenses(ctx.target?.id, (ctx.base || 0) + (summary.damage || 0), ctx.damageType);
      await applyMonsterDamage(ctx.target, adj.amount, ctx.source, ctx.creatureId, true, adj.note);
      return;
    }

    await postChat(line, ctx.creatureId || state.creatureId);
    toast(line.replace(/<[^>]+>/g, ""));

    // The GM's own turn runs itself: a monster's attack against a target whose
    // AC we could read is a hit or a miss without anyone ruling on it, and a
    // hit's damage (rolled in the same throw) goes straight onto the target.
    if (state.isGM && ctx.monster && ctx.kind === "attack" && target?.id && verdict !== null) {
      await resolveMonsterAttack(summary, verdict);
      return;
    }

    // A GM's own damage counts too. Rolling a player's attack for them, or a
    // monster's, is the same number needing the same target — and the roll
    // tracker having claimed these dice is an implementation detail, not a
    // reason for them to skip the fight.
    if (state.isGM && summary.damage != null && !["healing", "hitdie", "temp", "saveDamage"].includes(ctx.kind)) {
      offerDamageToFight({
        parts: summary.damageParts || null,
        rollId: summary.rollId || `own-${Date.now()}`,
        amount: summary.damage,
        label: summary.name,
        who: "You",
      });
    }

    // Park the damage unless we already know it missed.
    if (ctx.kind === "attack" && ctx.parkedDamage && verdict !== false) {
      state.pending.push({
        name: summary.name,
        damage: ctx.parkedDamage,
        damageType: ctx.parkedType || null,
        total: summary.total,
        crit: summary.natural === 20,
        // What this hit could add: smites, a mark, Sneak Attack (lib/classfx.js)
        riders: ctx.hit ? hitRiders(ctx.hit) : [],
      });
      renderPending();
    }
  }

  async function announce(text) {
    await postChat(text, state.creatureId);
  }

  /** "1d6+3+2d6" -> "1d6+2d6": the dice a crit adds again, without the modifier. */
  const diceOnly = (expr) => (String(expr || "").match(/\d*d\d+/g) || []).join("+");

  /**
   * A monster's damage against a player, through the defenses that player's
   * panel reported (resistance to poison, say). Unknown defenses: as rolled.
   */
  function afterDefenses(targetId, amount, type) {
    const def = Vitals.reportedFor(targetId)?.defenses || null;
    if (!def || !type) return { amount, note: "" };
    const { total, rows } = Damage.apply([{ type, amount }], def);
    const mode = rows[0]?.mode;
    return { amount: total, note: mode && mode !== "normal" ? `${type} ${mode === "resist" ? "resisted" : mode === "vuln" ? "doubled" : "immune"}` : "" };
  }

  async function resolveMonsterAttack(summary, hit) {
    const ctx = summary.context;
    if (!hit) return; // the posted line already says MISS
    const base = summary.damage;
    if (base == null) return toast(`${ctx.source} hits ${ctx.target.name}: no damage dice on this attack.`);

    // A natural 20 doubles the damage dice. The first set was rolled with the
    // attack, so roll the extra set now and apply both when it lands.
    if (summary.natural === 20 && diceOnly(ctx.damageExpr)) {
      try {
        await Rolls.stage({
          name: `${ctx.source} crit dice`,
          damage: diceOnly(ctx.damageExpr),
          damageName: `${ctx.source} crit dice`,
          context: { kind: "critExtra", target: ctx.target, base, source: ctx.source, creatureId: ctx.creatureId, damageType: ctx.damageType || null },
        });
        renderStaged();
      } catch (e) {
        toast(`Crit dice: ${e.message}. Applying the normal damage.`, true);
        const adj = afterDefenses(ctx.target.id, base, ctx.damageType);
        await applyMonsterDamage(ctx.target, adj.amount, ctx.source, ctx.creatureId, false, adj.note);
      }
      return;
    }
    const adj = afterDefenses(ctx.target.id, base, ctx.damageType);
    await applyMonsterDamage(ctx.target, adj.amount, ctx.source, ctx.creatureId, false, adj.note);
  }

  /**
   * Put a monster's damage onto its target, temp HP first. With the bridge it
   * goes straight onto the mini (and the player's panel follows the board).
   * Without it, the player's panel is told to apply it; either way chat says
   * what happened.
   */
  async function applyMonsterDamage(target, amount, source, speakerId, crit, defenseNote = "") {
    const who = target?.name || "the target";
    const what = `${source || "The monster"}${crit ? " crits" : " hits"} ${who} for ${amount}${defenseNote ? ` (${defenseNote})` : ""}`;
    let info = null;
    try {
      info = await Board.oneCreature(target.id);
    } catch {
      /* fall through: report without numbers */
    }
    const v = info ? Vitals.read(info) : null;

    if (v && v.hp != null && Bridge.canWrite()) {
      const next = Vitals.takeDamage({ hp: v.hp, temp: v.temp ?? 0 }, amount);
      const ok = await writeVitals(v, { hp: next.hp, temp: next.temp }, who);
      if (!ok) return;
      const notes = [
        next.absorbed ? `${next.absorbed} from temp HP` : null,
        v.temp == null ? "temp HP unknown" : null,
      ].filter(Boolean);
      const line = `${what}${notes.length ? ` (${notes.join(", ")})` : ""} → ${next.hp}/${v.max ?? "?"}${next.temp ? ` +${next.temp} temp` : ""}`;
      await postChat(Rolls.bold(line), speakerId);
      return toast(line);
    }

    // No bridge: the player's own panel applies it (temp first) if it's open
    await Party.hit(target.id, amount, source).catch(() => {});
    await postChat(Rolls.bold(`${what}.`), speakerId);
    toast(`${what}. Sent to their panel to apply; if it's closed, they'll need to apply it by hand.`);
  }

  // -------------------------------------------------------------------------
  // Targeting
  // -------------------------------------------------------------------------

  /** "Target: Gnoll (AC 15) · 10 ft" */
  function targetText() {
    const t = state.target;
    if (!t) return "No target";
    const ac = t.ac != null ? ` (AC ${t.ac})` : state.isGM ? " (no AC stat)" : "";
    return `Target: ${t.name}${ac}${t.distance != null ? ` · ${t.distance} ft` : ""}`;
  }

  /**
   * How far the target is from this sheet's mini, and whether an enemy stands
   * next to us (for a ranged attack's Disadvantage). Re-measured when either
   * mini moves. Enemies: with the GM's bridge, every mini that isn't a party
   * member; without it, only the target is known.
   */
  let measuring = false;
  async function refreshTargetDistance() {
    const t = state.target;
    if (!t || !state.creatureId || measuring) return;
    measuring = true;
    try {
      const [me, them] = await Board.creatureInfo([state.creatureId, t.id]);
      const at = (i) => i?.position ? { ...i.position, size: i.morphs?.[i.activeMorphIndex ?? 0]?.scale || 1 } : null;
      const per = await feetPerTile();
      const distance = Range.distanceFt(at(me), at(them), per);
      let adjacent = distance != null && distance <= 5;
      const all = await Bridge.creatures();
      if (all) {
        const party = new Set([state.creatureId, ...(GM.rows || []).map((r) => r.id)]);
        const mine = at(me);
        adjacent = all.some((c) => !party.has(c.id) && !c.hidden && Range.distanceFt(mine, { x: c.x, y: c.y, z: c.z, size: c.scale }, per) <= 5);
      }
      if (state.target !== t) return;
      t.distance = distance;
      t.enemyAdjacent = adjacent;
      setTargetStatus(targetText(), true);
      if (state.sheet) renderAttacks(state.sheet);
    } catch (e) {
      console.warn("[Spirekeeper] distance", e);
    } finally {
      measuring = false;
    }
  }

  function setTargetStatus(text, hasTarget) {
    const status = $("target-status");
    status.textContent = text;
    status.classList.toggle("has-target", Boolean(hasTarget));
    $("clear-target").classList.toggle("hidden", !hasTarget);
    $("pick-target").textContent = hasTarget ? "→" : "Pick target";
    status.classList.toggle("hidden", !hasTarget);
    renderCombatCard();
  }

  async function pickTarget() {
    try {
      const id = await TS.picking.startPicking();
      if (failed(id)) {
        // Another Symbiote may already own the picking tool.
        return toast(
          id.cause === "toolInUse" ? "Another mod is using the picker." : `Could not start picking: ${id.cause}`,
          true
        );
      }
      // The picker is a board tool, and TaleSpire keeps it active until the
      // player dismisses it — there is no stopPicking in the API. Saying so here
      // saves a lot of confusion about why the next board click also targets.
      setTargetStatus("Click a mini — Esc or right-click to stop picking", false);
    } catch (e) {
      toast(e.message, true);
    }
  }

  /**
   * Adopt whatever was picked as the target.
   *
   * Two things make this messier than it looks. The picker returns tiles and
   * props as happily as minis, and a player can only read stats on minis they
   * own — everyone else's come back with a name and nothing else. Neither is an
   * error, so neither should look like one; what matters is that the prompt
   * never sits there implying the panel is still waiting.
   */
  async function onTargetPicked(creatureId) {
    try {
      let info = null;
      try {
        info = await Board.oneCreature(creatureId);
      } catch (e) {
        setTargetStatus("No target", false);
        return toast(`Could not read that mini: ${e.message}`, true);
      }

      // The board knows the creature exists — we picked it — so an empty answer
      // means we could not read its details, not that it isn't there. Linking
      // only needs an id, so carry on with a placeholder name rather than
      // refusing outright; a GM placing their own mini should never be told it
      // is invisible to them.
      if (!info) {
        console.warn("[Spirekeeper] no details for picked creature", creatureId);
        info = { id: creatureId, name: null, stats: [] };
      }

      const name = info.name || "Unnamed mini";

      // The same picker serves three jobs; which one was asked for decides where
      // the result lands.
      if (state.linkingCombatant) {
        const combatant = state.linkingCombatant;
        state.linkingCombatant = null;
        combatant.creatureId = creatureId;
        // Kept so the initiative tracker can match on name when the turn queue's
        // ids turn out not to be creature ids.
        combatant.creatureName = info.name || null;
        // A mini that already carries hit points makes the board authoritative
        // for this combatant from here on.
        await saveCurrentEncounter();
        await refreshBoardHp();
        setTargetStatus(targetText(), Boolean(state.target));
        return toast(`${combatant.label} linked to ${name}.`);
      }

      if (state.pickingSpeaker) {
        state.pickingSpeaker = false;
        state.speaker = { id: creatureId, name };
        renderSpeaker();
        setTargetStatus(targetText(), Boolean(state.target));
        return toast(`Rolls now post as ${name}.`);
      }

      const acStat = (info.stats || []).find((st) => /^ac$|armou?r/i.test(st.name || ""));
      const ac = acStat && Number.isFinite(acStat.value) ? acStat.value : null;

      state.target = { id: creatureId, name, ac, distance: null };

      setTargetStatus(targetText(), true);
      refreshTargetDistance();
    } catch (e) {
      setTargetStatus("No target", false);
      toast(`Targeting failed: ${e.message}`, true);
    }
  }

  /** The pick landed on scenery, or the player backed out. Don't leave the prompt up. */
  function onPickingEnded(reason) {
    state.pickingSpeaker = false;
    state.linkingCombatant = null;
    if (state.target) return; // an earlier target still stands
    setTargetStatus("No target", false);
    if (reason) toast(reason);
  }

  function clearTarget() {
    state.target = null;
    setTargetStatus("No target", false);
  }

  // -------------------------------------------------------------------------
  // Selection -> sheet switching
  // -------------------------------------------------------------------------

  function onSelectionChanged(creatures) {
    state.selection = creatures || [];

    // Clicking a mini that has a sheet linked brings that sheet up.
    if (state.selection.length === 1) {
      const linked = Store.boundSheetId(state.selection[0].id);
      if (linked && linked !== state.sheetId) openSheet(linked);
    }
    renderBindBar();
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  function rollRow({ name, sub, value, tag, onRoll }) {
    const row = document.createElement("button");
    row.className = "roll-row";
    row.innerHTML =
      `<span class="rr-name">${escapeHtml(name)}${sub ? `<br><span class="rr-sub">${escapeHtml(sub)}</span>` : ""}</span>` +
      (tag ? `<span class="rr-tag">${escapeHtml(tag)}</span>` : "") +
      `<span class="rr-value">${escapeHtml(String(value))}</span>`;
    row.onclick = (ev) => onRoll(modeFromEvent(ev));
    return row;
  }

  function button(labelText, cls, onClick) {
    const b = document.createElement("button");
    b.className = `btn btn-small ${cls}`.trim();
    b.textContent = labelText;
    b.onclick = (ev) => onClick(modeFromEvent(ev));
    return b;
  }

  /**
   * Live modifier-key state, tracked separately from the click.
   *
   * TaleSpire's embedded webview does not put modifier flags on the MouseEvent
   * it delivers, so `ev.shiftKey` is always false in game even while the key is
   * held — which is why shift-click silently did nothing there. Watching keydown
   * and keyup gives a second chance at the same information; if the host
   * swallows the key events too, the mode bar is still the reliable path.
   */
  const heldKeys = { shift: false, ctrl: false };

  function watchModifierKeys() {
    const update = (ev) => {
      heldKeys.shift = ev.shiftKey;
      heldKeys.ctrl = ev.ctrlKey || ev.metaKey;
    };
    window.addEventListener("keydown", update, true);
    window.addEventListener("keyup", update, true);
    // A panel that loses focus mid-hold would otherwise stay stuck on advantage.
    window.addEventListener("blur", () => {
      heldKeys.shift = false;
      heldKeys.ctrl = false;
    });
  }

  /** Shift = advantage, Ctrl/Cmd = disadvantage, otherwise the mode bar wins. */
  function modeFromEvent(ev) {
    if (ev?.shiftKey || heldKeys.shift) return Rolls.MODE.ADVANTAGE;
    if (ev?.ctrlKey || ev?.metaKey || heldKeys.ctrl) return Rolls.MODE.DISADVANTAGE;
    return state.mode;
  }

  function setStatus(id, text, isError = false) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle("error", isError);
  }

  let toastTimer;
  function toast(message, isError = false) {
    const el = $("toast");
    el.textContent = message;
    el.classList.toggle("is-error", isError);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), isError ? 6000 : 3500);
  }

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** Chat is TextMeshPro, not HTML — only angle brackets need neutralising. */
  const escapeText = (s) => String(s ?? "").replace(/[<>]/g, "");

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function wire() {
    $("resolve-link").onclick = resolveLink;
    $("copy-url").onclick = copyUrl;
    $("import-json").onclick = () => importJson();
    $("open-library").onclick = showImport;
    $("pick-target").onclick = pickTarget;
    $("clear-target").onclick = clearTarget;
    $("rest-short").onclick = shortRest;
    $("rest-long").onclick = longRest;

    // The HP box: -7 damage, +5 healing, =20 set; a bare 7 is damage, as at the table
    const hpBox = $("hp-input");
    hpBox.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const m = /^\s*([-+=−]?)\s*(\d+)\s*$/.exec(hpBox.value);
      if (!m) return toast("Type -7 for damage, +5 for healing, or =20 to set.", true);
      const n = parseInt(m[2], 10);
      if (m[1] === "+") applyHp(n);
      else if (m[1] === "=") setHp(n);
      else applyHp(-n);
      hpBox.value = "";
    });
    $("hp-temp-btn").onclick = () => {
      const n = Math.abs(parseInt(hpBox.value.replace(/[^0-9]/g, ""), 10) || 0);
      if (!n) return toast("Type how much temp HP, then press Temp.", true);
      grantTempHp(n);
      hpBox.value = "";
    };
    $("hp-more").onclick = () => {
      const drawer = $("hp-drawer");
      const open = drawer.classList.toggle("hidden") === false;
      $("hp-more").setAttribute("aria-expanded", open ? "true" : "false");
      $("hp-more").textContent = open ? "less" : "more";
    };
    $("gm-menu-btn").onclick = () => toggleGmMenu();
    for (const id of ["open-party", "open-bestiary", "open-encounters"]) {
      $(id).addEventListener("click", () => toggleGmMenu(false));
    }
    $("pick-target-pill").onclick = pickTarget;
    $("maxhp-add").onclick = () => {
      const n = parseInt($("maxhp-amount").value, 10);
      if (!Number.isFinite(n) || !n) return toast("Enter how much the maximum changes, e.g. 5 or -7.", true);
      addMaxHpMod(n, $("maxhp-name").value);
      $("maxhp-name").value = "";
    };

    $("event-undo").onclick = undoLast;
    $("event-toggle").onclick = () => {
      logOpen = !logOpen;
      renderEventLog();
    };
    $("effect-custom-toggle").onclick = () => $("effect-custom").classList.toggle("hidden");
    $("effect-add-toggle").onclick = () => {
      const open = $("effect-add").classList.toggle("hidden") === false;
      $("effect-add-toggle").setAttribute("aria-expanded", open ? "true" : "false");
      $("effect-add-toggle").textContent = open ? "Done" : "+ Add";
    };
    $("conc-drop").onclick = () => endConcentration();
    $("condition-add").onclick = () => addCondition($("condition-pick").value);
    // Picking a condition adds it; the first option is the "+ Condition" label
    $("condition-pick").onchange = () => {
      const name = $("condition-pick").value;
      if (name) addCondition(name);
    };
    watchModifierKeys();

    // Staged rolls that are never thrown would otherwise be remembered forever.
    // The dice stay in TaleSpire's tray either way — nothing here can remove
    // them — but the panel stops waiting on them.
    setInterval(() => {
      if (Rolls.sweep()) renderStaged();
      else if (Rolls.staged().length) renderStaged(); // keep the age readable
    }, 10000);

    GM.configure({
      container: $("party-list"),
      meta: $("party-meta"),
      onError: (m) => toast(`Could not read the party: ${m}`, true),
      canWrite: () => Bridge.canWrite(),
      onSetHp: setPartyHp,
      onSetTemp: setPartyTemp,
      onCondition: setPartyCondition,
      conditionNames: () => CONDITION_NAMES.filter((n) => Statuses.emoteFor(n)),
      afterRender: () => renderStatusMap(),
    });

    // The bridge appearing or going away changes which HP boxes are editable
    Bridge.onChange((st) => {
      if (st.available && state.isGM) Statuses.loadCatalog();
      Encounters.render();
      GM.render();
      if (st.available && st.canGm) toast("Bridge connected: HP edits now go onto the minis.");
    });
    $("open-party").onclick = showParty;
    $("close-party").onclick = closeParty;
    $("party-refresh").onclick = () => GM.refresh();

    Bestiary.configure({
      results: $("bestiary-results"),
      sheet: $("bestiary-sheet"),
      onRoll: monsterRoll,
      onRequestSave: async ({ name, ability, dc, damage, damageType, half }) => {
        const targets = await saveTargets(null);
        await requestSaves({ name, ability, dc, damage: damage ? { expr: damage, type: damageType || null } : null, half, ...targets });
      },
      onAnnounce: monsterAnnounce,
      onShow: refreshEncounterPicker,
      scratchContext: scratchSpellContext,
      onError: (m) => toast(m, true),
    });
    $("open-bestiary").onclick = showBestiary;
    $("close-bestiary").onclick = closeBestiary;
    $("bestiary-speak").onclick = pickSpeaker;

    let searchTimer;
    $("bestiary-query").oninput = (ev) => {
      clearTimeout(searchTimer);
      // Online search hits a server, so it waits longer than a local filter.
      searchTimer = setTimeout(() => Bestiary.runSearch(ev.target.value), $("bestiary-online").checked ? 400 : 120);
    };
    Encounters.configure({
      list: $("encounters-list"),
      detail: $("encounter-detail"),
      onOpen: openEncounter,
      onDelete: async (id) => {
        await Store.deleteEncounter(id);
        if (Encounters.current?.id === id) Encounters.setCurrent(null);
        renderEncounters();
      },
      onOpenMonster: openCombatantStatblock,
      onSetHp: setCombatantHp,
      onSetTemp: setCombatantTemp,
      canWriteBoard: writesBoard,
      onLink: linkCombatant,
      onRemove: removeCombatant,
      onApplyDamage: applyOfferedDamage,
      canRollInitiative: () => Bridge.canWrite(),
      onRollInitiative: () => rollMonsterInitiative(),
      onMove: (c, op) => {
        const t = (c.turnState ||= { moved: 0, dashes: 0, lastPos: null });
        if (op === "dash") t.dashes += 1;
        if (op === "less") t.moved = Math.max(0, t.moved - 5);
        if (op === "more") t.moved += 5;
        if (op === "reset") Object.assign(t, { moved: 0, dashes: 0 });
        saveCurrentEncounter();
        Encounters.render();
      },
      onAcBonus: (c, n) => undoable(n ? `${c.label} AC +${n}` : `${c.label} AC bonus ended`, () => setMonsterAcBonus(c, n)),
      onDodge: (c) => {
        c.dodge = !c.dodge;
        saveCurrentEncounter();
        Encounters.render();
        if (c.dodge) postChat(`${Rolls.bold(c.label)} takes the Dodge action: attacks against it have Disadvantage until its next turn.`, c.creatureId || null);
      },
      // Synchronous for drawing; fills the cache and redraws when a stat block loads
      defensesSync: (c) => {
        const key = c.id;
        if (combatantDefenses.has(key)) return combatantDefenses.get(key);
        combatantDefenses.set(key, null);
        defensesForCombatant(c).then((d) => {
          combatantDefenses.set(key, d);
          Encounters.render();
        });
        return null;
      },
      onAssignTurn: assignTurn,
      onInboxChange: renderFightBadge,
      onError: (m) => toast(m, true),
    });
    $("open-encounters").onclick = showEncounters;
    $("close-encounters").onclick = closeEncounters;
    $("encounter-new").onclick = createEncounter;
    $("bestiary-add-btn").onclick = addCurrentMonsterToEncounter;

    $("bestiary-online").onchange = (ev) => {
      Bestiary.setOnline(ev.target.checked);
      Bestiary.runSearch($("bestiary-query").value);
    };
    $("roll-initiative").onclick = (ev) => rollInitiative(modeFromEvent(ev));

    $("effect-custom").onsubmit = (ev) => {
      ev.preventDefault();
      const name = $("effect-name").value.trim();
      const bonus = $("effect-bonus").value.trim();
      const targets = [...document.querySelectorAll('#effect-custom .effect-targets input[type="checkbox"]')]
        .filter((c) => c.checked && c.value)
        .map((c) => c.value);

      if (!name || !bonus) return toast("Give the effect a name and a bonus.", true);
      if (!targets.length) return toast("Pick at least one thing the effect applies to.", true);
      if (!/^[+-]?\d*(d\d+)?$/i.test(bonus)) return toast('Bonus should look like "+2" or "1d4".', true);

      addEffect({ name, bonus, targets, once: $("effect-once").checked, lasts: $("effect-lasts").value });
      $("effect-lasts").value = "";
      $("effect-name").value = "";
      $("effect-bonus").value = "";
      $("effect-once").checked = false;
      for (const c of document.querySelectorAll('#effect-custom .effect-targets input')) c.checked = false;
      $("effect-custom").classList.add("hidden");
    };

    $("ddb-link").addEventListener("keydown", (e) => {
      if (e.key === "Enter") resolveLink();
    });

    for (const btn of document.querySelectorAll(".mode-btn")) {
      btn.onclick = () => {
        state.mode = btn.dataset.mode;
        for (const b of document.querySelectorAll(".mode-btn")) {
          const active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-checked", String(active));
        }
      };
    }

    const commitNote = () => {
      const input = $("note-input");
      addNote(input.value);
      input.value = "";
      input.focus();
    };
    $("note-save").onclick = commitNote;
    $("note-input").onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      commitNote();
    };

    for (const tab of document.querySelectorAll(".tab")) {
      tab.onclick = () => {
        for (const t of document.querySelectorAll(".tab")) {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", String(active));
        }
        for (const panel of document.querySelectorAll(".tab-panel")) {
          panel.classList.toggle("hidden", panel.id !== `tab-${tab.dataset.tab}`);
        }
      };
    }

    // Drag and drop a .json file anywhere on the panel.
    const overlay = $("drop-overlay");
    let dragDepth = 0;

    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (++dragDepth === 1) overlay.classList.remove("hidden");
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        overlay.classList.add("hidden");
      }
    });
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.add("hidden");
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      importJson(await file.text());
    });
  }

  /**
   * A mini linked to the open encounter changed on the board, by our own
   * bridge write or by someone using TaleSpire's radial menu. Events come one
   * per property, so coalesce into a single re-read.
   */
  let encounterBoardTimer = null;
  let followTimer = null;
  let measureTimer;
  function onCreatureEvent(event) {
    const id = event?.payload?.id;
    if (state.isGM && Encounters.current && id) trackMonsterMove(id);
    if (state.target && (id === state.target.id || id === state.creatureId)) {
      clearTimeout(measureTimer);
      measureTimer = setTimeout(refreshTargetDistance, 200);
    }
    if (state.creatureId && event?.payload?.id === state.creatureId) {
      clearTimeout(followTimer);
      followTimer = setTimeout(followLinkedMini, 150);
    }
    const structural = event?.kind === "creatureAdded" || event?.kind === "creatureRemoved";
    if (!structural && !Encounters.isWatching(event?.payload?.id)) return;
    clearTimeout(encounterBoardTimer);
    encounterBoardTimer = setTimeout(refreshBoardHp, 150);
  }

  // Actions that change the sheet, as undoable steps (see History above)
  {
    const wrap = (fn, labelOf) => function (...args) { return undoable(labelOf(...args), () => fn.apply(this, args)); };
    applyHp = wrap(applyHp, (d) => (d < 0 ? `took ${-d} damage` : `healed ${d}`));
    setHp = wrap(setHp, (n) => `set HP to ${n}`);
    grantTempHp = wrap(grantTempHp, (n) => `gained ${n} temp HP`);
    addMaxHpMod = wrap(addMaxHpMod, (n, name) => `max HP ${n > 0 ? "+" : ""}${n}${name ? ` (${name})` : ""}`);
    removeMaxHpMod = wrap(removeMaxHpMod, () => "removed a max HP change");
    addCondition = wrap(addCondition, (name) => `became ${name}`);
    removeCondition = wrap(removeCondition, (c) => `no longer ${c.name}`);
    castSpell = wrap(castSpell, (sp, level) => `cast ${sp.name}${level > sp.level ? ` at level ${level}` : ""}`);
    addEffect = wrap(addEffect, (fx) => `added ${fx.name}`);
    dismissEffect = wrap(dismissEffect, (fx) => `ended ${fx.name}`);
    endConcentration = wrap(endConcentration, () => "dropped concentration");
    shortRest = wrap(shortRest, () => "short rest");
    longRest = wrap(longRest, () => "long rest");
    spendHitDie = wrap(spendHitDie, (hd) => `spent a hit die (${hd.die})`);
    rollPending = wrap(rollPending, (entry) => `${entry.name} damage`);
    applyMonsterDamage = wrap(applyMonsterDamage, (target, amount, source) => `${source || "a monster"} hit ${target?.name || "a target"} for ${amount}`);
    onHitFromGm = wrap(onHitFromGm, ({ amount, source }) => `took ${amount} from ${source || "the GM"}`);
    onTempGrant = wrap(onTempGrant, ({ temp, source }) => `${source || "an effect"}: ${temp} temp HP`);
  }

  return { boot, wire, onCreatureEvent, onRollLanded, onRollRemoved: renderStaged, onPickingEnded, showParty, showBestiary, showEncounters, onForeignRoll: offerForeignRoll, onSelectionChanged, onTargetPicked, onInitiativeUpdated: renderInitiative, render, state };
})();

// ---------------------------------------------------------------------------
// Subscription handlers. The manifest names these, so they must be global.
// Each event arrives as { kind, payload }.
// ---------------------------------------------------------------------------

function onStateChangeEvent(event) {
  if (event.kind === "hasInitialized") App.boot();
}

/**
 * Creature state changes drive the GM's party view. Everything here is a
 * notification that something on the board moved on without us — HP ticked, a
 * mini was added — so the view refetches rather than trusting the payload.
 */
function onCreatureStateChange(event) {
  GM.onCreatureEvent(event);
  App.onCreatureEvent(event);
}

function onCreatureSelectionChange(event) {
  if (event.kind === "creatureSelection") App.onSelectionChanged(event.payload?.creatures);
}

async function onRollResults(event) {
  if (event.kind === "rollResults") {
    const summary = await Rolls.handleResult(event.payload);
    if (summary) App.onRollLanded(summary);
    // Not ours — someone else's dice. For a GM running a fight that is exactly
    // the interesting case: the party's damage.
    else await App.onForeignRoll(event.payload);
  } else if (event.kind === "rollRemoved") {
    Rolls.forget(event.payload.rollId);
    App.onRollRemoved();
  }
}

/** Rulers placed in TaleSpire; a spell zone waits on the one it started. */
function onRulerEvent(event) {
  Zones.onRulerEvent(event);
}

function onInitiativeEvent(event) {
  if (event.kind === "initiativeUpdated") {
    App.onInitiativeUpdated(event.payload?.queue);
    Encounters.setQueue(event.payload?.queue);
  }
}

function onSyncMessage(event) {
  if (event.kind === "syncMessageReceived") {
    Party.receive(event.payload?.str, App.state.me?.id);
  }
}

function onPickingEvent(event) {
  if (event.kind === "pickingCompleted") {
    const kind = event.payload?.kindOfPicked;
    if (kind === "creature") {
      App.onTargetPicked(event.payload.idOfPicked);
    } else {
      // The picker happily returns tiles and props. Silently ignoring them left
      // the "click a mini" prompt on screen looking like the panel had hung.
      App.onPickingEnded(kind === "unknown" ? "That isn't a mini." : `That's a ${kind}, not a mini.`);
    }
  } else if (event.kind === "pickingCanceled" || event.kind === "pickingCancelled") {
    App.onPickingEnded();
  }
}

// ---------------------------------------------------------------------------
// Dev fallback: outside TaleSpire there is no TS object and no hasInitialized
// event, so stub enough of the API to develop the UI in a normal browser.
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  App.wire();

  if (typeof TS === "undefined") {
    console.warn("[Spirekeeper] No TaleSpire API — running in browser dev mode.");
    const log = (name) => async (...args) => {
      console.log(`[dev] TS.${name}`, ...args);
      return {};
    };
    // Back the stub onto the browser's own localStorage rather than a variable.
    // TaleSpire's blobs survive a restart, so a dev stub that forgets on reload
    // can't exercise the paths that matter — persistence and compression.
    // A mini you own (stats visible), one you don't (name only), and an id that
    // resolves to nothing at all.
    const devCreatures = {
      "dev-owned": { id: "dev-owned", name: "Gnoll Pack Lord", stats: [{ name: "AC", value: 15, max: 15 }] },
      "dev-foreign": { id: "dev-foreign", name: "Someone Else's Mini", stats: [] },
      // A party spanning the states the view has to render: healthy, bloodied,
      // critical, down, and one whose stats this client can't see.
      "pc-1": { id: "pc-1", name: "Aranis", hp: { name: "HP", value: 203, max: 203 },
        stats: [{ name: "AC", value: 27, max: 27 }], ownerIds: ["dev"], isFlying: true },
      "pc-2": { id: "pc-2", name: "Doran", hp: { name: "HP", value: 11, max: 23 },
        stats: [{ name: "AC", value: 18, max: 18 }], ownerIds: ["dev-other"] },
      "pc-3": { id: "pc-3", name: "Kree", hp: { name: "HP", value: 4, max: 40 },
        stats: [{ name: "AC", value: 14, max: 14 }], ownerIds: ["dev-other"],
        idsOfActivePersistentEmotes: ["e1", "e2"] },
      "pc-4": { id: "pc-4", name: "Gronk", hp: { name: "HP", value: 0, max: 52 },
        stats: [{ name: "AC", value: 16, max: 16 }, { name: "Stress", value: 3, max: 6 }],
        ownerIds: ["dev-offline"], isExplicitlyHidden: true },
      "pc-5": { id: "pc-5", name: "Unowned NPC", stats: [] },
    };

    // Where the fixtures stand, in tiles, for spell zones: a line along x
    const devPlaces = {
      "pc-1": [0, 0], "pc-5": [1, 1], "pc-2": [2, 0], "dev-owned": [3, 1],
      "pc-3": [5, 0], "pc-4": [10, 0], "dev-foreign": [30, 0],
    };
    for (const [id, [x, z]] of Object.entries(devPlaces)) {
      if (!devCreatures[id]) continue;
      devCreatures[id].position = { x, y: 0, z };
      devCreatures[id].morphs = [{ boardAssetId: "dev", scale: id === "pc-4" ? 2 : 1 }];
      devCreatures[id].activeMorphIndex = 0;
    }

    // A campaign with a "Temp HP" stat, as slot 2, on every fixture that has
    // stats. window.devTempStat = false before load simulates a campaign
    // without one, where temp HP travels over sync instead.
    if (window.devTempStat !== false) {
      for (const c of Object.values(devCreatures)) {
        if (c.stats?.length) c.stats.splice(1, 0, { name: "Temp HP", value: 0, max: 0 });
      }
      devCreatures["pc-2"].stats[1] = { name: "Temp HP", value: 5, max: 5 };
    }

    const devOwnedByPlayer = {
      dev: ["pc-1"],
      "dev-other": ["pc-2", "pc-3"],
      "dev-offline": ["pc-4"],
    };

    const memory = {
      get global() { return window.localStorage.getItem("sheetbridge:dev:global"); },
      set global(v) { persistDev("global", v); },
      get campaign() { return window.localStorage.getItem("sheetbridge:dev:campaign"); },
      set campaign(v) { persistDev("campaign", v); },
    };

    function persistDev(scope, value) {
      const key = `sheetbridge:dev:${scope}`;
      if (value == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    }
    let devRollCounter = 0;

    const devRoll = (sides) => 1 + Math.floor(Math.random() * sides);

    /** Turn "2d6+3" into the nested result tree TaleSpire would return. */
    function devRollGroup(rollStr) {
      const operands = [];
      const re = /([+-]?)\s*(\d*)d(\d+)|([+-]?\s*\d+)(?!d)/gi;
      let m;
      while ((m = re.exec(rollStr)) !== null) {
        if (m[3]) {
          const count = parseInt(m[2] || "1", 10);
          operands.push({ kind: `d${m[3]}`, results: Array.from({ length: count }, () => devRoll(+m[3])) });
        } else if (m[4]) {
          operands.push({ value: parseInt(m[4].replace(/\s+/g, ""), 10) });
        }
      }
      return operands.length === 1 ? operands[0] : { operator: "+", operands };
    }

    function devSum(node) {
      if (!node) return 0;
      if (node.kind) return node.results.reduce((a, b) => a + b, 0);
      if (node.value !== undefined) return node.value;
      if (node.operands) return node.operands.reduce((a, o) => a + devSum(o), 0);
      return 0;
    }
    window.TS = {
      localStorage: {
        global: {
          getBlob: async () => memory.global,
          setBlob: async (v) => ((memory.global = v), {}),
          deleteBlob: async () => ((memory.global = null), {}),
        },
        campaign: {
          getBlob: async () => memory.campaign,
          setBlob: async (v) => ((memory.campaign = v), {}),
          deleteBlob: async () => ((memory.campaign = null), {}),
        },
      },
      // No parties configured, which is the common case — the view falls back to
      // minis owned by players.
      parties: { getParties: async () => [], getCreaturesInParty: async () => [] },
      clients: {
        getMoreInfo: async (ids) =>
          (ids || []).map((id) => ({ id, player: { id, name: id === "dev" ? "You (dev)" : "Kree (dev)" } })),
      },
      players: {
        whoAmI: async () => ({ id: "dev", name: "You (dev)" }),
        getMoreInfo: async (list) => (list || []).map((p) => ({ ...p, rights: { canGm: true } })),
        getPlayersInThisBoard: async () => [
          { id: "dev", name: "You (dev)" },
          { id: "dev-other", name: "Kree (dev)" },
          { id: "dev-offline", name: "Gronk (dev, no mod)" },
        ],
      },
      creatures: {
        getSelectedCreatures: async () => (window.devSelected ? [{ id: window.devSelected }] : []),
        // Mirrors the real visibility rule: a player sees a name and nothing
        // else on a mini they don't own, so `stats` comes back empty.
        // Mirrors what TaleSpire actually does: a bare id string comes back
        // empty, only fragments resolve. This is the bug that told a GM their
        // own mini wasn't visible to them, so the stub reproduces it.
        getMoreInfo: async (ids) =>
          (ids || []).map((x) => (typeof x === "string" ? null : devCreatures[x?.id])).filter(Boolean),
        getCreaturesOwnedByPlayer: async (player) =>
          (devOwnedByPlayer[player.id || player] || []).map((id) => ({ id })),
      },
      dice: {
        // Simulate a throw so the whole attack -> hit -> damage loop is
        // exercisable outside the game. Dice land ~400ms after staging.
        putDiceInTray: async (descriptors, quiet) => {
          const rollId = `dev-${++devRollCounter}`;
          console.log("[dev] putDiceInTray", descriptors, "quiet:", quiet);
          setTimeout(() => {
            const resultsGroups = descriptors.map((d) => ({
              name: d.name,
              result: devRollGroup(d.roll),
            }));
            onRollResults({ kind: "rollResults", payload: { rollId, clientId: "dev", resultsGroups, quiet } });
          }, 400);
          return rollId;
        },
        evaluateDiceResultsGroup: async (group) => devSum(group.result),
        sendDiceResult: log("dice.sendDiceResult"),
      },
      chat: { send: log("chat.send"), sendAsCreature: log("chat.sendAsCreature") },
      // Picking is where targeting goes wrong in practice — scenery picks and
      // cancels both used to leave the prompt hanging — so the stub can produce
      // each outcome. Set window.devPick before clicking "Pick target".
      picking: {
        startPicking: async () => {
          const outcome = window.devPick || "owned";
          console.log("[dev] startPicking -> will simulate:", outcome);
          setTimeout(() => {
            if (outcome === "cancel") return onPickingEvent({ kind: "pickingCanceled", payload: { id: "dev" } });
            if (outcome === "tile" || outcome === "prop") {
              return onPickingEvent({ kind: "pickingCompleted", payload: { id: "dev", kindOfPicked: outcome, idOfPicked: "x" } });
            }
            const idOfPicked = outcome === "foreign" ? "dev-foreign" : outcome === "missing" ? "dev-missing" : "dev-owned";
            onPickingEvent({ kind: "pickingCompleted", payload: { id: "dev", kindOfPicked: "creature", idOfPicked } });
          }, 300);
          return "dev-pick-1";
        },
      },
      // The turn item ids here deliberately do NOT match any creature id: the API
      // calls them turn-entry ids, and in the game they did not match, which is
      // why the tracker labelled everything as outside the encounter.
      initiative: {
        // window.devQueue overrides it; then App.onInitiativeUpdated(devQueue) moves the turn
        getQueue: async () => window.devQueue || ({
          items: [
            { id: "turn-entry-1", name: "Gnoll Pack Lord", kind: "creature" },
            { id: "turn-entry-2", name: "Aranis", kind: "creature" },
            { id: "turn-entry-3", name: "Goblin 2", kind: "creature" },
          ],
          activeItemIndex: 0,
        }),
      },
      // The ruler: startRuler opens it, and ~300 ms later it's "placed" as
      // window.devRuler describes, or a default 20 ft sphere / 15 ft cone /
      // 100 ft line from the origin, reported through onRulerEvent.
      rulers: {
        getDistanceUnitsForThisCampaign: async () => ({ name: "ft", numberPerTile: 5 }),
        startRuler: async (kind) => {
          const id = `ruler-${Date.now()}`;
          const P = (x, y, z) => ({ x, y, z });
          const shapes = {
            sphere: { startPosition: P(0, 0, 0), endPosition: P(4, 0, 0) },
            cone: { startPosition: P(0, 0, 0), endPosition: P(3, 0, 0), angle: 53.13 },
            line: { positions: [P(0, 0, 0), P(20, 0, 0)] },
          };
          const ruler = { id, beingEdited: false, ...(window.devRuler || shapes[kind]) };
          window.devLastRuler = ruler;
          setTimeout(() => onRulerEvent({ kind: "rulerResult", payload: { ruler } }), 300);
          // Drag the placed ruler: devMoveRuler({ endPosition: {...} }), or devPutAwayRuler()
          window.devMoveRuler = (patch) => {
            Object.assign(window.devLastRuler, patch);
            onRulerEvent({ kind: "rulerResult", payload: { ruler: { ...window.devLastRuler } } });
          };
          window.devPutAwayRuler = () => onRulerEvent({ kind: "rulerRemoved", payload: { rulerId: id } });
          return id;
        },
        getMoreInfo: async (ids) => (window.devLastRuler && ids.includes(window.devLastRuler.id) ? [window.devLastRuler] : []),
      },
      // Loop sync messages back to this panel so the grant/accept/revoke flow is
      // exercisable solo: you play both caster and recipient.
      sync: {
        send: async (str) => {
          console.log("[dev] sync.send", str);
          setTimeout(() => onSyncMessage({ kind: "syncMessageReceived", payload: { str } }), 150);
          return {};
        },
        multiSend: log("sync.multiSend"),
        getClientsConnected: async () => [{ id: "dev-client", player: { id: "dev-other", name: "Kree (dev)" } }],
      },
      system: { clipboard: { setText: log("clipboard.setText") } },
    };
    // A fake bridge plugin. It writes HP into the fixture creatures and fires
    // the change event, as TaleSpire would after a real write.
    if (window.devBridge !== false) {
      Bridge.useTransport(async (method, path, params) => {
        console.log("[dev] bridge", method, path, params || "");
        if (path === "/ping") return { ok: true, version: "dev" };
        if (path === "/whoami") return { ok: true, canGm: true };
        if (path === "/creatures") {
          return { ok: true, creatures: Object.values(devCreatures).filter((c) => c.position).map((c) => ({
            id: c.id, name: c.name, ...c.position, scale: c.morphs?.[0]?.scale || 1, hidden: Boolean(c.isExplicitlyHidden),
          })) };
        }
        if (path === "/zone" && method === "POST") {
          const id = `zone-${params.ruler}-${(window.devZones || []).length}`;
          window.devZones = [...(window.devZones || []), { id, name: params.name, kind: params.kind, handles: params.handles }];
          return { ok: true, id, from: "ruler" };
        }
        if (path === "/initiative" && method === "GET") {
          const q = window.devQueue || { items: [], activeItemIndex: -1 };
          return { ok: true, items: q.items.map((i) => ({ id: i.id, kind: "creature" })), current: q.items[q.activeItemIndex]?.id || null };
        }
        if (path === "/initiative-set" && method === "POST") {
          const prev = window.devQueue || { items: [], activeItemIndex: -1 };
          const cur = prev.items[prev.activeItemIndex]?.id;
          const items = params.order.split(",").filter(Boolean).map((id) => ({ id, name: devCreatures[id]?.name || id, kind: "creature" }));
          const idx = Math.max(0, items.findIndex((i) => i.id === cur));
          window.devQueue = { items, activeItemIndex: items.length ? idx : -1 };
          setTimeout(() => onInitiativeEvent({ kind: "initiativeUpdated", payload: { queue: window.devQueue } }), 50);
          return { ok: true, count: items.length };
        }
        if (path === "/ruler" && method === "POST") {
          // The box ruler: placed ~300 ms later as window.devBox's corners
          const id = `box-${Date.now()}`;
          window.devBoxRuler = { id, kind: params.kind, editing: false,
            handles: window.devBox || [{ x: -1, y: 0, z: -1 }, { x: 3, y: 0, z: 3 }] };
          return { ok: true, id };
        }
        if (path === "/ruler-info" && method === "GET") {
          const r = window.devBoxRuler;
          return r && r.id === params.id ? { ok: true, kind: r.kind, editing: r.editing, handles: r.handles } : { ok: true, gone: true };
        }
        if (path === "/zone-info" && method === "GET") {
          const zone = (window.devZones || []).find((x) => x.id === params.id);
          if (!zone) return { ok: true, gone: true };
          const handles = (zone.handles || "").split(";").filter(Boolean).map((t) => {
            const [x, y, z] = t.split(",").map(Number);
            return { x, y, z };
          });
          return { ok: true, name: zone.name, kind: zone.kind, handles };
        }
        if (path === "/zone-remove" && method === "POST") {
          window.devZones = (window.devZones || []).filter((z) => z.id !== params.id);
          return { ok: true };
        }
        if (path === "/statuses") {
          // A stand-in for TaleSpire's emote catalog; e1 and e2 are on Kree
          return { ok: true, statuses: [
            { id: "e1", name: "Knocked down", icon: "knocked" },
            { id: "e2", name: "Poisoned", icon: "poison" },
            { id: "e3", name: "Bleeding", icon: "blood" },
            { id: "e4", name: "Asleep", icon: "zzz" },
            { id: "e5", name: "Burning", icon: "fire" },
          ] };
        }
        if (path === "/emote" && method === "POST") {
          const c = devCreatures[params.id];
          if (!c) return { ok: false, error: "creature not on this board" };
          const ids = new Set(c.idsOfActivePersistentEmotes || []);
          if (params.on === "0") ids.delete(params.emote); else ids.add(params.emote);
          c.idsOfActivePersistentEmotes = [...ids];
          setTimeout(() => onCreatureStateChange({ kind: "emotesChanged", payload: { id: params.id } }), 100);
          return { ok: true };
        }
        if (path === "/stat" && method === "POST") {
          const c = devCreatures[params.id];
          const i = Number(params.index);
          if (!c?.stats?.[i]) return { ok: false, error: "no such stat" };
          c.stats[i] = { ...c.stats[i], value: Number(params.value), max: params.max != null ? Number(params.max) : c.stats[i].max };
          setTimeout(() => onCreatureStateChange({ kind: "statChanged", payload: { id: params.id } }), 100);
          return { ok: true };
        }
        if (path === "/hp" && method === "POST") {
          const c = devCreatures[params.id];
          if (!c) return { ok: false, error: "creature not on this board" };
          const max = params.max != null ? Number(params.max) : c.hp?.max ?? 0;
          c.hp = { name: "HP", value: Number(params.value), max };
          setTimeout(() => onCreatureStateChange({ kind: "hpChanged", payload: { id: params.id } }), 100);
          return { ok: true };
        }
        return { ok: false, error: "no such route" };
      });
    } else {
      Bridge.useTransport(async () => { throw new Error("dev: bridge absent"); });
    }
    App.boot();
  }
});
