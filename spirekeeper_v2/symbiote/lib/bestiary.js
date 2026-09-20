/**
 * The bestiary: find a monster, then run it.
 *
 * Two sources, deliberately different in kind. The SRD set ships inside the mod,
 * so the common case needs no network and no waiting. Open5e's full catalogue —
 * Tome of Beasts, Creature Codex and the rest, some 2,900 more — is a search
 * away but never queried unless the GM asks, because it is the only request this
 * mod makes off the machine.
 *
 * Rolling reuses the player sheet's dice path exactly: an attack stages its
 * to-hit and damage in one throw, and the result can be posted as the creature
 * so the chat reads "Goblin hits for 5" rather than coming from the GM.
 */

const Bestiary = (() => {
  let deps = {};       // { search, results, sheet, speaker, onRoll, onError }
  let current = null;  // the normalized monster on screen
  let online = false;  // is the search reaching past the bundled set?

  function configure(d) {
    deps = d;
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // --- searching -----------------------------------------------------------

  async function runSearch(query) {
    try {
      const rows = online ? await Monsters.searchOnline(query) : await Monsters.searchBundled(query);
      renderResults(rows, query);
    } catch (e) {
      deps.onError?.(e.message);
    }
  }

  function setOnline(value) {
    online = value;
  }

  function renderResults(rows, query) {
    const host = deps.results;
    host.replaceChildren();

    if (!rows.length) {
      const empty = el("p", "hint");
      empty.textContent = online
        ? `Nothing in Open5e matches “${query}”.`
        : `Nothing in the bundled SRD matches “${query}”. Try Open5e for the wider catalogue.`;
      host.appendChild(empty);
      return;
    }

    for (const row of rows) {
      const item = el("button", "bestiary-row");
      item.innerHTML =
        `<span class="bestiary-name">${escape(row.name)}</span>` +
        `<span class="sub">${escape([row.meta, row.source].filter(Boolean).join(" · "))}</span>` +
        `<span class="bestiary-cr">CR ${escape(row.cr ?? "—")}</span>`;
      item.onclick = () => open(row);
      host.appendChild(item);
    }
  }

  async function open(row) {
    try {
      // An online result already carries its full record; a bundled one is a
      // summary and has to be looked up.
      current = row.raw ? Monsters.normalize(row.raw) : await Monsters.get(row.slug);
      if (!current) throw new Error("That monster could not be loaded.");
      renderSheet();
    } catch (e) {
      deps.onError?.(e.message);
    }
  }

  // --- the sheet -----------------------------------------------------------

  function statRow(monster) {
    const row = el("div", "bestiary-stats");
    const add = (label, value) => {
      const box = el("div", "vital");
      box.append(el("span", "vital-label", label), el("span", "vital-value", value));
      row.appendChild(box);
    };
    add("AC", String(monster.ac ?? "—"));
    add("HP", String(monster.hp ?? "—"));
    add("CR", String(monster.cr ?? "—"));
    return row;
  }

  function abilityRow(monster) {
    const row = el("div", "bestiary-abilities");
    for (const ab of Object.values(monster.abilities)) {
      const box = el("button", "ability-chip");
      box.innerHTML =
        `<span class="ability-name">${escape(ab.name.slice(0, 3).toUpperCase())}</span>` +
        `<span class="ability-score">${ab.score}</span>` +
        `<span class="ability-save">save ${Monsters.signed(ab.save)}${ab.saveProficient ? "●" : ""}</span>`;
      box.title = `Roll a ${ab.name} saving throw`;
      box.onclick = (ev) =>
        deps.onRoll({ name: `${monster.name}: ${ab.name} save`, roll: `d20${Monsters.signed(ab.save)}`, kind: "save" }, ev);
      row.appendChild(box);
    }
    return row;
  }

  function actionElement(monster, action) {
    const wrap = el("div", "bestiary-action");

    const head = el("div", "bestiary-action-head");
    const name = el("span", "bestiary-action-name", action.name);
    head.appendChild(name);
    if (action.category !== "action") head.appendChild(el("span", "tag", action.category));
    wrap.appendChild(head);

    const buttons = el("div", "bestiary-action-buttons");

    if (action.kind === "attack") {
      const b = el("button", "btn btn-small btn-primary", `Attack ${Monsters.signed(action.toHit)}`);
      b.onclick = (ev) =>
        deps.onRoll(
          {
            name: `${monster.name}: ${action.name}`,
            roll: action.roll,
            damage: action.damage,
            kind: "attack",
          },
          ev
        );
      buttons.appendChild(b);
      if (action.flat != null) buttons.appendChild(el("span", "hint", `${action.flat} damage, no roll`));
    }

    if (action.kind === "save") {
      buttons.appendChild(el("span", "hint", `DC ${action.saveDc} ${action.saveAbility}`));
    }

    if (action.damage && action.kind !== "attack") {
      const b = el("button", "btn btn-small", `Damage ${action.damage}`);
      b.onclick = (ev) =>
        deps.onRoll(
          { name: `${monster.name}: ${action.name}`, damage: action.damage, damageName: `${action.name} damage`, kind: "damage" },
          ev
        );
      buttons.appendChild(b);
    }

    if (buttons.childElementCount) wrap.appendChild(buttons);
    if (action.desc) wrap.appendChild(el("p", "bestiary-desc", action.desc));
    return wrap;
  }

  function renderSheet() {
    const host = deps.sheet;
    host.replaceChildren();
    deps.onShow?.(current);
    if (!current) return;

    const m = current;
    host.appendChild(el("h2", "bestiary-title", m.name));
    host.appendChild(el("p", "bestiary-meta", [m.meta, m.acNote].filter(Boolean).join(" · ")));
    host.appendChild(statRow(m));

    const lines = [
      m.hitDice ? `Hit dice ${m.hitDice}` : null,
      m.speed ? `Speed ${m.speed}` : null,
      m.senses,
      m.languages ? `Languages ${m.languages}` : null,
      m.skills.length ? `Skills ${m.skills.map((s) => `${s.name} ${Monsters.signed(s.value)}`).join(", ")}` : null,
      m.defenses.resistant ? `Resistant to ${m.defenses.resistant}` : null,
      m.defenses.immune ? `Immune to ${m.defenses.immune}` : null,
      m.defenses.vulnerable ? `Vulnerable to ${m.defenses.vulnerable}` : null,
      m.defenses.conditionImmune ? `Immune to the ${m.defenses.conditionImmune} conditions` : null,
    ].filter(Boolean);
    if (lines.length) host.appendChild(el("p", "bestiary-lines", lines.join(" · ")));

    host.appendChild(abilityRow(m));

    if (m.skills.length) {
      const skills = el("div", "bestiary-action-buttons");
      for (const s of m.skills) {
        const b = el("button", "btn btn-small", `${s.name} ${Monsters.signed(s.value)}`);
        b.onclick = (ev) =>
          deps.onRoll({ name: `${m.name}: ${s.name}`, roll: `d20${Monsters.signed(s.value)}`, kind: "check" }, ev);
        skills.appendChild(b);
      }
      host.appendChild(skills);
    }

    const sections = [
      ["Traits", m.traits],
      ["Actions", m.actions],
    ];
    for (const [heading, list] of sections) {
      if (!list.length) continue;
      host.appendChild(el("h3", "bestiary-heading", heading));
      for (const action of list) host.appendChild(actionElement(m, action));
    }

    if (m.legendaryNote) host.appendChild(el("p", "bestiary-desc", m.legendaryNote));
    if (m.source) {
      const credit = el("p", "hint", `${m.source}`);
      if (m.license) credit.title = m.license;
      host.appendChild(credit);
    }
  }

  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** Render a statblock we already hold, rather than one just searched for. */
  function show(monster) {
    current = monster;
    renderSheet();
  }

  return { configure, runSearch, setOnline, renderSheet, show, get current() { return current; } };
})();

if (typeof window !== "undefined") window.Bestiary = Bestiary;
