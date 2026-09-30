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

  // Who is being run, and what has been spent. Supplied by the caller, because
  // where it lives is their business: a combatant in a saved encounter keeps its
  // spent slots between sessions, while a statblock opened out of the search is
  // a look at a monster and forgets when the panel closes.
  let ctx = null;      // { label, state: { uses, overrides }, onChange }
  let spells = null;   // resolved spells for `current`, by block then group
  let editing = null;  // the spell whose override form is open

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
      // Searched for rather than run: no encounter owns it, so what it spends is
      // forgotten and what it is told to change isn't saved.
      ctx = deps.scratchContext?.(current) || null;
      await resolveSpells();
      renderSheet();
    } catch (e) {
      deps.onError?.(e.message);
    }
  }

  // --- spells --------------------------------------------------------------
  //
  // A statblock's spells arrive as a paragraph of names. Monsters.parse turns
  // that into groups; this resolves each name against the bundled spell list, so
  // the fireball a GM has to throw arrives as 8d6 fire against DC 14 rather than
  // as the word "fireball".

  const uses = () => (ctx?.state ? (ctx.state.uses ||= {}) : {});
  const overrides = () => (ctx?.state ? (ctx.state.overrides ||= {}) : {});

  /** Spent-count key. Slots belong to a level; innate uses to one spell. */
  const useKey = (blockIndex, group, spell) =>
    `${blockIndex}:${group.id}${group.usesEach ? `:${spell.key}` : ""}`;

  /**
   * Look every spell up, once per statblock.
   *
   * Resolution is async only because the spell list is loaded on demand, so it
   * happens before the render rather than inside it — a statblock that drew
   * itself twice, once without spells, would flicker on every monster.
   */
  async function resolveSpells() {
    spells = null;
    editing = null;
    if (!current?.spellcasting?.length) return;

    try {
      await Spells.loadBundled();
    } catch (e) {
      deps.onError?.(e.message);
      return; // the printed trait is still on screen; that is the fallback
    }

    resolveAll();
  }

  /**
   * Dress every name in the statblock's numbers and the GM's changes.
   *
   * The spellcasting ability is named in words ("Charisma"), and the monster's
   * own score for it is what a healing spell adds — so it's read back off the
   * statblock rather than inferred from the save DC, which can't be split into
   * a proficiency bonus and a modifier.
   */
  function resolveAll() {
    const abilityMod = (block) =>
      current.abilities[String(block.ability || "").slice(0, 3).toLowerCase()]?.mod ?? 0;

    spells = current.spellcasting.map((block) =>
      block.groups.map((group) =>
        group.spells.map((ref) =>
          Spells.monsterSpell(ref, block, {
            // Cantrips scale on the caster level the statblock states; innate
            // casters state none, and their spells don't scale anyway.
            casterLevel: block.casterLevel || 1,
            abilityMod: abilityMod(block),
            override: overrides()[Spells.spellKey(ref.name)] || {},
          })
        )
      )
    );
  }

  /** Record a change to a spell, re-resolve against it, and redraw. */
  function applyOverride(spell, patch) {
    const store = overrides();
    const next = { ...(store[spell.key] || {}), ...patch };
    for (const [k, v] of Object.entries(next)) if (v == null || v === "") delete next[k];

    if (Object.keys(next).length) store[spell.key] = next;
    else delete store[spell.key];

    ctx?.onChange?.();
    resolveAll();
    renderSheet();
  }

  function spend(blockIndex, group, spell, delta) {
    const key = useKey(blockIndex, group, spell);
    const cap = group.usesEach ?? group.slots;
    const spent = uses()[key] || 0;
    const next = Math.max(0, Math.min(cap ?? Infinity, spent + delta));
    if (next === spent) return false;

    uses()[key] = next;
    ctx?.onChange?.();
    return true;
  }

  /** The pips that show what's left of a level's slots, or a spell's uses. */
  function usePips(spent, total, onSpend, onGiveBack) {
    const wrap = el("span", "spell-pips");
    for (let i = 0; i < total; i += 1) {
      const pip = el("button", `spell-pip${i < total - spent ? "" : " is-spent"}`);
      pip.type = "button";
      pip.title = "Click to spend, right-click to give one back";
      pip.setAttribute("aria-label", `${total - spent} of ${total} left`);
      pip.onclick = onSpend;
      pip.oncontextmenu = (ev) => {
        ev.preventDefault();
        onGiveBack();
      };
      wrap.appendChild(pip);
    }
    return wrap;
  }

  /**
   * The form for changing a spell on this particular monster.
   *
   * A statblock is a starting point as often as it is a rule — the fire cultist
   * whose fireball has to come out cold, the boss who hits harder than the page
   * says. Every field states what it would be if left alone, so clearing one is
   * the way back rather than a separate undo per field.
   */
  function overrideForm(spell, block) {
    const form = el("form", "spell-edit");

    const field = (label, name, value, placeholder, type = "text") => {
      const wrap = el("label", "spell-edit-field");
      wrap.appendChild(el("span", "spell-edit-label", label));
      const input = document.createElement("input");
      input.type = type;
      input.name = name;
      input.value = value ?? "";
      input.placeholder = placeholder == null ? "—" : String(placeholder);
      input.className = "spell-edit-input";
      wrap.appendChild(input);
      return wrap;
    };

    const base = spell.override;
    form.append(
      field("Dice", "dice", base.dice, spell.dice),
      field("Damage type", "damageType", base.damageType, spell.damageType),
      field("Save DC", "saveDc", base.saveDc, block.saveDc, "number"),
      field("To hit", "toHit", base.toHit, block.toHit, "number")
    );

    const row = el("div", "spell-edit-buttons");
    const save = el("button", "btn btn-small btn-primary", "Apply");
    save.type = "submit";
    row.appendChild(save);

    const reset = el("button", "btn btn-small btn-ghost", "Reset");
    reset.type = "button";
    reset.disabled = !spell.edited;
    reset.title = "Put this spell back the way the statblock prints it";
    reset.onclick = () => {
      editing = null;
      applyOverride(spell, { dice: null, damageType: null, saveDc: null, toHit: null });
    };
    row.appendChild(reset);

    const cancel = el("button", "btn btn-small btn-ghost", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => {
      editing = null;
      renderSheet();
    };
    row.appendChild(cancel);
    form.appendChild(row);

    if (!ctx?.persists) {
      form.appendChild(
        el("p", "hint", "This monster isn't in an encounter, so changes last until the panel closes.")
      );
    }

    form.onsubmit = (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      const number = (v) => (String(v).trim() === "" ? null : Number(v));
      editing = null;
      applyOverride(spell, {
        dice: String(data.get("dice")).trim() || null,
        damageType: String(data.get("damageType")).trim() || null,
        saveDc: number(data.get("saveDc")),
        toHit: number(data.get("toHit")),
      });
    };

    return form;
  }

  function spellElement(monster, block, blockIndex, group, spell) {
    const wrap = el("div", `monster-spell${spell.edited ? " is-edited" : ""}`);

    const head = el("div", "monster-spell-head");
    const name = el("button", "monster-spell-name");
    const tags = [
      spell.dice ? `${spell.dice}${spell.damageType ? ` ${spell.damageType}` : ""}` : null,
      spell.concentration ? "conc." : null,
      spell.note,
      spell.edited ? "edited" : null,
      spell.found ? null : "not in the bundled list",
    ].filter(Boolean);
    name.innerHTML =
      `<span class="monster-spell-title">${escape(spell.name)}</span>` +
      (tags.length ? `<span class="sub">${escape(tags.join(" · "))}</span>` : "");
    name.title = "Show what this spell does";

    const body = el("div", "monster-spell-body hidden");
    name.onclick = () => body.classList.toggle("hidden");
    head.appendChild(name);
    wrap.appendChild(head);

    const buttons = el("div", "bestiary-action-buttons");
    const label = `${monster.name}: ${spell.name}`;

    if (spell.requiresAttackRoll && spell.toHit != null) {
      const b = el("button", "btn btn-small btn-primary", `Attack ${Monsters.signed(spell.toHit)}`);
      b.onclick = (ev) =>
        deps.onRoll({ name: label, roll: `d20${Monsters.signed(spell.toHit)}`, damage: spell.dice, kind: "attack" }, ev);
      buttons.appendChild(b);
    }

    if (spell.requiresSavingThrow && spell.saveDc != null) {
      buttons.appendChild(el("span", "hint", `DC ${spell.saveDc}${spell.saveAbility ? ` ${spell.saveAbility}` : ""}`));
    }

    if (spell.dice && !spell.requiresAttackRoll) {
      const b = el("button", "btn btn-small", `${spell.heals ? "Heal" : "Damage"} ${spell.dice}`);
      b.onclick = (ev) =>
        deps.onRoll(
          {
            name: label,
            damage: spell.dice,
            damageName: `${spell.name}${spell.damageType ? ` ${spell.damageType}` : ""}`,
            kind: spell.heals ? "healing" : "damage",
          },
          ev
        );
      buttons.appendChild(b);
    }

    // What it costs to cast, and the button that spends it. Cantrips and at-will
    // spells cost nothing, so they only announce.
    const cap = group.usesEach ?? group.slots;
    const spent = uses()[useKey(blockIndex, group, spell)] || 0;
    const left = cap == null ? null : cap - spent;

    const cast = el("button", "btn btn-small btn-ghost", cap == null ? "Cast" : `Cast (${left} left)`);
    cast.disabled = left === 0;
    cast.title = cap == null ? "Announce the cast" : "Spend one and announce the cast";
    cast.onclick = () => {
      if (cap != null && !spend(blockIndex, group, spell, 1)) return;
      deps.onAnnounce?.(`${monster.name} casts ${spell.name}`);
      renderSheet();
    };
    buttons.appendChild(cast);

    // Per-spell uses live on the spell's own row; slots belong to the level and
    // are drawn once on the group heading instead.
    if (group.usesEach) {
      buttons.appendChild(
        usePips(spent, group.usesEach,
          () => { if (spend(blockIndex, group, spell, 1)) renderSheet(); },
          () => { if (spend(blockIndex, group, spell, -1)) renderSheet(); })
      );
    }

    const edit = el("button", "btn btn-small btn-ghost", "✎");
    edit.title = "Change this spell for this monster";
    edit.onclick = () => {
      editing = editing === spell.key ? null : spell.key;
      renderSheet();
    };
    buttons.appendChild(edit);

    wrap.appendChild(buttons);
    if (editing === spell.key) wrap.appendChild(overrideForm(spell, block));

    const lines = [
      spell.level != null ? (spell.level === 0 ? "Cantrip" : `Level ${spell.level}`) : null,
      spell.school,
      spell.castingTime,
      spell.range,
      spell.duration,
      spell.components,
    ].filter(Boolean);
    if (lines.length) body.appendChild(el("p", "bestiary-lines", lines.join(" · ")));
    body.appendChild(
      el("p", "bestiary-desc", spell.found ? spell.description : "Not in the bundled spell list — run it from the book.")
    );
    wrap.appendChild(body);

    return wrap;
  }

  function spellcastingSection(monster, host) {
    if (!monster.spellcasting?.length) return;

    monster.spellcasting.forEach((block, blockIndex) => {
      host.appendChild(el("h3", "bestiary-heading", block.name));

      const facts = [
        block.ability,
        block.saveDc != null ? `spell save DC ${block.saveDc}` : null,
        block.toHit != null ? `${Monsters.signed(block.toHit)} to hit` : null,
        block.casterLevel ? `${block.casterLevel}th-level caster` : null,
      ].filter(Boolean);
      if (facts.length) host.appendChild(el("p", "bestiary-lines", facts.join(" · ")));

      // Resolution failed or hasn't happened: the statblock's own words are a
      // complete answer, just a slower one, so show those rather than nothing.
      if (!spells) {
        host.appendChild(el("p", "bestiary-desc", block.desc));
        return;
      }

      block.groups.forEach((group, groupIndex) => {
        const heading = el("div", "spell-group");
        heading.appendChild(el("span", "spell-group-label", group.label));

        if (group.slots) {
          const spent = uses()[useKey(blockIndex, group, {})] || 0;
          heading.appendChild(
            usePips(spent, group.slots,
              () => { if (spend(blockIndex, group, {}, 1)) renderSheet(); },
              () => { if (spend(blockIndex, group, {}, -1)) renderSheet(); })
          );
        }
        host.appendChild(heading);

        for (const spell of spells[blockIndex][groupIndex]) {
          host.appendChild(spellElement(monster, block, blockIndex, group, spell));
        }
      });
    });

    const note = el("p", "hint",
      ctx?.persists
        ? `Spent slots and spell changes are kept on ${ctx.label}.`
        : "Open this monster from an encounter to keep its spent slots and any changes.");
    host.appendChild(note);
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

    // A parsed spellcasting trait is rendered as spells below rather than twice:
    // once as a paragraph here and once as something castable further down.
    const parsedTraits = new Set((m.spellcasting || []).map((b) => b.name));
    const sections = [
      ["Traits", m.traits.filter((t) => !parsedTraits.has(t.name))],
      ["Actions", m.actions],
    ];
    for (const [heading, list] of sections) {
      if (!list.length) continue;
      host.appendChild(el("h3", "bestiary-heading", heading));
      for (const action of list) host.appendChild(actionElement(m, action));
    }

    spellcastingSection(m, host);

    if (m.legendaryNote) host.appendChild(el("p", "bestiary-desc", m.legendaryNote));
    if (m.source) {
      const credit = el("p", "hint", `${m.source}`);
      if (m.license) credit.title = m.license;
      host.appendChild(credit);
    }
  }

  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Render a statblock we already hold, rather than one just searched for.
   *
   * `context` is who is being run — the combatant whose spent slots and spell
   * changes these are. Without one the statblock still casts; it just doesn't
   * remember.
   */
  async function show(monster, context = null) {
    current = monster;
    ctx = context;
    await resolveSpells();
    renderSheet();
  }

  return { configure, runSearch, setOnline, renderSheet, show, get current() { return current; } };
})();

if (typeof window !== "undefined") window.Bestiary = Bestiary;
