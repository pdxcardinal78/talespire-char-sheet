/**
 * The GM's side of the table.
 *
 * A player's panel is about one character. A GM's problem is the opposite: too
 * many creatures and no way to see the state of any of them without clicking
 * each mini in turn. TaleSpire hands GMs the data to fix that — `getMoreInfo`
 * returns full stats on every mini to a GM, where a player sees only their own —
 * so this is a live read-only view of the party.
 *
 * A Symbiote cannot write hit points, move a mini, or set a condition. What it
 * can do is watch, and `creatures.onCreatureStateChange` fires on every HP
 * change, so the board stays the source of truth and this panel reflects it.
 *
 * The exception is the bridge plugin (lib/bridge.js): when the GM's TaleSpire
 * runs it, each row's hit points become an input that writes to the mini.
 */

const GM = (() => {
  const failed = (r) => r && r.cause !== undefined;

  let deps = {};        // { container, meta, onError, canWrite, onSetHp, onSetTemp, onCondition, conditionNames, afterRender }
  let watching = [];    // creature ids we care about
  let rows = [];        // last known info, in display order
  let owners = new Map(); // playerId -> name
  let refreshTimer = null;

  function configure(d) {
    deps = d;
  }

  // --- gathering -----------------------------------------------------------

  /**
   * Who counts as "the party".
   *
   * Parties are the explicit answer when the GM has set them up. Most campaigns
   * haven't, so the fallback is every mini owned by a player — which is the same
   * set in practice, and the only one that needs no configuration.
   */
  async function partyCreatureIds() {
    const parties = await TS.parties.getParties();
    if (!failed(parties) && parties?.length) {
      const ids = [];
      for (const party of parties) {
        const inParty = await TS.parties.getCreaturesInParty(party);
        if (!failed(inParty)) ids.push(...inParty);
      }
      if (ids.length) return [...new Set(ids)];
    }

    const players = await TS.players.getPlayersInThisBoard();
    if (failed(players)) return [];

    const infos = await TS.players.getMoreInfo(players);
    if (!failed(infos)) for (const p of infos) owners.set(p.id, p.name);

    const ids = [];
    for (const player of players) {
      const owned = await TS.creatures.getCreaturesOwnedByPlayer(player);
      // A player's client is not allowed to ask this; only the GM gets an answer.
      if (failed(owned)) continue;
      ids.push(...owned.map((c) => c.id || c));
    }
    return [...new Set(ids)];
  }

  /** Turn ids into the shape the view needs. */
  async function describe(ids) {
    if (!ids.length) return [];
    const infos = await Board.creatureInfo(ids);
    return (infos || []).filter(Boolean).map((info) => {
      const stats = info.stats || [];
      const ac = stats.find((s) => /^ac$|armou?r/i.test(s.name || ""));
      const hp = info.hp || {};
      // Temp HP from a campaign stat, else as reported by the player's panel
      const v = Vitals.read(info);
      const tempStat = Vitals.tempStatOf(info);
      return {
        id: info.id,
        name: info.name || "Unnamed",
        hp: Number.isFinite(hp.value) ? hp.value : null,
        hpMax: Number.isFinite(hp.max) ? hp.max : null,
        temp: v.temp,
        tempSource: v.tempSource,
        tempIndex: v.tempIndex,
        tempMax: v.tempMax,
        ac: ac && Number.isFinite(ac.value) ? ac.value : null,
        flying: Boolean(info.isFlying),
        hidden: Boolean(info.isExplicitlyHidden),
        emotes: (info.idsOfActivePersistentEmotes || []).length,
        // TaleSpire statuses the GM has paired with conditions, and any not yet paired
        ...(() => {
          const st = Statuses.on(info);
          return {
            conditions: st.conditions,
            shared: st.shared,
            unknownStatuses: st.unknown.length,
            unknownNames: st.unknown.map((id) => Statuses.nameOf(id)).filter(Boolean),
          };
        })(),
        owner: (info.ownerIds || []).map((o) => owners.get(o)).filter(Boolean)[0] || null,
        // Other named stats, so a campaign that tracks e.g. Stress still shows it.
        extras: stats
          .filter((s) => s !== ac && s.name && Number.isFinite(s.value) && !Vitals.TEMP_NAME.test(s.name))
          .map((s) => `${s.name} ${s.value}`),
      };
    });
  }

  async function refresh() {
    try {
      watching = await partyCreatureIds();
      rows = await describe(watching);
      rows.sort((a, b) => a.name.localeCompare(b.name));
      render();
    } catch (e) {
      deps.onError?.(e.message);
    }
  }

  /**
   * Creature events arrive one per changed property, and a single HP tick can
   * produce several. Coalesce them rather than refetching per event.
   */
  function onCreatureEvent(event) {
    const id = event?.payload?.id;
    const structural = event.kind === "creatureAdded" || event.kind === "creatureRemoved";
    if (!structural && id && !watching.includes(id)) return;

    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  // --- view ----------------------------------------------------------------

  function hpClass(row) {
    if (row.hp == null || !row.hpMax) return "";
    const share = row.hp / row.hpMax;
    if (row.hp <= 0) return "is-down";
    if (share <= 0.25) return "is-critical";
    if (share <= 0.5) return "is-bloodied";
    return "";
  }

  function rowElement(row) {
    const el = document.createElement("div");
    el.className = `party-row ${hpClass(row)}`.trim();

    const name = document.createElement("div");
    name.className = "party-name";
    const marks = [row.flying ? "flying" : null, row.hidden ? "hidden" : null]
      .filter(Boolean)
      .join(" · ");
    name.innerHTML =
      `<span>${escape(row.name)}</span>` +
      `<span class="sub">${escape([row.owner, marks].filter(Boolean).join(" · "))}</span>`;

    const hp = document.createElement("div");
    hp.className = "party-hp";
    if (row.hp == null) {
      hp.innerHTML = `<span class="party-hp-text">HP hidden</span>`;
    } else if (deps.canWrite?.()) {
      // Same control as an encounter row: 12 sets, -5 / +3 change
      const pct = row.hpMax ? Math.max(0, Math.min(100, (row.hp / row.hpMax) * 100)) : 0;
      const field = document.createElement("input");
      field.type = "text";
      field.className = "combatant-hp-input";
      field.value = row.hp;
      field.size = 4;
      field.setAttribute("aria-label", `${row.name} hit points`);
      field.title = "Set hit points on the mini, or type -5 / +3 to change them";
      field.onkeydown = (ev) => {
        if (ev.key === "Enter") ev.target.blur();
        if (ev.key === "Escape") {
          ev.target.value = row.hp;
          ev.target.blur();
        }
      };
      field.onfocus = () => field.select();
      field.onchange = () => deps.onSetHp?.(row, field.value);
      const line = document.createElement("div");
      line.className = "combatant-hp-line";
      const max = document.createElement("span");
      max.className = "combatant-hp-max";
      max.textContent = row.hpMax ? `/ ${row.hpMax}` : "";
      // Temp HP: its own box, set exactly. Damage typed as -5 above takes it first.
      const temp = document.createElement("input");
      temp.type = "text";
      temp.className = "combatant-hp-input hp-temp-input";
      temp.value = row.temp ?? "";
      temp.placeholder = row.temp == null ? "?" : "0";
      temp.size = 3;
      temp.setAttribute("aria-label", `${row.name} temporary hit points`);
      temp.title = row.tempSource === "stat"
        ? "Temp HP, from the campaign's Temp HP stat"
        : row.tempSource === "panel"
          ? "Temp HP, as reported by the player's panel"
          : "Temp HP unknown: no Temp HP stat in this campaign and the player's panel hasn't reported";
      temp.onkeydown = field.onkeydown;
      temp.onfocus = () => temp.select();
      temp.onchange = () => deps.onSetTemp?.(row, temp.value);
      const tempLabel = document.createElement("span");
      tempLabel.className = "hp-temp-note";
      tempLabel.textContent = "temp";
      line.append(field, max);
      const tempLine = document.createElement("div");
      tempLine.className = "combatant-hp-line hp-temp-line";
      tempLine.append(tempLabel, temp);
      hp.append(line);
      hp.insertAdjacentHTML("beforeend",
        `<span class="party-hp-track"><span class="party-hp-fill" style="width:${pct}%"></span></span>`);
      hp.append(tempLine);
    } else {
      const pct = row.hpMax ? Math.max(0, Math.min(100, (row.hp / row.hpMax) * 100)) : 0;
      const tempText = row.temp > 0 ? ` +${row.temp}` : "";
      hp.innerHTML =
        `<span class="party-hp-text">${row.hp}${row.hpMax ? ` / ${row.hpMax}` : ""}${tempText}</span>` +
        `<span class="party-hp-track"><span class="party-hp-fill" style="width:${pct}%"></span></span>`;
    }

    const ac = document.createElement("div");
    ac.className = "party-ac";
    ac.textContent = row.ac != null ? `AC ${row.ac}` : "AC —";
    if (row.extras.length) ac.title = row.extras.join("\n");

    el.append(name, hp, ac);

    // Conditions, from the statuses on the mini
    const writable = Boolean(deps.canWrite?.());
    const addable = writable ? (deps.conditionNames?.() || []).filter((n) => !row.conditions.includes(n)) : [];
    if (row.conditions.length || row.shared?.length || row.unknownStatuses || addable.length) {
      const conds = document.createElement("div");
      conds.className = "party-conds";
      for (const c of row.conditions) {
        const chip = document.createElement("span");
        chip.className = "condition";
        const label = document.createElement("span");
        label.textContent = c;
        chip.appendChild(label);
        if (writable) {
          const x = document.createElement("button");
          x.className = "chip-btn";
          x.textContent = "×";
          x.title = `Clear ${c} from the mini`;
          x.onclick = () => deps.onCondition?.(row, c, false);
          chip.appendChild(x);
        }
        conds.appendChild(chip);
      }
      // A status several conditions share: the board can't say which one
      for (const sh of row.shared || []) {
        const chip = document.createElement("span");
        chip.className = "condition";
        const label = document.createElement("span");
        label.textContent = sh.conditions.join(" or ");
        chip.appendChild(label);
        chip.title = `TaleSpire status: ${sh.name}`;
        if (writable) {
          const x = document.createElement("button");
          x.className = "chip-btn";
          x.textContent = "×";
          x.title = `Clear ${sh.name} from the mini`;
          x.onclick = () => deps.onCondition?.(row, sh.conditions[0], false);
          chip.appendChild(x);
        }
        conds.appendChild(chip);
      }
      // Statuses not paired with a condition yet: by name where the catalog
      // knows it, otherwise counted
      for (const n of row.unknownNames) {
        const chip = document.createElement("span");
        chip.className = "condition status-unknown";
        chip.textContent = `${n} (not paired)`;
        chip.title = "Pair it with a condition in the list below";
        conds.appendChild(chip);
      }
      const unnamed = row.unknownStatuses - row.unknownNames.length;
      if (unnamed > 0) {
        const chip = document.createElement("span");
        chip.className = "condition status-unknown";
        chip.textContent = unnamed === 1 ? "1 unpaired status" : `${unnamed} unpaired statuses`;
        chip.title = "Pair it with a condition in the list below";
        conds.appendChild(chip);
      }
      if (addable.length) {
        const pick = document.createElement("select");
        pick.className = "party-cond-pick";
        pick.setAttribute("aria-label", `Add a condition to ${row.name}`);
        const first = document.createElement("option");
        first.value = "";
        first.textContent = "+ Condition";
        pick.appendChild(first);
        for (const n of addable) {
          const opt = document.createElement("option");
          opt.value = n;
          opt.textContent = n;
          pick.appendChild(opt);
        }
        pick.onchange = () => {
          if (pick.value) deps.onCondition?.(row, pick.value, true);
        };
        conds.appendChild(pick);
      }
      el.appendChild(conds);
    }
    return el;
  }

  /** A one-line read of the party's state, for the header. */
  function summary() {
    if (!rows.length) return "—";
    const down = rows.filter((r) => r.hp != null && r.hp <= 0).length;
    const hurt = rows.filter((r) => r.hp != null && r.hpMax && r.hp > 0 && r.hp / r.hpMax <= 0.5).length;
    const unseen = rows.filter((r) => r.hp == null).length;
    return [
      `${rows.length} ${rows.length === 1 ? "mini" : "minis"}`,
      hurt ? `${hurt} bloodied` : null,
      down ? `${down} down` : null,
      unseen ? `${unseen} with stats hidden` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function render() {
    const host = deps.container;
    if (!host) return;
    if (deps.meta) deps.meta.textContent = summary();
    host.replaceChildren();

    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent =
        "No party minis found. Minis owned by a player show up here — as a GM you also see their stats.";
      host.appendChild(empty);
      return;
    }

    for (const row of rows) host.appendChild(rowElement(row));
    deps.afterRender?.();
  }

  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  return { configure, refresh, render, onCreatureEvent, get rows() { return rows; } };
})();

if (typeof window !== "undefined") window.GM = GM;
