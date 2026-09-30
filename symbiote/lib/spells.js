/**
 * The bundled spell list, and the adapter that turns one into a sheet spell.
 *
 * This exists because D&D Beyond's character export is incomplete in one
 * specific way: spells a subclass grants through its feature table never appear
 * as spell objects. A Twilight Domain cleric's export names faerie fire,
 * moonbeam, see invisibility and sleep only inside the Domain Spells prose,
 * while the website merges the real definitions in from a separate service. The
 * panel can't call that service — it can't even call D&D Beyond's own character
 * endpoint — so it carries the 2024 SRD and fills the gap from there.
 *
 * Built by dev/fetch-spells.mjs. See that file for why the 2024 SRD and not the
 * 2014 one.
 */
const Spells = (() => {
  let bundled = null;
  let index = null;

  async function loadBundled() {
    if (bundled) return bundled;

    if (!window.SPIREKEEPER_SPELLS) {
      await new Promise((resolve, reject) => {
        const tag = document.createElement("script");
        tag.src = "data/spells.js";
        tag.onload = resolve;
        tag.onerror = () => reject(new Error("Could not load data/spells.js — is it missing from the Symbiote?"));
        document.head.appendChild(tag);
      });
    }

    bundled = window.SPIREKEEPER_SPELLS;
    if (!bundled?.spells) throw new Error("The bundled spell list is missing or malformed.");
    index = new Map(bundled.spells.map((s) => [s.name.toLowerCase(), s]));
    return bundled;
  }

  /** Feature tables write spell names in running prose, so matching is loose. */
  const key = (name) =>
    String(name || "")
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/\s+/g, " ")
      .trim();

  async function find(name) {
    await loadBundled();
    return index.get(key(name)) || null;
  }

  // --- adapting to the shape the sheet already renders ----------------------

  const TITLE = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  const CASTING_TIME = {
    action: "1 action",
    "bonus-action": "1 bonus action",
    reaction: "1 reaction",
    minute: "1 minute",
    hour: "1 hour",
  };

  /** A cantrip's dice grow with character level: 1 at 1st, then 5th, 11th, 17th. */
  const cantripMultiplier = (level) => (level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1);

  const parseDice = (roll) => {
    const m = /^(\d*)d(\d+)(?:\s*\+\s*(\d+))?$/i.exec(String(roll || "").trim());
    if (!m) return null;
    return { count: parseInt(m[1] || "1", 10), sides: parseInt(m[2], 10), flat: parseInt(m[3] || "0", 10) };
  };

  /**
   * "…regains Hit Points equal to 2d8 plus your spellcasting ability modifier."
   *
   * The bundled records carry the dice in `damage_roll` and the modifier nowhere
   * at all — it lives only in the prose, so the prose is where it gets read
   * from. Healing Word filled in from the SRD healed its dice and no more.
   */
  const ADDS_CASTER_MOD = /plus your spellcasting ability modifier/i;

  const signed = (n) => (n < 0 ? String(n) : `+${n}`);

  /**
   * Open5e's `attack_roll` is not reliable — Faerie Fire carries it despite
   * being a Dexterity save with no attack. A spell that names a saving throw is
   * a save spell, so the save wins wherever the two disagree.
   */
  const isAttack = (rec) => Boolean(rec.attack_roll) && !rec.saving_throw_ability;

  /**
   * Build the spell in the shape the Spells tab already renders, so a filled-in
   * spell is indistinguishable from an imported one apart from its source line.
   *
   * `characterLevel` only matters for cantrips, whose dice scale on it.
   * `abilityMod` is the caster's spellcasting modifier, for the healing spells
   * whose text adds it.
   */
  function toSheetSpell(rec, { characterLevel = 1, source = null, abilityMod = 0 } = {}) {
    const dice = parseDice(rec.damage_roll);
    const heals = Boolean(rec.damage_roll) && !(rec.damage_types || []).length;
    const scale = rec.level === 0 ? cantripMultiplier(characterLevel) : 1;

    const rolled = dice && {
      ...dice,
      count: dice.count * scale,
      roll: `${dice.count * scale}d${dice.sides}${dice.flat ? `+${dice.flat}` : ""}`,
    };

    // Healing keeps its flat part separate, so upcasting can rebuild the dice
    // and put the modifier back once rather than once per slot level.
    const healFlat = heals && ADDS_CASTER_MOD.test(rec.desc || "") ? abilityMod : 0;
    const healTotal = (rolled?.flat || 0) + healFlat;

    return {
      name: rec.name,
      level: rec.level,
      school: rec.school || null,

      damage: !heals && rolled ? [{ type: (rec.damage_types || [])[0] || null, ...rolled }] : [],
      healing: heals && rolled ? `${rolled.count}d${rolled.sides}${healTotal ? signed(healTotal) : ""}` : null,
      healingFlat: healTotal,
      // Absolute dice per slot level, straight from the source data — more exact
      // than re-deriving a progression from the "at higher levels" sentence.
      upcastTable: rec.upcast || null,
      upcast: null,
      variants: [],
      canUpcast: Boolean(rec.upcast) && rec.level > 0,

      prepared: null,
      alwaysPrepared: true,
      ritual: Boolean(rec.ritual),
      concentration: Boolean(rec.concentration),

      castingTime: CASTING_TIME[rec.casting_time] || rec.casting_time || null,
      range: rec.range_text || null,
      aoe: rec.shape_type && rec.shape_size
        ? `${rec.shape_size} ${rec.shape_size_unit || "feet"} ${rec.shape_type}`
        : null,
      duration: rec.concentration ? `Concentration, ${rec.duration}` : TITLE(rec.duration),
      components: [rec.verbal && "V", rec.somatic && "S", rec.material && "M"].filter(Boolean).join(", "),
      materials: rec.material_specified || null,

      requiresAttackRoll: isAttack(rec),
      requiresSavingThrow: Boolean(rec.saving_throw_ability),
      saveAbility: TITLE(rec.saving_throw_ability) || null,

      description: rec.desc || "",
      higherLevels: rec.higher_level || "",

      // Marks where this came from, so the sheet can say so rather than implying
      // D&D Beyond sent it.
      filledFrom: source || bundled?.source || "srd",
    };
  }

  // --- monster spells ------------------------------------------------------

  /**
   * One spell out of a monster's statblock, resolved and dressed in the
   * statblock's own numbers.
   *
   * A statblock states its save DC and spell attack bonus once, for everything
   * the creature casts, and never restates the spell itself. So the dice come
   * from the bundled list and the numbers to beat come from the monster — and
   * where the two could disagree, the monster wins, because the monster is the
   * thing being run.
   *
   * `override` is the GM's word on top of both, for the times a statblock is a
   * starting point rather than a rule: the fire cultist's fireball that has to
   * come out cold. It replaces values, never merges into them.
   *
   * Call `loadBundled()` first — this is synchronous so the statblock can render
   * in one pass.
   */
  function monsterSpell(ref, block, { casterLevel = 1, abilityMod = 0, override = {} } = {}) {
    const rec = index?.get(key(ref.name)) || index?.get(key(ref.name).replace(/\s+/g, "")) || null;
    const base = rec ? toSheetSpell(rec, { characterLevel: casterLevel, abilityMod }) : null;

    // Whichever dice the spell rolls — a heal is as worth overriding as a hit.
    const rolled = base?.damage?.[0]?.roll || base?.healing || null;
    const heals = Boolean(base?.healing) && !base?.damage?.length;

    const edits = Object.entries(override).filter(([, v]) => v != null && v !== "");

    return {
      // Stable under renaming and re-resolution: what the statblock printed.
      key: key(ref.name),
      name: rec?.name || TITLE(ref.name),
      // The restriction the statblock put in brackets — "self only", "air
      // elemental only". Never part of the spell, never dropped either.
      note: ref.note || null,
      found: Boolean(rec),

      level: base?.level ?? null,
      school: base?.school || null,
      castingTime: base?.castingTime || null,
      range: base?.range || null,
      duration: base?.duration || null,
      components: base?.components || null,
      concentration: Boolean(base?.concentration),
      ritual: Boolean(base?.ritual),
      description: base?.description || "",

      requiresAttackRoll: Boolean(base?.requiresAttackRoll),
      requiresSavingThrow: Boolean(base?.requiresSavingThrow),
      saveAbility: base?.saveAbility || null,

      toHit: override.toHit ?? block.toHit ?? null,
      saveDc: override.saveDc ?? block.saveDc ?? null,
      dice: override.dice ?? rolled,
      damageType: override.damageType ?? base?.damage?.[0]?.type ?? null,
      heals,

      // So the panel can mark what it was told to change and offer it back.
      edited: edits.length > 0,
      override,
    };
  }

  return {
    loadBundled,
    find,
    /** How a spell name is matched and how an override is filed against it. */
    spellKey: key,
    monsterSpell,
    toSheetSpell,
    get licenses() {
      return bundled?.licenses || [];
    },
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Spells;
else if (typeof window !== "undefined") window.Spells = Spells;
