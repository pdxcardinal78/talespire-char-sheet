/**
 * Monsters, for the GM side of the table.
 *
 * Statblocks come from Open5e, which is a far better fit than the character
 * importer's source: the data is structured rather than prose, so an attack
 * arrives as `attack_bonus: 4, damage_dice: "1d6", damage_bonus: 2` and drops
 * straight into the same dice engine the player sheet uses.
 *
 * The SRD set is bundled (see `dev/fetch-monsters.mjs`) so a fight needs no
 * network. Everything else — Tome of Beasts, Creature Codex and the rest, some
 * 2,900 more — stays online and opt-in, because it is too large to ship and most
 * tables never reach for it.
 */

const Monsters = (() => {
  const ABILITIES = [
    { key: "str", name: "Strength", field: "strength" },
    { key: "dex", name: "Dexterity", field: "dexterity" },
    { key: "con", name: "Constitution", field: "constitution" },
    { key: "int", name: "Intelligence", field: "intelligence" },
    { key: "wis", name: "Wisdom", field: "wisdom" },
    { key: "cha", name: "Charisma", field: "charisma" },
  ];

  const mod = (score) => Math.floor(((score ?? 10) - 10) / 2);
  const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const title = (s) => String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());

  // A 5e statblock always announces an attack in the same words. That phrase is
  // the reliable signal, not `attack_bonus` — a dragon's breath weapon is a
  // saving throw but still arrives carrying `attack_bonus: 0`.
  const ATTACK_RE = /(melee|ranged)\s+(weapon|spell)\s+attack:/i;
  const SAVE_RE = /DC\s+(\d+)\s+(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving throw/i;

  /**
   * The damage to roll.
   *
   * `damage_dice` is the clean path, but it is missing on a handful of entries
   * whose text plainly states the dice — so the parenthesised groups in the
   * description are the fallback. A Vampire Spawn's bite is "6 (1d6 + 3)
   * piercing plus 7 (2d6) necrotic", which is 1d6+3+2d6.
   */
  function damageRoll(action) {
    const dice = (action.damage_dice || "").trim();
    if (dice) {
      const bonus = action.damage_bonus || 0;
      return bonus ? `${dice}${signed(bonus)}` : dice;
    }

    const groups = [...String(action.desc || "").matchAll(/\((\d+d\d+(?:\s*[+-]\s*\d+)?)\)/g)].map((m) =>
      m[1].replace(/\s+/g, "")
    );
    return groups.length ? groups.join("+") : null;
  }

  /**
   * Some attacks deal a flat point or two with no dice at all ("Hit: 1 piercing
   * damage"). Staging a die for that is silly, so it is reported as a number.
   * Only read it when there are no dice, since otherwise the leading figure is
   * the average — "Hit: 5 (1d6 + 2)" — and rolling 5 would be wrong.
   */
  function flatDamage(action, hasDice) {
    if (hasDice) return null;
    const m = String(action.desc || "").match(/Hit:\s*(\d+)\s+\w+\s+damage/i);
    return m ? Number(m[1]) : null;
  }

  /**
   * The to-hit bonus, taken from the printed text rather than the field.
   *
   * They disagree on ten of the SRD's 507 attacks, and the text is the statblock
   * as published — a Vampire Spawn reads "+6 to hit" while its `attack_bonus`
   * says 61.
   */
  function toHitBonus(action) {
    const printed = String(action.desc || "").match(/([+-]\d+)\s+to hit/);
    if (printed) return Number(printed[1]);
    return Number.isFinite(action.attack_bonus) ? action.attack_bonus : null;
  }

  function classifyAction(action) {
    const desc = action.desc || "";
    const damage = damageRoll(action);

    const toHit = toHitBonus(action);
    if (ATTACK_RE.test(desc) && Number.isFinite(toHit)) {
      return {
        kind: "attack",
        toHit,
        roll: `d20${signed(toHit)}`,
        damage,
        flat: flatDamage(action, Boolean(damage)),
        reach: (desc.match(/(reach|range)\s+([^,.]+)/i) || [])[0] || null,
      };
    }

    const save = desc.match(SAVE_RE);
    if (save) {
      return { kind: "save", saveDc: Number(save[1]), saveAbility: save[2], damage };
    }

    // Damage with neither an attack nor a save still wants a roll button.
    return { kind: damage ? "damage" : "text", damage, flat: flatDamage(action, Boolean(damage)) };
  }

  function actionList(list, category) {
    return (list || []).map((a) => ({
      name: a.name,
      category,
      desc: a.desc || "",
      ...classifyAction(a),
    }));
  }

  /** Turn an Open5e record into the shape the sheet renders. */
  function normalize(raw) {
    const abilities = {};
    for (const ab of ABILITIES) {
      const score = raw[ab.field];
      const saveOverride = raw[`${ab.field}_save`];
      abilities[ab.key] = {
        name: ab.name,
        score: score ?? 10,
        mod: mod(score),
        save: Number.isFinite(saveOverride) ? saveOverride : mod(score),
        saveProficient: Number.isFinite(saveOverride),
      };
    }

    const skills = Object.entries(raw.skills || {}).map(([name, value]) => ({
      name: title(name.replace(/_/g, " ")),
      value,
    }));

    const speed = Object.entries(raw.speed || {})
      .map(([kind, value]) => (kind === "walk" ? `${value} ft.` : `${kind} ${value} ft.`))
      .join(", ");

    return {
      slug: raw.slug,
      name: raw.name,
      meta: [[raw.size, raw.type].filter(Boolean).join(" "), raw.alignment].filter(Boolean).join(", "),
      cr: raw.challenge_rating,
      ac: raw.armor_class,
      acNote: raw.armor_desc || null,
      hp: raw.hit_points,
      hitDice: raw.hit_dice || null,
      speed,
      abilities,
      skills,
      senses: raw.senses || null,
      languages: raw.languages || null,
      defenses: {
        vulnerable: raw.damage_vulnerabilities || null,
        resistant: raw.damage_resistances || null,
        immune: raw.damage_immunities || null,
        conditionImmune: raw.condition_immunities || null,
      },
      traits: actionList(raw.special_abilities, "trait"),
      actions: [
        ...actionList(raw.actions, "action"),
        ...actionList(raw.bonus_actions, "bonus action"),
        ...actionList(raw.reactions, "reaction"),
        ...actionList(raw.legendary_actions, "legendary"),
      ],
      legendaryNote: raw.legendary_desc || null,
      source: raw.document__title || null,
      license: raw.document__license_url || null,
    };
  }

  // --- finding one ---------------------------------------------------------

  let bundled = null;

  /**
   * The shipped SRD set, loaded once and kept.
   *
   * Pulled in with a script tag rather than `fetch`. A Symbiote installed
   * locally runs from a file origin, where fetching a relative path is blocked —
   * the same restriction that rules out ES modules here. A script tag works in
   * both the game and a dev server, so there is one path and it is the one that
   * survives. Loading is deferred until a monster is actually wanted, because
   * half a megabyte should not be on the critical path to a character sheet.
   */
  async function loadBundled() {
    if (bundled) return bundled;

    if (!window.SPIREKEEPER_MONSTERS) {
      await new Promise((resolve, reject) => {
        const tag = document.createElement("script");
        tag.src = "data/monsters.js";
        tag.onload = resolve;
        tag.onerror = () => reject(new Error("Could not load data/monsters.js — is it missing from the Symbiote?"));
        document.head.appendChild(tag);
      });
    }

    bundled = window.SPIREKEEPER_MONSTERS;
    if (!bundled?.monsters) throw new Error("The bundled monster list is missing or malformed.");
    return bundled;
  }

  function score(name, query) {
    const n = name.toLowerCase();
    if (n === query) return 0;
    if (n.startsWith(query)) return 1;
    return 2;
  }

  async function searchBundled(query) {
    const data = await loadBundled();
    const q = query.trim().toLowerCase();
    if (!q) return data.monsters.slice(0, 40).map(brief);
    return data.monsters
      .filter((m) => m.name.toLowerCase().includes(q))
      .sort((a, b) => score(a.name.toLowerCase(), q) - score(b.name.toLowerCase(), q) || a.name.localeCompare(b.name))
      .slice(0, 40)
      .map(brief);
  }

  const brief = (m) => ({
    slug: m.slug,
    name: m.name,
    cr: m.challenge_rating,
    meta: [m.size, m.type].filter(Boolean).join(" "),
    source: m.document__title || "SRD",
    online: false,
  });

  /**
   * Open5e's full catalogue. This is the one call in the whole mod that leaves
   * the machine, so it is never made unless the GM asks for it.
   */
  async function searchOnline(query) {
    const q = query.trim();
    if (!q) return [];
    const url = `https://api.open5e.com/v1/monsters/?search=${encodeURIComponent(q)}&limit=40`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open5e returned ${res.status}.`);
    const page = await res.json();
    return (page.results || []).map((m) => ({ ...brief(m), online: true, raw: m }));
  }

  async function get(slug) {
    const data = await loadBundled();
    const found = data.monsters.find((m) => m.slug === slug);
    return found ? normalize(found) : null;
  }

  return { normalize, loadBundled, searchBundled, searchOnline, get, signed };
})();

if (typeof window !== "undefined") window.Monsters = Monsters;
if (typeof module !== "undefined" && module.exports) module.exports = Monsters;
