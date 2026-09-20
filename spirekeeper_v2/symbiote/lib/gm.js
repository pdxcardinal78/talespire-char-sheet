/**
 * The GM's side of the table.
 *
 * A player's panel is about one character. A GM's problem is the opposite: too
 * many creatures and no way to see the state of any of them without clicking
 * each mini in turn. TaleSpire hands GMs the data to fix that — `getMoreInfo`
 * returns full stats on every mini to a GM, where a player sees only their own —
 * so this is a live read-only view of the party.
 *
 * Read-only is not a design choice, it's the API: a Symbiote cannot write hit
 * points, move a mini, or set a condition. What it can do is watch, and
 * `creatures.onCreatureStateChange` fires on every HP change, so the board stays
 * the source of truth and this panel just reflects it.
 */

const GM = (() => {
  const failed = (r) => r && r.cause !== undefined;

  let deps = {};        // { container, onError }
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
      return {
        id: info.id,
        name: info.name || "Unnamed",
        hp: Number.isFinite(hp.value) ? hp.value : null,
        hpMax: Number.isFinite(hp.max) ? hp.max : null,
        ac: ac && Number.isFinite(ac.value) ? ac.value : null,
        flying: Boolean(info.isFlying),
        hidden: Boolean(info.isExplicitlyHidden),
        emotes: (info.idsOfActivePersistentEmotes || []).length,
        owner: (info.ownerIds || []).map((o) => owners.get(o)).filter(Boolean)[0] || null,
        // Other named stats, so a campaign that tracks e.g. Stress still shows it.
        extras: stats
          .filter((s) => s !== ac && s.name && Number.isFinite(s.value))
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
    } else {
      const pct = row.hpMax ? Math.max(0, Math.min(100, (row.hp / row.hpMax) * 100)) : 0;
      hp.innerHTML =
        `<span class="party-hp-text">${row.hp}${row.hpMax ? ` / ${row.hpMax}` : ""}</span>` +
        `<span class="party-hp-track"><span class="party-hp-fill" style="width:${pct}%"></span></span>`;
    }

    const ac = document.createElement("div");
    ac.className = "party-ac";
    ac.textContent = row.ac != null ? `AC ${row.ac}` : "AC —";
    if (row.extras.length) ac.title = row.extras.join("\n");

    el.append(name, hp, ac);
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
  }

  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  return { configure, refresh, render, onCreatureEvent, get rows() { return rows; } };
})();

if (typeof window !== "undefined") window.GM = GM;
