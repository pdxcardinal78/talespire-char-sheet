/**
 * Encounters: the monsters for a fight, and what's left of them.
 *
 * A session usually has more than one fight prepared, so encounters are saved by
 * name in campaign storage and called up when the party walks into them. Each
 * combatant is one mini's worth of monster — three goblins are three combatants,
 * not one with a count — because they take damage separately and die separately.
 *
 * On hit points there are two possible truths and they have to be ranked. A mini
 * on the board carries its own HP, visible to everyone; a Symbiote cannot write
 * it, but a GM sees it live. So: if a linked mini has hit points set in
 * TaleSpire, the board wins. If it doesn't, and plenty of GMs never fill them
 * in, the panel keeps the count itself. One number, always, and it says where
 * it came from.
 *
 * With the bridge plugin running on the GM's machine (see lib/bridge.js), the
 * board is writable: edits to a linked combatant go onto the mini, so the
 * board stays the one truth and every player sees the change.
 */

const Encounters = (() => {
  let deps = {};          // { list, detail, onError, onOpenMonster, onRoll }
  let current = null;     // encounter being run
  let boardHp = new Map();// creatureId -> { value, max } straight off the board
  let queue = null;       // TaleSpire's initiative queue
  let selectedId = null;  // combatant the next damage lands on
  let inbox = [];         // damage rolled elsewhere on the board, awaiting a target

  function configure(d) {
    deps = d;
  }

  const uid = () => `c-${Math.random().toString(36).slice(2, 9)}`;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // --- model ---------------------------------------------------------------

  /**
   * Add a monster to an encounter. `count` makes three goblins three rows, each
   * numbered, because that is how they will be killed.
   */
  function addMonster(encounter, monster, count = 1) {
    const existing = encounter.combatants.filter((c) => c.slug === monster.slug).length;
    for (let i = 0; i < count; i += 1) {
      const n = existing + i + 1;
      encounter.combatants.push({
        id: uid(),
        slug: monster.slug,
        name: monster.name,
        label: count > 1 || existing ? `${monster.name} ${n}` : monster.name,
        maxHp: monster.hp ?? null,
        hp: monster.hp ?? null,
        ac: monster.ac ?? null,
        creatureId: null,
        // Bundled monsters are looked up by slug; anything from Open5e has to
        // travel with the encounter or it would vanish offline.
        cached: monster.bundled ? null : monster,
      });
    }
    return encounter;
  }

  function removeCombatant(encounter, combatantId) {
    encounter.combatants = encounter.combatants.filter((c) => c.id !== combatantId);
  }

  /**
   * Record hit points just written through the bridge, so the row shows them
   * before TaleSpire's change event comes back round.
   */
  function noteBoardHp(creatureId, value, max, temp) {
    if (!creatureId) return;
    const prev = boardHp.get(creatureId) || {};
    boardHp.set(creatureId, { ...prev, value, max, temp: temp ?? prev.temp ?? null });
    render();
  }

  /** Is this combatant linked to a mini we've been told about? */
  const isWatching = (creatureId) =>
    Boolean(creatureId && current?.combatants.some((c) => c.creatureId === creatureId));

  /** Which hit points to believe, and why. */
  function hpFor(combatant) {
    const board = combatant.creatureId ? boardHp.get(combatant.creatureId) : null;
    // Temp HP lives on the mini when the campaign has a Temp HP stat, otherwise
    // on the combatant here; monsters have no player panel to report it.
    const onStat = board && board.tempIndex != null;
    const temp = onStat ? board.temp ?? 0 : combatant.temp || 0;
    const tempFields = {
      temp,
      tempSource: onStat ? "stat" : "panel",
      tempIndex: onStat ? board.tempIndex : null,
      tempMax: onStat ? board.tempMax : null,
    };
    if (board && board.max > 0) {
      return { value: board.value, max: board.max, source: "board", ...tempFields };
    }
    return { value: combatant.hp, max: combatant.maxHp, source: "panel", ...tempFields };
  }

  function applyDamage(combatant, amount) {
    const hp = hpFor(combatant);
    if (hp.source === "board") return false; // the board owns it; nothing to do here
    combatant.hp = Math.max(0, (combatant.hp ?? combatant.maxHp ?? 0) - amount);
    return true;
  }

  // --- damage rolled elsewhere ---------------------------------------------
  //
  // A Symbiote is told about every roll on the board, not just its own, so the
  // damage a player rolls for their hit arrives here. That is the number the GM
  // actually needs: the party rolls it, the GM applies it. It is never applied
  // automatically — a roll is not a hit, and only the GM knows whether it landed.

  const INBOX_LIMIT = 3;

  function select(combatantId) {
    selectedId = selectedId === combatantId ? null : combatantId;
    render();
  }

  const selected = () => current?.combatants.find((c) => c.id === selectedId) || null;

  function offerDamage(entry) {
    inbox = [entry, ...inbox.filter((e) => e.rollId !== entry.rollId)].slice(0, INBOX_LIMIT);
    render();
    deps.onInboxChange?.(inbox.length);
  }

  function dismissDamage(rollId) {
    inbox = inbox.filter((e) => e.rollId !== rollId);
    render();
    deps.onInboxChange?.(inbox.length);
  }

  // --- board and initiative ------------------------------------------------

  /**
   * Refresh what the board says about every linked mini.
   *
   * As well as hit points this backfills the mini's name onto the combatant.
   * Links made before names were stored would otherwise never match a turn
   * queue whose ids aren't creature ids — and asking a GM to re-link a fight
   * they already set up is not a fix. Returns true when something was filled in,
   * so the caller knows to save.
   */
  async function readBoard() {
    if (!current) return false;
    const ids = current.combatants.map((c) => c.creatureId).filter(Boolean);
    if (!ids.length) return false;

    const infos = await Board.creatureInfo(ids);

    boardHp = new Map();
    const names = new Map();
    for (const info of infos || []) {
      if (info?.hp) {
        const v = Vitals.read(info);
        boardHp.set(info.id, {
          conditions: Statuses.on(info).conditions,
          value: info.hp.value, max: info.hp.max,
          temp: v.tempSource === "stat" ? v.temp : null,
          tempIndex: v.tempIndex, tempMax: v.tempMax,
        });
      }
      if (info?.id && info.name) names.set(info.id, info.name);
    }

    let changed = false;
    for (const c of current.combatants) {
      const name = c.creatureId ? names.get(c.creatureId) : null;
      if (name && c.creatureName !== name) {
        c.creatureName = name;
        changed = true;
      }
    }
    return changed;
  }

  function setQueue(q) {
    queue = q || null;
    render();
  }

  /**
   * TaleSpire owns turn order — `getQueue` is read-only and there is no writer —
   * so the tracker reflects it rather than keeping an order of its own. Entries
   * are matched to combatants by the mini each is linked to.
   */
  /**
   * Match each turn to a combatant.
   *
   * The obvious key is the creature id, but the API describes a turn item's `id`
   * as identifying *the turn entry* — which is not promised to be the creature
   * it represents, and in practice did not match. So the id is tried first and
   * the mini's name second; the name is captured when the mini is linked
   * precisely so there is something to fall back to.
   *
   * A turn that matches nothing gets no label rather than being announced as
   * "not in this encounter". Most of those are the party, and calling a player's
   * character an outsider to the fight is worse than saying nothing.
   */
  const sameName = (a, b) =>
    Boolean(a) && Boolean(b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  let loggedKeys = false;

  function turnOrder() {
    if (!queue?.items?.length) return [];

    const combatants = current?.combatants || [];

    // One-time diagnostic: if nothing matches, this is the pair of keys to look at.
    if (!loggedKeys && combatants.some((c) => c.creatureId)) {
      loggedKeys = true;
      console.log(
        "[Spirekeeper] initiative ids:", queue.items.map((i) => i.id),
        "| linked creature ids:", combatants.map((c) => c.creatureId).filter(Boolean)
      );
    }

    // Claimed one at a time, so a combatant is never handed to two turns. Five
    // goblins share a name, and `find` would have given all five turns the same
    // Goblin 1 — the ids are what make them distinct, and only when they match.
    const pool = combatants.filter((c) => true);
    const claim = (predicate) => {
      const i = pool.findIndex(predicate);
      return i === -1 ? null : pool.splice(i, 1)[0];
    };

    // Three passes, strongest key first, each claiming from the same pool.
    //
    //   1. `turnId` — the GM said so outright. Nothing overrides that.
    //   2. `creatureId` — the mini this combatant is linked to, if the turn
    //      queue happens to key on creatures.
    //   3. name — a guess, resolved last and only with what is left.
    //
    // Names are the weakest because they are deliberately decoupled: a GM may
    // run a Goblin Boss statblock on a mini called Goblin Captain because they
    // liked the model. The statblock's name and the mini's name are different
    // facts about the same combatant, and neither is an identifier.
    const byKey = new Map();
    for (const item of queue.items) {
      const match = claim((c) => c.turnId && c.turnId === item.id);
      if (match) byKey.set(item, { combatant: match, how: "assigned" });
    }
    for (const item of queue.items) {
      if (byKey.has(item)) continue;
      const match = claim((c) => c.creatureId && c.creatureId === item.id);
      if (match) byKey.set(item, { combatant: match, how: "id" });
    }

    return queue.items.map((item, index) => {
      const exact = byKey.get(item) || null;
      // Same-named combatants are paired in queue order, which is the only
      // sensible reading when the names themselves cannot tell them apart.
      const loose = exact
        ? null
        : claim((c) => sameName(c.creatureName, item.name)) || claim((c) => sameName(c.label, item.name));

      return {
        ...item,
        // A queue that exists but has no active turn (index -1) is one TaleSpire
        // has kept around after leaving initiative. Nothing should look current.
        active: queue.activeItemIndex >= 0 && index === queue.activeItemIndex,
        combatant: exact?.combatant || loose,
        // Only a name match is a guess; the UI says so rather than implying certainty.
        matchedBy: exact ? exact.how : loose ? "name" : null,
        // Whatever is still unclaimed can be offered for manual assignment.
        unclaimed: pool.slice(),
      };
    });
  }

  /** True when TaleSpire is holding a queue but nobody's turn is current. */
  const queueIsIdle = () => Boolean(queue?.items?.length) && !(queue.activeItemIndex >= 0);

  // --- view ----------------------------------------------------------------

  function renderList(encounters) {
    const host = deps.list;
    host.replaceChildren();

    if (!encounters.length) {
      host.appendChild(el("p", "hint", "No encounters yet. Open a monster and press “Add to encounter”."));
      return;
    }

    for (const enc of encounters) {
      const row = el("div", `encounter-row${current && enc.id === current.id ? " is-open" : ""}`);
      const name = el("button", "encounter-name");
      name.innerHTML = `<span>${escape(enc.name)}</span><span class="sub">${enc.combatants.length} combatants</span>`;
      name.onclick = () => deps.onOpen(enc.id);
      row.appendChild(name);

      const del = el("button", "btn btn-small btn-ghost", "Delete");
      del.onclick = () => deps.onDelete(enc.id);
      row.appendChild(del);

      host.appendChild(row);
    }
  }

  function combatantRow(c) {
    const hp = hpFor(c);
    const share = hp.max ? Math.max(0, Math.min(1, (hp.value ?? 0) / hp.max)) : null;
    const state = hp.value === 0 ? "is-down" : share != null && share <= 0.25 ? "is-critical" : share != null && share <= 0.5 ? "is-bloodied" : "";

    const row = el("div", `combatant ${state} ${c.id === selectedId ? "is-selected" : ""}`.trim());

    const name = el("button", "combatant-name");
    name.innerHTML =
      `<span>${escape(c.label)}</span>` +
      `<span class="sub">${escape(c.creatureId ? "linked" : "no mini")}${c.ac != null ? ` · AC ${c.ac}` : ""}` +
      `${(boardHp.get(c.creatureId)?.conditions || []).map((n) => ` · <span class="cond-inline">${escape(n)}</span>`).join("")}</span>`;
    name.title = "Select — damage rolled on the board applies here";
    name.onclick = () => select(c.id);
    row.appendChild(name);

    const hpBox = el("div", "combatant-hp");
    const track = share != null
      ? `<span class="party-hp-track"><span class="party-hp-fill" style="width:${share * 100}%"></span></span>`
      : "";

    const writesBoard = Boolean(deps.canWriteBoard?.(c));
    if (hp.source === "board" && !writesBoard) {
      hpBox.innerHTML = `<span class="party-hp-text">${hp.value ?? "—"}${hp.max ? ` / ${hp.max}` : ""}${hp.temp > 0 ? ` +${hp.temp}` : ""}</span>${track}`;
      hpBox.title = "Hit points read from the mini on the board — change them in TaleSpire";
    } else {
      // The hit points are the control. Typing 12 sets them; typing -5 or +3
      // applies a change, which is what a GM actually has in their head after a
      // player calls out their damage. One box, on the row it belongs to.
      const field = document.createElement("input");
      field.type = "text";
      field.className = "combatant-hp-input";
      field.value = hp.value ?? "";
      field.size = 4;
      field.setAttribute("aria-label", `${c.label} hit points`);
      field.title = writesBoard
        ? "Set hit points on the mini, or type -5 / +3 to change them"
        : "Set hit points, or type -5 / +3 to change them";
      field.onkeydown = (ev) => {
        if (ev.key === "Enter") ev.target.blur();
        if (ev.key === "Escape") {
          ev.target.value = hp.value ?? "";
          ev.target.blur();
        }
      };
      field.onchange = () => deps.onSetHp(c, field.value);
      // Selecting on focus means typing a whole new value needs no deleting.
      field.onfocus = () => field.select();

      const suffix = el("span", "combatant-hp-max", hp.max ? `/ ${hp.max}` : "");
      const temp = document.createElement("input");
      temp.type = "text";
      temp.className = "combatant-hp-input hp-temp-input";
      temp.value = hp.temp || "";
      temp.placeholder = "0";
      temp.size = 3;
      temp.setAttribute("aria-label", `${c.label} temporary hit points`);
      temp.title = hp.tempSource === "stat"
        ? "Temp HP, on the mini's Temp HP stat"
        : "Temp HP; damage typed as -5 takes it first";
      temp.onkeydown = field.onkeydown;
      temp.onfocus = () => temp.select();
      temp.onchange = () => deps.onSetTemp?.(c, temp.value);
      const line = el("div", "combatant-hp-line");
      line.append(field, suffix);
      const tempLine = el("div", "combatant-hp-line hp-temp-line");
      tempLine.append(el("span", "hp-temp-note", "temp"), temp);
      hpBox.append(line);
      if (track) hpBox.insertAdjacentHTML("beforeend", track);
      hpBox.append(tempLine);
    }
    row.appendChild(hpBox);

    const controls = el("div", "combatant-controls");

    const stat = el("button", "btn btn-small btn-ghost", "Stat");
    stat.title = "Open this monster's statblock";
    stat.onclick = () => deps.onOpenMonster(c);
    controls.appendChild(stat);

    const link = el("button", "btn btn-small btn-ghost", c.creatureId ? "Unlink" : "Link mini");
    link.onclick = () => deps.onLink(c);
    controls.appendChild(link);

    const drop = el("button", "btn btn-small btn-ghost", "✕");
    drop.title = "Remove from the encounter";
    drop.onclick = () => deps.onRemove(c);
    controls.appendChild(drop);

    row.appendChild(controls);
    return row;
  }

  function renderTurnOrder(host) {
    const order = turnOrder();
    if (!order.length) {
      host.appendChild(
        el("p", "hint", "Not in initiative. Start it in TaleSpire and the order appears here.")
      );
      return;
    }

    if (queueIsIdle()) {
      host.appendChild(
        el("p", "hint", "TaleSpire is holding this order but no turn is active — it keeps the queue after you leave initiative.")
      );
    }

    const list = el("div", "turn-order");
    for (const entry of order) {
      const row = el("div", `turn-row${entry.active ? " is-active" : ""}`);

      const open = el("button", "turn");
      const guessed = entry.matchedBy === "name";
      const how = guessed ? " · by name" : entry.matchedBy === "assigned" ? " · assigned" : "";
      open.innerHTML =
        `<span class="turn-name">${escape(entry.name)}</span>` +
        (entry.combatant ? `<span class="sub">${escape(entry.combatant.label)}${how}</span>` : "");
      open.title = entry.combatant
        ? guessed
          ? "Open this statblock. Paired by name — set it below if that is wrong."
          : "Open this statblock"
        : "";
      open.disabled = !entry.combatant;
      open.onclick = () => entry.combatant && deps.onOpenMonster(entry.combatant);
      row.appendChild(open);

      // The escape hatch. Nothing about a mini's name has to agree with the
      // statblock a GM is running on it — a Goblin Boss may be standing on a
      // Goblin Captain model — so there has to be a way to say so outright.
      const pick = document.createElement("select");
      pick.className = "turn-assign";
      pick.title = "Which combatant is taking this turn";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = entry.combatant ? "— unassign" : "— assign";
      pick.appendChild(none);

      const options = entry.combatant ? [entry.combatant, ...entry.unclaimed] : entry.unclaimed;
      for (const c of options) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.label;
        if (entry.combatant && c.id === entry.combatant.id) opt.selected = true;
        pick.appendChild(opt);
      }
      pick.onchange = () => deps.onAssignTurn(entry, pick.value || null);
      row.appendChild(pick);

      list.appendChild(row);
    }
    host.appendChild(list);
  }

  function renderInbox(host) {
    if (!inbox.length) return;
    const target = selected();

    for (const entry of inbox) {
      const row = el("div", "damage-offer");
      row.appendChild(
        el("span", "damage-offer-text", `${entry.who} rolled ${entry.amount}${entry.label ? ` — ${entry.label}` : ""}`)
      );

      const apply = el("button", "btn btn-small btn-primary", target ? `Apply to ${target.label}` : "Select a combatant");
      apply.disabled = !target;
      apply.onclick = () => deps.onApplyDamage(target, entry);
      row.appendChild(apply);

      const no = el("button", "btn btn-small btn-ghost", "✕");
      no.title = "Dismiss";
      no.onclick = () => dismissDamage(entry.rollId);
      row.appendChild(no);

      host.appendChild(row);
    }
  }

  function render() {
    const host = deps.detail;
    if (!host) return;
    host.replaceChildren();
    if (!current) return;

    const head = el("div", "encounter-head");
    head.appendChild(el("h2", "bestiary-title", current.name));
    host.appendChild(head);

    renderInbox(host);

    host.appendChild(el("h3", "bestiary-heading", "Turn order"));
    renderTurnOrder(host);

    host.appendChild(el("h3", "bestiary-heading", "Combatants"));
    if (!current.combatants.length) {
      host.appendChild(el("p", "hint", "Nothing here yet. Add monsters from the Monsters view."));
      return;
    }
    for (const c of current.combatants) host.appendChild(combatantRow(c));
  }

  function setCurrent(encounter) {
    current = encounter;
  }

  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  return {
    configure, addMonster, removeCombatant, hpFor, applyDamage, noteBoardHp, isWatching,
    readBoard, setQueue, turnOrder, renderList, render, setCurrent,
    select, selected, offerDamage, dismissDamage,
    get current() { return current; },
    get waiting() { return inbox.length; },
  };
})();

if (typeof window !== "undefined") window.Encounters = Encounters;
