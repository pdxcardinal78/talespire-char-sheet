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

      Party.configure({
        onGrant: onEffectGranted,
        onRevoke: onEffectRevoked,
        onAck: onEffectAck,
        onVitals: onVitalsFromPlayer,
        onTemp: onTempFromGm,
        onHit: onHitFromGm,
      });
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
  const APP_VERSION = "0.14.0";

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

    const named = groups.filter((g) => /damage/i.test(g.name || ""));
    const use = named.length ? named : groups;

    let amount = 0;
    for (const g of use) {
      const value = await TS.dice.evaluateDiceResultsGroup(g);
      if (!failed(value)) amount += value;
    }
    if (!amount) return;

    offerDamageToFight({
      rollId: payload.rollId,
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
  async function applyOfferedDamage(combatant, entry) {
    if (!combatant) return;
    const onBoard = Encounters.hpFor(combatant).source === "board";
    if (onBoard && !writesBoard(combatant)) {
      return toast("This mini's hit points live on the board — change them there.", true);
    }
    if (!(await setCombatantHp(combatant, `-${entry.amount}`))) return;
    Encounters.dismissDamage(entry.rollId);
    toast(`${entry.amount} damage to ${combatant.label}.`);
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
        mode: modeFromEvent(ev),
        // monster + damageExpr let a GM's attack against a target with a known
        // AC resolve itself; see resolveMonsterAttack
        context: {
          kind: spec.kind, creatureId: state.speaker?.id || null, target: state.target,
          monster: true, damageExpr: spec.damage || null, source: spec.name,
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
      await Rolls.post(Rolls.bold(text), state.speaker?.id || null);
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
    { name: "Bless", bonus: "1d4", targets: ["attack", "save"], conc: true },
    { name: "Bane", bonus: "-1d4", targets: ["attack", "save"], conc: true },
    // Guidance runs its minute whether or not the die has been spent, and the
    // panel has no way to know which check the player is saving it for — so it
    // stays armed and the player ends it themselves (suspend, ×, or dropping
    // concentration). Marked `once`, it switched itself off after the first
    // check of the cast and silently stopped buffing the rest of the minute.
    { name: "Guidance", bonus: "1d4", targets: ["check"], conc: true },
    { name: "Resistance", bonus: "1d4", targets: ["save"], once: true, conc: true },
    { name: "Bardic Inspiration", bonus: "1d6", targets: ["attack", "save", "check"], once: true },
    { name: "Shield of Faith", bonus: "+2", targets: ["ac"], conc: true },
    { name: "Shield", bonus: "+5", targets: ["ac"] },
    { name: "Haste", bonus: "+2", targets: ["ac"], conc: true },
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
    // A concentration record pointing at an effect that no longer costs it.
    if (play.concentration && !play.effects.some((fx) => fx.id === play.concentration.effectId && fx.conc)) {
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
      active: true,
      // Set when the effect came from somebody else's panel.
      fromId: effect.fromId || null,
      fromName: effect.fromName || null,
      // Set on the granter's copy: who it went to and whether they took it.
      grantedTo: effect.grantedTo || null,
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

  // -------------------------------------------------------------------------
  // Concentration
  //
  // Only meaningful because effects can be granted: concentration is the thing
  // that takes them back. One spell at a time; starting a second ends the first
  // and pulls every effect it handed out.
  // -------------------------------------------------------------------------

  async function startConcentration(effect) {
    const play = state.sheet.play;

    if (play.concentration && play.concentration.effectId !== effect.id) {
      await endConcentration({ silent: true });
      toast(`Concentration moved to ${effect.name}.`);
    }

    play.concentration = { name: effect.name, effectId: effect.id };
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
    play.concentration = null;
    renderConcentration();
    savePlay();

    if (!silent) {
      await announce(`stops concentrating on ${Rolls.bold(conc.name)}`);
      toast(`${conc.name} ended.`);
    }
  }

  function renderConcentration() {
    const bar = $("concentration");
    const conc = state.sheet?.play?.concentration;
    bar.classList.toggle("hidden", !conc);
    if (conc) $("conc-label").textContent = `Concentrating on ${conc.name}`;
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
        await Party.grant(fx, reachable.map((r) => r.id), state.me);
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

  function renderEffects() {
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

      const detail = [
        fx.weapon ? fx.weapon : signedBonus(fx.bonus),
        fx.die ? `${fx.die}${fx.damageType ? ` ${fx.damageType}` : ""}` : null,
        fx.ability ? `uses ${fx.ability.toUpperCase()}` : null,
        fx.weapon ? null : fx.targets.join(", "),
        fx.once ? "once" : null,
        fx.conc ? "concentration" : null,
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
      remove.onclick = async () => {
        if (fx.grantedTo?.length) {
          await Party.revoke(fx.id, fx.grantedTo.map((r) => r.id)).catch(() => {});
        }
        if (state.sheet.play.concentration?.effectId === fx.id) {
          state.sheet.play.concentration = null;
          renderConcentration();
        }
        removeEffect(fx);
      };

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
    const temp = play.hp.temp ? ` +${play.hp.temp}` : "";
    $("v-hp").textContent = `${play.hp.current}/${max}${mods.length ? "*" : ""}${temp}`;
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
      Party.reportVitals(creatureId, s.play.hp.current, effectiveMaxHp(s), s.play.hp.temp || 0)
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
    if (!info?.hp || !(info.hp.max > 0)) return;
    const tempStat = Vitals.tempStatOf(info);
    const seen = { hp: info.hp.value, temp: tempStat ? tempStat.value : null };
    const before = lastBoardVitals;
    lastBoardVitals = seen;
    if (!before) return; // first look: nothing has moved yet

    const play = s.play;
    let changed = false;
    if (seen.hp !== before.hp && seen.hp !== play.hp.current) {
      play.hp.current = Math.max(0, Math.min(effectiveMaxHp(s), seen.hp));
      changed = true;
    }
    if (tempStat && seen.temp !== before.temp && seen.temp !== play.hp.temp) {
      play.hp.temp = Math.max(0, seen.temp || 0);
      changed = true;
    }
    if (changed) {
      renderHp(s);
      savePlay();
      toast(`HP updated from the board: ${play.hp.current}/${effectiveMaxHp(s)}${play.hp.temp ? ` +${play.hp.temp} temp` : ""}.`);
    }
  }

  /** The GM set this character's temp pool (campaigns without a Temp HP stat). */
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

  /** A player's panel reported its vitals; as GM, keep the mini in step. */
  async function onVitalsFromPlayer({ creatureId, hp, max, temp }) {
    if (!state.isGM || !creatureId) return;
    Vitals.report(creatureId, { hp, max, temp });
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
      chip.innerHTML = `<span>Hit dice ${hd.die}</span><span class="hd-count">${left}/${hd.total}</span>`;

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

  function renderPending() {
    const box = $("pending-damage");
    box.replaceChildren();
    box.classList.toggle("hidden", state.pending.length === 0);

    for (const entry of state.pending) {
      const row = document.createElement("div");
      row.className = "pending-row";

      const label = document.createElement("span");
      label.className = "pending-label";
      label.textContent = `${entry.name} hit for ${entry.total}${entry.crit ? " — CRIT" : ""}`;
      row.appendChild(label);

      if (entry.crit) {
        row.appendChild(
          button(`Crit ${Rolls.critical(entry.damage)}`, "btn-primary", (mode) => rollPending(entry, true, mode))
        );
      }
      row.appendChild(
        button(`Damage ${entry.damage}`, entry.crit ? "" : "btn-primary", (mode) => rollPending(entry, false, mode))
      );

      const dismiss = document.createElement("button");
      dismiss.className = "btn btn-small btn-ghost";
      dismiss.textContent = "Miss";
      dismiss.onclick = () => {
        state.pending = state.pending.filter((e) => e !== entry);
        renderPending();
      };
      row.appendChild(dismiss);

      box.appendChild(row);
    }
  }

  async function rollPending(entry, crit, mode) {
    state.pending = state.pending.filter((e) => e !== entry);
    renderPending();
    await doRoll({
      name: `${entry.name} damage${crit ? " (crit)" : ""}`,
      damage: crit ? Rolls.critical(entry.damage) : entry.damage,
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

    if (!play.conditions.length) {
      const empty = document.createElement("span");
      empty.className = "hint";
      empty.textContent = "No conditions";
      box.appendChild(empty);
    }

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
      remove.onclick = async () => {
        play.conditions = play.conditions.filter((x) => x !== c);
        renderConditions();
        savePlay();
        await announce(`is no longer ${Rolls.bold(c.name)}`);
      };

      chip.appendChild(remove);
      box.appendChild(chip);
    }

    // Keep the picker to conditions not already applied.
    const pick = $("condition-pick");
    const current = new Set(play.conditions.map((c) => c.name));
    const chosen = pick.value;
    pick.replaceChildren();
    for (const name of CONDITION_NAMES) {
      if (current.has(name)) continue;
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      pick.appendChild(opt);
    }
    if ([...pick.options].some((o) => o.value === chosen)) pick.value = chosen;
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

  async function addCondition(name) {
    const play = state.sheet.play;
    if (!name || play.conditions.some((c) => c.name === name)) return;
    play.conditions.push({ name, level: name === "Exhaustion" ? 1 : null });
    renderConditions();
    savePlay();
    await announce(`is ${Rolls.bold(name)}`);
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
    });
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
    const el = $("init-queue");

    if (!queue || !queue.items?.length) {
      el.textContent = "Not in initiative";
      el.classList.remove("is-turn");
      return;
    }

    const active = queue.items[queue.activeItemIndex];
    const mine = state.creatureId
      ? queue.items.findIndex((i) => i.id === state.creatureId)
      : -1;

    if (mine >= 0 && mine === queue.activeItemIndex) {
      el.textContent = "Your turn";
      el.classList.add("is-turn");
    } else {
      el.classList.remove("is-turn");
      const position = mine >= 0 ? ` · you are ${mine + 1}/${queue.items.length}` : "";
      el.textContent = `Turn: ${active?.name || "—"}${position}`;
    }
  }

  function renderBindBar() {
    const status = $("bind-status");
    const btn = $("bind-btn");

    if (state.creatureId) {
      status.textContent = "Linked to a mini — rolls post as this character";
      status.classList.add("is-bound");
      btn.textContent = "Unlink";
      btn.onclick = async () => {
        await Store.unbind(state.creatureId);
        state.creatureId = null;
        renderBindBar();
      };
    } else {
      status.textContent = state.selection.length
        ? "A mini is selected — link it to this sheet"
        : "No mini linked";
      status.classList.remove("is-bound");
      btn.textContent = "Link selected mini";
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

  function renderAttacks(s) {
    const box = $("attacks");
    box.replaceChildren();

    if (!s.attacks.length) {
      box.innerHTML = '<p class="hint">No weapons on this sheet.</p>';
      return;
    }

    for (const raw of s.attacks) {
      const a = applyWeaponEffects(raw);
      const sub = [
        a.kind,
        a.damageType,
        a.modifiedBy.length ? a.modifiedBy.join(", ") : null,
        a.equipped ? null : "not equipped",
        a.proficient ? null : "not proficient",
      ]
        .filter(Boolean)
        .join(" · ");

      box.appendChild(
        rollRow({
          name: a.modifiedBy.length ? `${a.name} ✦` : a.name,
          sub,
          value: DDB.signed(a.toHit),
          tag: a.damageRoll, // parked until the DM calls the hit
          // Attack only. Damage waits for the DM to call the hit — see renderPending.
          onRoll: (mode) =>
            doRoll({ name: a.name, roll: a.attackRoll, mode, kind: "attack", damage: null, parkedDamage: a.damageRoll }),
        })
      );
    }
  }

  function renderResources(s) {
    const box = $("resources");
    box.replaceChildren();

    if (s.resources.length) {
      const h = document.createElement("h2");
      h.textContent = "Limited use";
      box.appendChild(h);
      for (const r of s.resources) box.appendChild(resourceRow(s, r));
    }

    // Choices that cost nothing to pick, so they get no counter — just the menu.
    if (s.choiceActions?.length) {
      const h = document.createElement("h2");
      h.textContent = "Options";
      box.appendChild(h);
      for (const a of s.choiceActions) box.appendChild(optionRow(a, null));
    }
  }

  /**
   * A resource with choices: pick which effect you're spending it on, so the chat
   * line says "uses Channel Divinity: Divine Spark" and the right dice get rolled.
   */
  function resourceRow(s, r) {
    const used = s.play.resourcesUsed[r.name] || 0;
    const left = r.max - used;

    const wrap = document.createElement("div");
    wrap.className = "resource";

    const row = document.createElement("div");
    row.className = "resource-head";
    row.innerHTML =
      `<span class="rr-name">${escapeHtml(r.name)}<br><span class="rr-sub">resets on ${escapeHtml(r.resetsOn)}</span></span>` +
      `<span class="rr-value">${left}/${r.max}</span>`;

    const undo = document.createElement("button");
    undo.className = "btn btn-small btn-ghost";
    undo.textContent = "↺";
    undo.title = "Give one back";
    undo.disabled = used <= 0;
    undo.onclick = () => {
      s.play.resourcesUsed[r.name] = Math.max(0, used - 1);
      renderResources(s);
      savePlay();
    };
    row.appendChild(undo);
    wrap.appendChild(row);

    wrap.appendChild(optionRow(r, () => {
      s.play.resourcesUsed[r.name] = used + 1;
      renderResources(s);
      savePlay();
    }, left));

    return wrap;
  }

  /**
   * The choice menu shared by limited-use resources and free options.
   * `spend` is null for things that cost nothing.
   */
  function optionRow(owner, spend, left = Infinity) {
    const box = document.createElement("div");
    box.className = "option-row";

    const options = owner.options || [];
    let selected = options[0] || null;

    const detail = document.createElement("p");
    detail.className = "option-detail";

    function describe() {
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
      pick.onchange = () => {
        selected = options[Number(pick.value)];
        describe();
      };
      box.appendChild(pick);
    }

    const use = document.createElement("button");
    use.className = "btn btn-small";
    use.textContent = spend ? "Use" : "Announce";
    use.disabled = spend ? left <= 0 : false;
    use.onclick = async () => {
      if (spend) spend();

      const label = selected ? `${owner.name}: ${selected.name}` : owner.name;
      const save = selected?.save ? ` — ${selected.save.ability} save DC ${selected.save.dc}` : "";
      await announce(`uses ${Rolls.bold(label)}${save}`);

      // Roll whatever the chosen option actually rolls.
      if (selected?.roll) {
        // Not necessarily damage — Divine Spark's 1d8 is a heal or a hit depending
        // on which half of the feature you used — so the roll carries its own name.
        await doRoll({ name: label, damage: selected.roll, damageName: label, kind: "damage" });
      }
    };
    box.appendChild(use);

    describe();
    box.appendChild(detail);
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

    for (const block of s.spellcasting.blocks) {
      const head = document.createElement("h2");
      head.textContent = block.ability
        ? `${block.className} — DC ${block.saveDc}, attack ${DDB.signed(block.attackBonus)}`
        : block.className;
      box.appendChild(head);

      const byLevel = {};
      for (const sp of block.spells) (byLevel[sp.level] ||= []).push(sp);

      for (const lvl of Object.keys(byLevel).sort((a, b) => a - b)) {
        const label = document.createElement("div");
        label.className = "spell-level";
        label.textContent = lvl === "0" ? "Cantrips" : `Level ${lvl}`;
        box.appendChild(label);
        for (const sp of byLevel[lvl]) box.appendChild(spellCard(sp, block));
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

      const head = document.createElement("h2");
      head.textContent = `${source} — always prepared`;
      box.appendChild(head);

      const note = document.createElement("p");
      note.className = "hint";
      note.textContent =
        "D&D Beyond names these in your subclass but doesn't include them in its export, " +
        "so the details come from the bundled 2024 SRD.";
      box.appendChild(note);

      for (const g of entries.sort((a, b) => (a.spell?.level ?? 9) - (b.spell?.level ?? 9))) {
        if (!g.spell) {
          const miss = document.createElement("div");
          miss.className = "hint dimmed";
          miss.textContent = `${titleCase(g.name)} — granted at level ${g.atLevel}, not in the bundled SRD.`;
          box.appendChild(miss);
          continue;
        }
        box.appendChild(spellCard(g.spell, block));
      }
    }
  }

  const titleCase = (t) =>
    String(t || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());

  /** Slot pips double as the tracker: click one to spend or give back. */
  function renderSlots(s) {
    const box = $("slots");
    box.replaceChildren();

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
    chip.title = "Click to spend, right-click to give one back";
    chip.innerHTML = `${label} <span class="slot-count">${left}/${available}</span>`;

    chip.onclick = () => {
      if (used >= available) return;
      setUsed(used + 1);
      renderSlots(state.sheet);
      savePlay();
    };
    chip.oncontextmenu = (ev) => {
      ev.preventDefault();
      if (used <= 0) return;
      setUsed(used - 1);
      renderSlots(state.sheet);
      savePlay();
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

  function spellCard(sp, block) {
    const card = document.createElement("div");
    card.className = "spell";

    const head = document.createElement("button");
    head.className = "spell-head";
    const dice = sp.damage?.[0]?.roll || sp.healing;
    head.innerHTML =
      `<span class="sp-name">${sp.prepared ? '<span class="prepared-dot">●</span> ' : ""}${escapeHtml(sp.name)}</span>` +
      (dice ? `<span class="sp-tag">${escapeHtml(dice)}</span>` : "") +
      (sp.upcast ? '<span class="sp-tag">scales</span>' : "") +
      (sp.limitedUse ? '<span class="sp-tag">free use</span>' : "") +
      (sp.concentration ? '<span class="sp-tag">conc.</span>' : "");

    const body = document.createElement("div");
    body.className = "spell-body hidden";

    head.onclick = () => {
      // Rebuild on open so slot counts and upcast dice are always current.
      body.replaceChildren();
      buildSpellBody(body, sp, block);
      body.classList.toggle("hidden");
    };

    card.append(head, body);
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
          button(`Attack ${DDB.signed(block.attackBonus)}${dmgHint}`, "btn-primary", (mode) =>
            doRoll({
              name: sp.name,
              roll: `d20${DDB.signed(block.attackBonus)}`,
              mode,
              kind: "attack",
              parkedDamage: rolls.damage,
            })
          )
        );
      }

      if (sp.requiresSavingThrow && block.saveDc) {
        actions.appendChild(
          button(`Post DC ${block.saveDc}`, "", () =>
            announce(`casts ${Rolls.bold(sp.name)} — ${sp.saveAbility || ""} save DC ${block.saveDc}`.trim())
          )
        );
      }

      if (rolls.damage && !sp.requiresAttackRoll) {
        actions.appendChild(
          button(`Damage ${rolls.damage}`, "", (mode) =>
            doRoll({ name: sp.name, damage: rolls.damage, mode, kind: "damage" })
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
          "btn-ghost",
          async () => {
            await castSpell(sp, chosen, chosenKind);
            refresh();
          }
        );
        cast.disabled = !opt || opt.left <= 0;
        actions.appendChild(cast);
      }

      actions.appendChild(button("Post to chat", "btn-ghost", () => announce(`casts ${Rolls.bold(sp.name)}`)));
    }

    drawLevels();
    drawActions();
    body.append(meta, desc, levelRow, actions);
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

    for (const sv of s.savingThrows) {
      const row = rollRow({
        name: sv.name,
        sub: "",
        value: DDB.signed(sv.value),
        tag: [sv.proficient ? "●" : "", sv.conditionalAdvantage.length ? "adv*" : ""].filter(Boolean).join(" "),
        onRoll: (mode) =>
          doRoll({ name: `${sv.name} save`, roll: `d20${DDB.signed(sv.value)}`, mode, kind: "save" }),
      });
      if (sv.conditionalAdvantage.length) row.title = `Advantage ${sv.conditionalAdvantage.join("; ")}`;
      saves.appendChild(row);
    }

    const note = $("saves-note");
    note.replaceChildren();
    if (caveats.length) {
      note.textContent = `adv* — advantage ${caveats.join("; ")}`;
    }

    const abilities = $("abilities");
    abilities.replaceChildren();
    for (const [key, ab] of Object.entries(s.abilities)) {
      abilities.appendChild(
        rollRow({
          name: ab.name,
          sub: `score ${ab.score}`,
          value: DDB.signed(ab.mod),
          onRoll: (mode) =>
            doRoll({ name: `${ab.name} check`, roll: `d20${DDB.signed(ab.mod)}`, mode, kind: "check" }),
        })
      );
    }

    const skills = $("skills");
    skills.replaceChildren();
    for (const sk of s.skills) {
      skills.appendChild(
        rollRow({
          name: sk.name,
          sub: sk.ability.toUpperCase(),
          value: DDB.signed(sk.value),
          tag: sk.expertise ? "◆" : sk.proficient ? "●" : "",
          onRoll: (mode) => doRoll({ name: sk.name, roll: `d20${DDB.signed(sk.value)}`, mode, kind: "check" }),
        })
      );
    }
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
        bonuses: fx.dice,
        mode: spec.mode || state.mode,
        // parkedDamage rides along so the result handler can arm a damage button
        // once the DM calls the hit.
        context: { kind: spec.kind, target: state.target, parkedDamage: spec.parkedDamage || null },
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

    // The extra dice of a monster's crit, rolled after the attack landed
    if (ctx.kind === "critExtra") {
      await applyMonsterDamage(ctx.target, (ctx.base || 0) + (summary.damage || 0), ctx.source, ctx.creatureId, true);
      return;
    }

    await Rolls.post(line, ctx.creatureId || state.creatureId);
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
    if (state.isGM && summary.damage != null && ctx.kind !== "healing" && ctx.kind !== "hitdie") {
      offerDamageToFight({
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
        total: summary.total,
        crit: summary.natural === 20,
      });
      renderPending();
    }
  }

  async function announce(text) {
    await Rolls.post(text, state.creatureId);
  }

  /** "1d6+3+2d6" -> "1d6+2d6": the dice a crit adds again, without the modifier. */
  const diceOnly = (expr) => (String(expr || "").match(/\d*d\d+/g) || []).join("+");

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
          context: { kind: "critExtra", target: ctx.target, base, source: ctx.source, creatureId: ctx.creatureId },
        });
        renderStaged();
      } catch (e) {
        toast(`Crit dice: ${e.message}. Applying the normal damage.`, true);
        await applyMonsterDamage(ctx.target, base, ctx.source, ctx.creatureId, false);
      }
      return;
    }
    await applyMonsterDamage(ctx.target, base, ctx.source, ctx.creatureId, false);
  }

  /**
   * Put a monster's damage onto its target, temp HP first. With the bridge it
   * goes straight onto the mini (and the player's panel follows the board).
   * Without it, the player's panel is told to apply it; either way chat says
   * what happened.
   */
  async function applyMonsterDamage(target, amount, source, speakerId, crit) {
    const who = target?.name || "the target";
    const what = `${source || "The monster"}${crit ? " crits" : " hits"} ${who} for ${amount}`;
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
      await Rolls.post(Rolls.bold(line), speakerId);
      return toast(line);
    }

    // No bridge: the player's own panel applies it (temp first) if it's open
    await Party.hit(target.id, amount, source).catch(() => {});
    await Rolls.post(Rolls.bold(`${what}.`), speakerId);
    toast(`${what}. Sent to their panel to apply; if it's closed, they'll need to apply it by hand.`);
  }

  // -------------------------------------------------------------------------
  // Targeting
  // -------------------------------------------------------------------------

  function setTargetStatus(text, hasTarget) {
    const status = $("target-status");
    status.textContent = text;
    status.classList.toggle("has-target", Boolean(hasTarget));
    $("clear-target").classList.toggle("hidden", !hasTarget);
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
        setTargetStatus(state.target ? `Target: ${state.target.name}` : "No target", Boolean(state.target));
        return toast(`${combatant.label} linked to ${name}.`);
      }

      if (state.pickingSpeaker) {
        state.pickingSpeaker = false;
        state.speaker = { id: creatureId, name };
        renderSpeaker();
        setTargetStatus(state.target ? `Target: ${state.target.name}` : "No target", Boolean(state.target));
        return toast(`Rolls now post as ${name}.`);
      }

      const acStat = (info.stats || []).find((st) => /^ac$|armou?r/i.test(st.name || ""));
      const ac = acStat && Number.isFinite(acStat.value) ? acStat.value : null;

      state.target = { id: creatureId, name, ac };

      setTargetStatus(
        ac != null
          ? `Target: ${name} (AC ${ac})`
          : `Target: ${name} — AC not visible${state.isGM ? " (no AC stat set)" : " to you"}`,
        true
      );
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

    const amount = () => Math.max(0, parseInt($("hp-amount").value, 10) || 0);
    $("hp-damage").onclick = () => applyHp(-amount());
    $("hp-heal").onclick = () => applyHp(amount());
    $("maxhp-add").onclick = () => {
      const n = parseInt($("maxhp-amount").value, 10);
      if (!Number.isFinite(n) || !n) return toast("Enter how much the maximum changes, e.g. 5 or -7.", true);
      addMaxHpMod(n, $("maxhp-name").value);
      $("maxhp-name").value = "";
    };
    $("hp-temp-add").onclick = () =>
      grantTempHp(Math.max(0, parseInt($("hp-temp-amount").value, 10) || 0));

    $("effect-custom-toggle").onclick = () => $("effect-custom").classList.toggle("hidden");
    $("conc-drop").onclick = () => endConcentration();
    $("condition-add").onclick = () => addCondition($("condition-pick").value);
    $("condition-pick").onchange = renderConditionPreview;
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
    });

    // The bridge appearing or going away changes which HP boxes are editable
    Bridge.onChange((st) => {
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

      addEffect({ name, bonus, targets, once: $("effect-once").checked });
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
  function onCreatureEvent(event) {
    if (state.creatureId && event?.payload?.id === state.creatureId) {
      clearTimeout(followTimer);
      followTimer = setTimeout(followLinkedMini, 150);
    }
    const structural = event?.kind === "creatureAdded" || event?.kind === "creatureRemoved";
    if (!structural && !Encounters.isWatching(event?.payload?.id)) return;
    clearTimeout(encounterBoardTimer);
    encounterBoardTimer = setTimeout(refreshBoardHp, 150);
  }

  return { boot, wire, onCreatureEvent, onRollLanded, onRollRemoved: renderStaged, onPickingEnded, showParty, showBestiary, showEncounters, onForeignRoll: offerForeignRoll, onSelectionChanged, onTargetPicked, onInitiativeUpdated: renderInitiative, state };
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
        getQueue: async () => ({
          items: [
            { id: "turn-entry-1", name: "Gnoll Pack Lord", kind: "creature" },
            { id: "turn-entry-2", name: "Aranis", kind: "creature" },
            { id: "turn-entry-3", name: "Goblin 2", kind: "creature" },
          ],
          activeItemIndex: 0,
        }),
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
