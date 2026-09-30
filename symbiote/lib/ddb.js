/**
 * D&D Beyond character JSON -> normalized sheet.
 *
 * Loaded two ways, so it must stay dependency-free and framework-free:
 *   - in the Symbiote, as a classic <script> (no ES modules: a local Symbiote is
 *     served from a file origin, where module imports are blocked by CORS)
 *   - in Node, via prototype/normalize-cli.js, through the CommonJS footer below
 *
 * This is where the real work of the project lives. D&D Beyond ships raw modifier
 * arrays, not computed values, so every number a player expects to read off a
 * sheet gets derived here.
 */


// ---------------------------------------------------------------------------
// Static rules data. None of this is in the character payload.
// ---------------------------------------------------------------------------

const ABILITIES = [
  { id: 1, key: "str", name: "Strength" },
  { id: 2, key: "dex", name: "Dexterity" },
  { id: 3, key: "con", name: "Constitution" },
  { id: 4, key: "int", name: "Intelligence" },
  { id: 5, key: "wis", name: "Wisdom" },
  { id: 6, key: "cha", name: "Charisma" },
];

const SKILLS = [
  ["acrobatics", "Acrobatics", "dex"],
  ["animal-handling", "Animal Handling", "wis"],
  ["arcana", "Arcana", "int"],
  ["athletics", "Athletics", "str"],
  ["deception", "Deception", "cha"],
  ["history", "History", "int"],
  ["insight", "Insight", "wis"],
  ["intimidation", "Intimidation", "cha"],
  ["investigation", "Investigation", "int"],
  ["medicine", "Medicine", "wis"],
  ["nature", "Nature", "int"],
  ["perception", "Perception", "wis"],
  ["performance", "Performance", "cha"],
  ["persuasion", "Persuasion", "cha"],
  ["religion", "Religion", "int"],
  ["sleight-of-hand", "Sleight of Hand", "dex"],
  ["stealth", "Stealth", "dex"],
  ["survival", "Survival", "wis"],
];

// DDB condition ids.
/**
 * What each condition actually does, because D&D Beyond sends only an id.
 *
 * `self` is the half a player has to act on themselves — the rolls they must
 * remember to take at disadvantage, the movement they've lost. `rules` is the
 * full entry for the hover. Text follows the 2024 Player's Handbook, which is
 * what the character payloads reference; 2014 exhaustion in particular worked
 * very differently.
 */
const CONDITION_RULES = {
  Blinded: {
    self: "Disadvantage on attack rolls · auto-fail sight-based checks",
    rules: [
      "You can't see and automatically fail any ability check that requires sight.",
      "Attack rolls against you have Advantage, and your attack rolls have Disadvantage.",
    ],
  },
  Charmed: {
    self: "Can't attack the charmer",
    rules: [
      "You can't attack the charmer or target the charmer with damaging abilities or magical effects.",
      "The charmer has Advantage on ability checks to interact socially with you.",
    ],
  },
  Deafened: {
    self: "Auto-fail hearing-based checks",
    rules: ["You can't hear and automatically fail any ability check that requires hearing."],
  },
  Exhaustion: {
    self: "Penalty to every D20 Test, reduced Speed",
    rules: [
      "Every D20 Test you make is reduced by 2 × your exhaustion level.",
      "Your Speed is reduced by 5 feet × your exhaustion level.",
      "A Long Rest removes one level. The condition ends at level 0; level 6 is death.",
    ],
  },
  Frightened: {
    self: "Disadvantage on attacks and checks while you can see the source",
    rules: [
      "You have Disadvantage on ability checks and attack rolls while the source of fear is within line of sight.",
      "You can't willingly move closer to the source of fear.",
    ],
  },
  Grappled: {
    self: "Speed 0 · Disadvantage attacking anyone but the grappler",
    rules: [
      "Your Speed is 0 and can't increase.",
      "You have Disadvantage on attack rolls against any target other than the grappler.",
      "The grappler can drag or carry you, at 1 extra foot of cost per foot moved.",
    ],
  },
  Incapacitated: {
    self: "No action, bonus action or reaction · concentration broken",
    rules: [
      "You can't take any action, Bonus Action, or Reaction.",
      "Concentration is broken and you can't speak.",
      "If you're Incapacitated when you roll Initiative, you have Disadvantage on the roll.",
    ],
  },
  Invisible: {
    self: "Advantage on attack rolls · Advantage on Initiative",
    rules: [
      "Attack rolls against you have Disadvantage, and your attack rolls have Advantage — unless the creature can somehow see you.",
      "You aren't affected by anything requiring its target to be seen, and your equipment is concealed too.",
      "If you're Invisible when you roll Initiative, you have Advantage on the roll.",
    ],
  },
  Paralyzed: {
    self: "Incapacitated and Restrained · auto-fail STR and DEX saves",
    rules: [
      "You have the Incapacitated and Restrained conditions.",
      "You automatically fail Strength and Dexterity saving throws.",
      "Attack rolls against you have Advantage, and any hit from within 5 feet is a Critical Hit.",
    ],
  },
  Petrified: {
    self: "Incapacitated · Resistance to all damage · auto-fail STR and DEX saves",
    rules: [
      "You and your mundane belongings turn to stone. You weigh ten times more and stop aging.",
      "You have the Incapacitated condition, can't move or speak, and are unaware of your surroundings.",
      "You automatically fail Strength and Dexterity saving throws, and attacks against you have Advantage.",
      "You have Resistance to all damage and Immunity to the Poisoned condition.",
    ],
  },
  Poisoned: {
    self: "Disadvantage on attack rolls and ability checks",
    rules: ["You have Disadvantage on attack rolls and ability checks."],
  },
  Prone: {
    self: "Disadvantage on attack rolls · half Speed to stand up",
    rules: [
      "Your only movement is to crawl, or to spend half your Speed righting yourself. At Speed 0 you can't stand.",
      "You have Disadvantage on attack rolls.",
      "Attacks against you have Advantage from within 5 feet, Disadvantage from further away.",
    ],
  },
  Restrained: {
    self: "Speed 0 · Disadvantage on attack rolls and DEX saves",
    rules: [
      "Your Speed is 0 and can't increase.",
      "Attack rolls against you have Advantage, and your attack rolls have Disadvantage.",
      "You have Disadvantage on Dexterity saving throws.",
    ],
  },
  Stunned: {
    self: "Incapacitated · auto-fail STR and DEX saves",
    rules: [
      "You have the Incapacitated condition.",
      "You automatically fail Strength and Dexterity saving throws.",
      "Attack rolls against you have Advantage.",
    ],
  },
  Unconscious: {
    self: "Incapacitated and Prone · auto-fail STR and DEX saves",
    rules: [
      "You have the Incapacitated and Prone conditions, and you drop what you're holding.",
      "You're unaware of your surroundings.",
      "You automatically fail Strength and Dexterity saving throws.",
      "Attack rolls against you have Advantage, and any hit from within 5 feet is a Critical Hit.",
    ],
  },

  // Not conditions in the rules, but states the table tracks the same way and
  // that carry the same "what do I have to remember" problem.
  Concentrating: {
    self: "CON save when damaged · DC 10 or half the damage, whichever is higher",
    rules: [
      "When you take damage, make a Constitution saving throw to keep the spell.",
      "The DC is 10 or half the damage taken, whichever is higher.",
      "Concentration also ends if you become Incapacitated, die, or cast another spell that needs it.",
    ],
  },
  Dodging: {
    self: "Attacks against you have Disadvantage · Advantage on DEX saves",
    rules: [
      "Until the start of your next turn, attack rolls against you have Disadvantage if you can see the attacker.",
      "You make Dexterity saving throws with Advantage.",
      "You lose both benefits if you become Incapacitated or your Speed drops to 0.",
    ],
  },
  Hidden: {
    self: "Advantage on attack rolls · attacks against you have Disadvantage",
    rules: [
      "You have the Invisible condition for as long as you stay hidden.",
      "You give yourself away by making a sound louder than a whisper, making an attack roll, or casting a spell with a Verbal component.",
      "An enemy that finds you with a Wisdom (Perception) check against your Stealth also ends it.",
    ],
  },
};

/**
 * The rules for a condition, with exhaustion's arithmetic worked out for the
 * level you're actually on — "−4 to every D20 Test" beats "2 × your level".
 */
function conditionHelp(name, level) {
  const entry = CONDITION_RULES[name];
  if (!entry) return null;
  if (name !== "Exhaustion" || !level) return entry;

  return {
    self: `${signed(-2 * level)} to every D20 Test · Speed ${signed(-5 * level)} ft.`,
    rules: [
      `At level ${level}: every D20 Test is reduced by ${2 * level}, and your Speed drops by ${5 * level} feet.`,
      ...entry.rules.slice(2),
    ],
  };
}

const CONDITIONS = {
  1: "Blinded", 2: "Charmed", 3: "Deafened", 4: "Exhaustion", 5: "Frightened",
  6: "Grappled", 7: "Incapacitated", 8: "Invisible", 9: "Paralyzed",
  10: "Petrified", 11: "Poisoned", 12: "Prone", 13: "Restrained",
  14: "Stunned", 15: "Unconscious",
};

// Slot table indexed by *effective caster level*. Half, third and full casters
// all resolve onto this one table; warlocks do not (see PACT_SLOTS).
const CASTER_SLOTS = [
  [], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1],
  [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

// Warlocks are their own system: few slots, all at the same level, back on a
// SHORT rest. [count, slotLevel] by warlock level.
const PACT_SLOTS = [
  null, [1, 1], [2, 1], [2, 2], [2, 2], [2, 3], [2, 3], [2, 4], [2, 4], [2, 5],
  [2, 5], [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [4, 5], [4, 5], [4, 5], [4, 5],
];

const FULL_CASTERS = new Set(["Bard", "Cleric", "Druid", "Sorcerer", "Wizard"]);
const HALF_CASTERS = new Set(["Paladin", "Ranger"]);
const THIRD_CASTER_CLASSES = new Set(["Fighter", "Rogue"]);

const ARMOR_TYPE = { 1: "light", 2: "medium", 3: "heavy", 4: "shield" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mod = (score) => Math.floor((score - 10) / 2);
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
const stripHtml = (html) =>
  (html || "")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{2,}/g, "\n")
    .trim();

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Shrink a D&D Beyond payload to what the normaliser actually reads.
 *
 * Keeping the payload matters because armour class and ability scores depend on
 * which items are equipped, so unequipping a ring has to re-derive the sheet from
 * source rather than patch the output. The raw payload is about a megabyte,
 * mostly character-builder bookkeeping and prose the sheet never shows, which
 * would exhaust the 5 MB storage budget after a handful of characters.
 *
 * The keep-list is deliberate rather than clever: anything not named here is
 * dropped, and `dev/compaction-test.mjs` proves the normalised output is
 * byte-identical before and after.
 */
const PAYLOAD_KEEP = [
  "id", "name", "readonlyUrl", "decorations", "currentXp",
  "baseHitPoints", "bonusHitPoints", "overrideHitPoints", "removedHitPoints", "temporaryHitPoints",
  "stats", "bonusStats", "overrideStats",
  "race", "classes", "background", "feats",
  "inventory", "currencies", "customItems",
  "modifiers", "characterValues", "conditions",
  "spells", "classSpells", "actions", "options",
  "customSenses", "customSpeeds", "customProficiencies", "customActions", "customDefenseAdjustments",
  "deathSaves", "spellSlots", "pactMagic", "preferences",
];

/**
 * Spells a class feature grants through a level table.
 *
 * A subclass lists its always-prepared spells in a table inside the feature's
 * rules text — "3rd | faerie fire, moonbeam, see invisibility, sleep" — and
 * nowhere else in the export. D&D Beyond's website merges the real definitions
 * in from a separate service; the character payload never carries them, so
 * these names are the only trace the panel gets.
 */
function featureSpellTable(description) {
  if (!description || !/<t[dh][^>]*>/i.test(description)) return null;

  const rows = [];
  const ROW = /<tr[^>]*>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = ROW.exec(description))) {
    const level = /^(\d+)(?:st|nd|rd|th)$/i.exec(stripHtml(m[1]).trim());
    if (!level) continue;
    const names = stripHtml(m[2])
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length) rows.push({ level: parseInt(level[1], 10), names });
  }
  return rows.length ? rows : null;
}

/** Compaction strips feature prose, so read the table from whichever survives. */
const spellTableOf = (f) => f.spellTable || featureSpellTable(f.description);

/** Class blobs carry the full rules text of every feature; we need ids and names. */
function compactClass(cls) {
  const trimFeatures = (list) =>
    (list || []).map((f) => {
      const out = { id: f.id, name: f.name, requiredLevel: f.requiredLevel };
      // The one piece of prose worth keeping: without it a re-derived sheet
      // would silently lose its subclass's spells.
      const table = spellTableOf(f);
      if (table) out.spellTable = table;
      return out;
    });

  const trimDefinition = (def) =>
    def && {
      id: def.id,
      name: def.name,
      hitDice: def.hitDice,
      canCastSpells: def.canCastSpells,
      spellCastingAbilityId: def.spellCastingAbilityId,
      spellRules: def.spellRules,
      classFeatures: trimFeatures(def.classFeatures),
    };

  // `cls.classFeatures` repeats every feature's full rules text a second time,
  // alongside the copy already in `definition.classFeatures`. Nothing reads it.
  const { classFeatures, ...rest } = cls;
  return {
    ...rest,
    definition: trimDefinition(cls.definition),
    subclassDefinition: trimDefinition(cls.subclassDefinition),
  };
}

/**
 * Artwork and sourcebook citations ride along on every definition in the payload
 * and are never read. Stripped recursively rather than per-section so a new
 * section doesn't quietly reintroduce them.
 */
const DEAD_WEIGHT = /AvatarUrl$|^avatarUrl$|^moreDetailsUrl$|^sources$|^longDescription$/;

/** Rules text is always rendered through stripHtml, so store it already stripped. */
const PROSE = /^description$|^snippet$|^multiClassDescription$/;

function stripDeadWeight(value) {
  if (Array.isArray(value)) return value.map(stripDeadWeight);
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (DEAD_WEIGHT.test(key)) continue;
    out[key] = PROSE.test(key) && typeof v === "string" ? stripHtml(v) : stripDeadWeight(v);
  }
  return out;
}

function compactPayload(payload) {
  const data = payload.data || payload;
  const out = {};
  for (const key of PAYLOAD_KEEP) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  if (out.classes) out.classes = out.classes.map(compactClass);

  // `decorations` is the one place an avatar URL is load-bearing.
  const decorations = out.decorations;
  const stripped = stripDeadWeight(out);
  if (decorations) stripped.decorations = decorations;
  return { data: stripped };
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

/** D&D limits a character to three attuned items at once. */
const ATTUNEMENT_LIMIT = 3;

/**
 * Apply the player's equip/attune choices over what D&D Beyond last saved.
 *
 * Taking a ring off has to change armour class, and armour class is derived from
 * modifiers, which are derived from inventory state — so the override has to land
 * here, before anything reads the inventory, rather than being patched onto the
 * finished sheet.
 */
function applyEquipment(data, overrides) {
  if (!overrides || !Object.keys(overrides).length) return data;

  return {
    ...data,
    inventory: (data.inventory || []).map((item) => {
      const over = overrides[item.id];
      if (!over) return item;
      return {
        ...item,
        equipped: over.equipped ?? item.equipped,
        isAttuned: over.attuned ?? item.isAttuned,
      };
    }),
  };
}

/** One readable line per thing an item grants, for the gear list. */
function describeGrants(definition) {
  const out = [];
  for (const m of definition?.grantedModifiers || []) {
    const what = m.friendlySubtypeName || m.subType;
    if (m.type === "bonus" || m.type === "damage") {
      const amount = m.dice?.diceString || (m.value != null ? signed(m.value) : "");
      out.push(amount ? `${amount} ${what}` : what);
    } else if (m.type === "set" || m.type === "set-base") {
      out.push(m.value != null ? `${what} ${m.value}` : what);
    } else {
      out.push(`${m.friendlyTypeName || m.type}: ${what}`);
    }
  }
  return out;
}

/**
 * The inventory, flattened for display. `stowed` marks an item packed inside a
 * container rather than carried directly, which is why a backpack full of arrows
 * doesn't read as 60 separate things on your person.
 */
function inventory(data) {
  const characterId = data.id;
  return (data.inventory || [])
    .filter((item) => item.definition)
    .map((item) => {
      const d = item.definition;
      return {
        id: item.id,
        name: d.name,
        kind: d.filterType || d.type || "Gear",
        rarity: d.rarity,
        magic: Boolean(d.magic),
        quantity: item.quantity ?? 1,
        weight: d.weight ?? 0,
        armorClass: d.armorClass ?? null,
        canEquip: Boolean(d.canEquip),
        canAttune: Boolean(d.canAttune),
        equipped: Boolean(item.equipped),
        attuned: Boolean(item.isAttuned),
        stowed: item.containerEntityId != null && item.containerEntityId !== characterId,
        grants: describeGrants(d),
        description: stripHtml(d.description || ""),
      };
    });
}

/**
 * Every modifier from every source, flattened. This is the spine of the whole file.
 *
 * `data.modifiers.item` already holds the granted modifiers of everything in the
 * inventory, so walking `inventory[].grantedModifiers` as well counts equipped
 * magic items twice — two Ruby Rings and a pair of bracers turn +8 Charisma into
 * +16 and quietly inflate armour class. But that list is unfiltered: it includes
 * items sitting in a backpack. So we take D&D Beyond's list and filter it back
 * down by the state of the item that granted each entry.
 */
function allModifiers(data) {
  const items = new Map();
  for (const item of data.inventory || []) {
    const def = item.definition;
    if (def?.id != null) items.set(def.id, { name: def.name, item });
  }

  const out = [];
  for (const [source, list] of Object.entries(data.modifiers || {})) {
    for (const m of list || []) {
      if (source === "item") {
        const owner = items.get(m.componentId);
        if (!owner) continue;
        if (!owner.item.equipped) continue;
        if (m.requiresAttunement && !owner.item.isAttuned) continue;
        out.push({ ...m, source, itemName: owner.name });
        continue;
      }
      out.push({ ...m, source });
    }
  }
  return out;
}

const has = (mods, type, subType) =>
  mods.some((m) => m.type === type && m.subType === subType);

/**
 * Conditional modifiers carry a prose `restriction` ("to avoid or end the
 * Poisoned condition"). Treating those as unconditional is the single easiest
 * way to produce a confidently wrong sheet, so advantage is split in two:
 * flat advantage, and advantage-with-a-caveat the player has to read.
 */
function advantageOn(mods, subType) {
  const matches = mods.filter((m) => m.type === "advantage" && m.subType === subType);
  return {
    always: matches.some((m) => !m.restriction),
    conditional: matches.filter((m) => m.restriction).map((m) => m.restriction),
  };
}

const sumOf = (mods, type, subType) =>
  mods
    .filter((m) => m.type === type && m.subType === subType)
    .reduce((t, m) => t + (m.value || 0), 0);

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * Map each feature id to the level of the class that granted it.
 *
 * Modifiers carry a `componentId` pointing at the feature they came from, which
 * is the only way to tell a class-scoped bonus from a global one. It matters:
 * Draconic Resilience grants +1 HP per *sorcerer* level, not per character level,
 * so on a Rogue 8 / Sorcerer 8 / Warlock 4 the difference is 12 hit points.
 */
/**
 * The three boxes in D&D Beyond's "Armor Class" editor — override, magic bonus,
 * misc bonus — come back as character-scoped `characterValues`, not modifiers.
 * They carry the note the player typed, which is the "(Mage Armor)" that shows
 * up in parentheses on the sheet.
 *
 * Item-scoped entries reuse the same type ids for unrelated things (custom
 * names, equipped flags), so a null `valueId` is what marks one as ours.
 */
function acAdjustments(data) {
  const AC_TYPES = { 1: "override", 2: "Magic Bonus", 3: "Misc Bonus" };
  const out = [];
  for (const v of data.characterValues || []) {
    const kind = AC_TYPES[v.typeId];
    if (!kind || v.valueId != null) continue;
    if (typeof v.value !== "number") continue;
    out.push({ kind, value: v.value, note: (v.notes || "").trim() });
  }
  return out;
}

/**
 * Feature id -> the name of the feature, so a breakdown row can say
 * "Draconic Resilience" instead of the modifier's generic subtype name.
 */
function componentNames(data) {
  const map = new Map();
  const put = (id, name) => { if (id != null && name) map.set(id, name); };

  for (const cls of data.classes || []) {
    for (const f of cls.definition?.classFeatures || []) put(f.id, f.name);
    for (const f of cls.subclassDefinition?.classFeatures || []) put(f.id, f.name);
  }
  for (const f of data.feats || []) put(f.definition?.id, f.definition?.name);
  for (const t of data.race?.racialTraits || []) put(t.definition?.id, t.definition?.name);
  return map;
}

function componentClassLevels(data) {
  const map = new Map();
  for (const cls of data.classes || []) {
    const level = cls.level || 0;
    const features = [
      ...(cls.definition?.classFeatures || []),
      ...(cls.subclassDefinition?.classFeatures || []),
    ];
    for (const f of features) if (f?.id != null) map.set(f.id, level);
  }
  return map;
}

function totalLevel(data) {
  return (data.classes || []).reduce((t, c) => t + (c.level || 0), 0);
}

function proficiencyBonus(level) {
  return Math.floor((level - 1) / 4) + 2;
}

const DEFAULT_ABILITY_MAX = 20;

/**
 * Ability scores, with the 20 cap applied explicitly.
 *
 * The cap is not a constant: Epic Boons and some magic items raise it through
 * `bonus / ability-score-maximum`, which is the only reason a Charisma of 26 is
 * legal. Two things step around the cap entirely — a manual override typed into
 * D&D Beyond, and `set` modifiers such as a Belt of Giant Strength, which state
 * a score outright rather than adding to one.
 */
function abilityScores(data, mods) {
  const scores = {};
  for (const ab of ABILITIES) {
    const sub = ab.name.toLowerCase();
    const base = data.stats?.find((s) => s.id === ab.id)?.value ?? 10;
    const bonus = data.bonusStats?.find((s) => s.id === ab.id)?.value ?? 0;
    const override = data.overrideStats?.find((s) => s.id === ab.id)?.value;

    // Feats, species traits and background ASIs all land here as
    // `bonus / <ability>-score` modifiers.
    const fromMods = sumOf(mods, `bonus`, `${sub}-score`);

    // `ability-score-maximum` bonuses are aimed by statId, not by subtype.
    const maximum = mods
      .filter((m) => m.type === "bonus" && m.subType === "ability-score-maximum" && m.statId === ab.id)
      .reduce((t, m) => t + (m.value || 0), DEFAULT_ABILITY_MAX);

    // `set` modifiers (Belt of Giant Strength and friends) win outright.
    const setMods = mods
      .filter((m) => m.type === "set" && m.subType === `${sub}-score`)
      .map((m) => m.value || 0);

    const raw = base + bonus + fromMods;
    let value = override ?? Math.min(raw, maximum);
    if (setMods.length) value = Math.max(value, ...setMods);

    scores[ab.key] = {
      name: ab.name,
      score: value,
      mod: mod(value),
      maximum,
      // Surfaced so the sheet can say why a score stopped short rather than
      // looking like it miscalculated.
      cappedFrom: override == null && raw > maximum ? raw : null,
    };
  }
  return scores;
}

/**
 * Initiative. Most bonuses carry a plain value, but a few — the 2024 Alert feat
 * among them — express "add your Proficiency Bonus" as `bonusTypes: [1]` with a
 * null value, which sums to nothing if you only read `value`.
 */
const PROFICIENCY_BONUS_TYPE = 1;

function initiativeBonus(scores, mods, pb) {
  let total = scores.dex.mod;
  for (const m of mods) {
    if (m.type !== "bonus" || m.subType !== "initiative") continue;
    if ((m.bonusTypes || []).includes(PROFICIENCY_BONUS_TYPE)) total += pb;
    else total += m.value || 0;
  }
  return total;
}

function hitPoints(data, scores, level, mods, classLevels, names) {
  const conMod = scores.con.mod;
  const breakdown = [];

  const base = data.baseHitPoints || 0;
  breakdown.push({ label: "Base hit points", value: base });

  const conTotal = conMod * level;
  breakdown.push({ label: `Constitution ${signed(conMod)} × ${level} levels`, value: conTotal });

  if (data.bonusHitPoints) breakdown.push({ label: "Bonus hit points", value: data.bonusHitPoints });

  // Per-level bonuses scale with the granting class's level when we can trace it,
  // and with character level otherwise (species traits, feats).
  let perLevelTotal = 0;
  for (const m of mods) {
    if (m.type !== "bonus" || m.subType !== "hit-points-per-level") continue;
    const per = m.value || 0;
    const scopeLevel = classLevels.get(m.componentId) ?? level;
    const amount = per * scopeLevel;
    perLevelTotal += amount;
    const from = names.get(m.componentId) || m.itemName || m.friendlySubtypeName || "Hit points per level";
    breakdown.push({
      label: `${from} ${signed(per)} × ${scopeLevel}`,
      value: amount,
    });
  }

  // Flat hit point bonuses — items, feats, homebrew — were previously ignored.
  let flatTotal = 0;
  for (const m of mods) {
    if (m.type !== "bonus" || m.subType !== "hit-points") continue;
    // Potions carry `bonus / hit-points` with a dice roll — that's healing, not
    // a higher maximum, so it must not land in the HP total.
    if (m.dice) continue;
    const amount = m.value || 0;
    if (!amount) continue;
    flatTotal += amount;
    const from = names.get(m.componentId) || m.itemName || m.friendlySubtypeName || "Hit points bonus";
    breakdown.push({ label: from, value: amount });
  }

  const computed = base + (data.bonusHitPoints || 0) + conTotal + perLevelTotal + flatTotal;
  const max = data.overrideHitPoints ?? computed;
  if (data.overrideHitPoints != null) {
    breakdown.push({ label: "Override set on D&D Beyond", value: data.overrideHitPoints, override: true });
  }

  // Hit dice are per class, but classes that share a die type share a pool —
  // a Fighter 3 / Paladin 2 has 5d10, not 3d10 and 2d10. They must be merged:
  // play state keys spent dice by die type, so two pools of the same type would
  // share one counter and corrupt each other.
  const pools = new Map();
  for (const c of data.classes || []) {
    const die = `d${c.definition?.hitDice}`;
    const pool = pools.get(die) || { die, total: 0, used: 0, classes: [] };
    pool.total += c.level || 0;
    pool.used += c.hitDiceUsed || 0;
    pool.classes.push(c.definition?.name);
    pools.set(die, pool);
  }

  return {
    max,
    current: max - (data.removedHitPoints || 0),
    temp: data.temporaryHitPoints || 0,
    breakdown,
    hitDice: [...pools.values()].sort((a, b) => parseInt(b.die.slice(1), 10) - parseInt(a.die.slice(1), 10)),
  };
}

/**
 * D&D Beyond does not simply use whatever armour is equipped — it computes every
 * base it is entitled to and keeps the best. This character wears Leather (11+5
 * = 16) but is a Draconic Sorcerer (10+5+8 = 23), so the sheet reads
 * "Armor(None)" even though armour is equipped. Picking the worn armour blindly
 * loses 7 points.
 */
function armorClass(data, scores, mods) {
  const equipped = (data.inventory || []).filter(
    (i) => i.equipped && i.definition?.filterType === "Armor"
  );
  const bodies = equipped.filter((i) => ARMOR_TYPE[i.definition.armorTypeId] !== "shield");
  const shields = equipped.filter((i) => ARMOR_TYPE[i.definition.armorTypeId] === "shield");
  const dex = scores.dex.mod;

  // --- candidate bases ------------------------------------------------------

  const candidates = [];

  // Unarmoured. `set / unarmored-armor-class` carries a statId naming a second
  // ability that stacks on top of Dexterity (Charisma for Draconic Resilience,
  // Wisdom for a Monk, Constitution for a Barbarian).
  {
    const parts = [
      { label: "Armour (none)", value: 10 },
      { label: "Dexterity", value: dex },
    ];
    for (const m of mods) {
      if (m.type !== "set" || m.subType !== "unarmored-armor-class") continue;
      const key = ABILITIES.find((a) => a.id === m.statId)?.key;
      if (key) {
        parts.push({
          label: `${m.friendlySubtypeName || "Unarmoured defence"} (${scores[key].name})`,
          value: scores[key].mod,
        });
      } else if (m.value) {
        parts.push({ label: m.friendlySubtypeName || "Unarmoured defence", value: m.value });
      }
    }
    candidates.push(parts);
  }

  for (const item of bodies) {
    const kind = ARMOR_TYPE[item.definition.armorTypeId];
    const cap = kind === "medium" ? 2 : kind === "heavy" ? 0 : Infinity;
    const dexPart = Math.min(dex, cap);
    const parts = [{ label: item.definition.name, value: item.definition.armorClass || 0 }];
    if (dexPart) {
      parts.push({
        label: cap === Infinity ? "Dexterity" : `Dexterity (max ${cap})`,
        value: dexPart,
      });
    }
    candidates.push(parts);
  }

  // Mage Armor and friends set a base of their own, which still takes Dexterity.
  for (const m of mods) {
    if (m.type !== "set" || m.subType !== "armor-class" || !m.value) continue;
    candidates.push([
      { label: m.itemName || m.friendlySubtypeName || "Set by an effect", value: m.value },
      { label: "Dexterity", value: dex },
    ]);
  }

  const sum = (parts) => parts.reduce((t, p) => t + p.value, 0);
  const best = candidates.reduce((a, b) => (sum(b) > sum(a) ? b : a));
  const unarmoured = best === candidates[0];

  const breakdown = [];
  let total = 0;
  const add = (label, value) => {
    if (!value) return;
    breakdown.push({ label, value });
    total += value;
  };

  for (const part of best) add(part.label, part.value);
  for (const shield of shields) add(shield.definition.name, shield.definition.armorClass || 0);

  // Additive sources. `unarmored-armor-class` bonuses were dropped entirely
  // before, which is most of a Draconic Sorcerer's armour class.
  for (const m of mods) {
    if (m.type !== "bonus") continue;
    if (m.subType !== "armor-class" && m.subType !== "unarmored-armor-class") continue;
    if (m.subType === "unarmored-armor-class" && !unarmoured) continue;

    const key = ABILITIES.find((a) => a.id === m.statId)?.key;
    add(m.itemName || m.friendlySubtypeName || "Bonus", key ? scores[key].mod : m.value || 0);
  }

  for (const adj of acAdjustments(data)) {
    if (adj.kind === "override") continue;
    add(adj.note ? `${adj.kind} (${adj.note})` : adj.kind, adj.value);
  }

  const override = acAdjustments(data).find((a) => a.kind === "override");
  if (override) {
    breakdown.push({ label: "Override set on D&D Beyond", value: override.value, override: true });
    total = override.value;
  }

  return { value: total, breakdown, summary: breakdown.map((b) => `${b.label} ${signed(b.value)}`) };
}

function savingThrows(scores, mods, pb) {
  return ABILITIES.map((ab) => {
    const sub = `${ab.name.toLowerCase()}-saving-throws`;
    const proficient = has(mods, "proficiency", sub);
    // A bonus can be aimed at one ability ("+1 Intelligence saving throws") or at
    // saves in general, the way Bracers of the Shadow Archer are. Reading only the
    // specific subtype silently drops the blanket ones.
    const bonus = sumOf(mods, "bonus", sub) + sumOf(mods, "bonus", "saving-throws");
    const specific = advantageOn(mods, sub);
    const general = advantageOn(mods, "saving-throws");
    const value = scores[ab.key].mod + (proficient ? pb : 0) + bonus;
    return {
      key: ab.key,
      name: ab.name,
      proficient,
      value,
      advantage: specific.always || general.always,
      conditionalAdvantage: [...specific.conditional, ...general.conditional],
    };
  });
}

function skills(scores, mods, pb) {
  return SKILLS.map(([sub, name, ability]) => {
    const proficient = has(mods, "proficiency", sub);
    const expertise = has(mods, "expertise", sub);
    const halfProf =
      has(mods, "half-proficiency", sub) || has(mods, "half-proficiency-round-up", sub);
    const bonus = sumOf(mods, "bonus", sub);

    let profPart = 0;
    if (expertise) profPart = pb * 2;
    else if (proficient) profPart = pb;
    else if (halfProf) profPart = Math.floor(pb / 2);

    const value = scores[ability].mod + profPart + bonus;
    return {
      key: sub,
      name,
      ability,
      proficient,
      expertise,
      value,
      passive: 10 + value,
      advantage: advantageOn(mods, sub).always,
    };
  });
}

function senses(data, mods, skillList) {
  const darkvision = Math.max(
    0,
    ...mods
      .filter((m) => ["set-base", "set", "bonus"].includes(m.type) && m.subType === "darkvision")
      .map((m) => m.value || 0)
  );
  const perception = skillList.find((s) => s.key === "perception");
  const investigation = skillList.find((s) => s.key === "investigation");
  const insight = skillList.find((s) => s.key === "insight");
  return {
    darkvision: darkvision || null,
    passivePerception: perception.passive,
    passiveInvestigation: investigation.passive,
    passiveInsight: insight.passive,
  };
}

function speeds(data, mods) {
  const base = data.race?.weightSpeeds?.normal || {};
  const bonus = sumOf(mods, "bonus", "speed");
  const out = {};
  for (const [kind, value] of Object.entries(base)) {
    if (!value) continue;
    out[kind] = kind === "walk" ? value + bonus : value;
  }
  return out;
}

function spellcasting(data, scores, pb, level) {
  const blocks = [];

  for (const cls of data.classes || []) {
    const abilityId = cls.definition?.spellCastingAbilityId;
    if (!abilityId && !cls.subclassDefinition?.spellCastingAbilityId) continue;

    const key = ABILITIES.find((a) => a.id === (abilityId ?? cls.subclassDefinition?.spellCastingAbilityId))?.key;
    if (!key) continue;

    const abilityMod = scores[key].mod;
    const classSpells =
      (data.classSpells || []).find((cs) => cs.characterClassId === cls.id)?.spells || [];

    blocks.push({
      className: cls.definition.name,
      ability: key,
      saveDc: 8 + pb + abilityMod,
      attackBonus: pb + abilityMod,
      spells: classSpells.map((sp) => normalizeSpell(sp, level, abilityMod, pb)),
    });
  }

  // Spells granted by feats, species or items sit outside classSpells, and carry
  // no spellcasting ability of their own. The character's best casting modifier
  // is the closest honest stand-in; for the single-caster case it is exact.
  const bestMod = blocks.reduce((best, b) => Math.max(best, b.saveDc - 8 - pb), 0);
  const extras = [];
  for (const [source, list] of Object.entries(data.spells || {})) {
    for (const s of list || []) extras.push({ ...normalizeSpell(s, level, bestMod, pb), grantedBy: source });
  }
  if (extras.length) {
    blocks.push({ className: "Other sources", ability: null, spells: extras });
  }

  return {
    blocks,
    granted: grantedSpells(data),
    slots: spellSlots(data),
    pact: pactSlots(data),
    derivation: casterDerivation(data),
  };
}

/**
 * Does this class contribute spell slots, and at what rate?
 *
 * Third-casters are the awkward case: Fighter and Rogue only cast as Eldritch
 * Knight / Arcane Trickster, so we look for a spellcasting ability on the
 * *subclass* rather than trusting the class name.
 */
function casterKind(cls) {
  const name = cls.definition?.name;
  if (name === "Warlock") return "pact";
  if (FULL_CASTERS.has(name)) return "full";
  if (HALF_CASTERS.has(name)) return "half";
  if (name === "Artificer") return "artificer";

  if (THIRD_CASTER_CLASSES.has(name)) {
    // Two independent signals, because getting this wrong costs a whole slot
    // tier: an Arcane Trickster contributing 0 instead of floor(level/3) silently
    // drops the party's highest spell level.
    const subclass = cls.subclassDefinition;
    const castsBySubclassData = Boolean(subclass?.spellCastingAbilityId || subclass?.canCastSpells);
    const castsByName = /arcane trickster|eldritch knight/i.test(subclass?.name || "");
    if (castsBySubclassData || castsByName) return "third";
  }
  return null;
}

/**
 * Reconstruct the slot table. The payload reports `used` per level but leaves
 * `available` at 0, so this has to come from class levels and rules data.
 *
 * Single-class and multiclass use *different* rules, and the difference is real:
 * a lone Paladin 5 has 4/2 slots (full-caster row 3, level rounded up), while a
 * multiclassed one contributes floor(5/2) = 2 levels to the shared pool. Treating
 * them the same shortchanges single-class half-casters by a whole slot tier.
 */
function spellSlots(data) {
  const casters = (data.classes || []).map((c) => ({ cls: c, kind: casterKind(c) })).filter((c) => c.kind);
  const slotCasters = casters.filter((c) => c.kind !== "pact");

  let effective = 0;
  if (slotCasters.length === 1) {
    const { cls, kind } = slotCasters[0];
    if (kind === "full") effective = cls.level;
    else if (kind === "half" || kind === "artificer") effective = Math.ceil(cls.level / 2);
    else if (kind === "third") effective = Math.ceil(cls.level / 3);
  } else {
    for (const { cls, kind } of slotCasters) {
      if (kind === "full") effective += cls.level;
      else if (kind === "artificer") effective += Math.ceil(cls.level / 2);
      else if (kind === "half") effective += Math.floor(cls.level / 2);
      else if (kind === "third") effective += Math.floor(cls.level / 3);
    }
  }

  effective = Math.max(0, Math.min(20, effective));
  const table = CASTER_SLOTS[effective] || [];

  return table.map((available, idx) => {
    const lvl = idx + 1;
    const used = (data.spellSlots || []).find((s) => s.level === lvl)?.used || 0;
    return { level: lvl, available, used, remaining: Math.max(0, available - used) };
  });
}

/**
 * Show the working behind the slot table.
 *
 * Nearly every number on this sheet is derived rather than read, and the caster
 * level is the one most likely to be quietly wrong — a subclass misread as a
 * third-caster adds a whole slot tier. Surfacing the arithmetic makes that
 * checkable at a glance instead of requiring a trip to D&D Beyond.
 */
function casterDerivation(data) {
  const casters = (data.classes || []).map((c) => ({ cls: c, kind: casterKind(c) })).filter((c) => c.kind);
  const slotCasters = casters.filter((c) => c.kind !== "pact");
  const single = slotCasters.length === 1;

  const contributions = slotCasters.map(({ cls, kind }) => {
    let contributes;
    if (kind === "full") contributes = cls.level;
    else if (kind === "artificer") contributes = Math.ceil(cls.level / 2);
    else if (kind === "half") contributes = single ? Math.ceil(cls.level / 2) : Math.floor(cls.level / 2);
    else contributes = single ? Math.ceil(cls.level / 3) : Math.floor(cls.level / 3);

    return {
      className: cls.definition?.name,
      subclass: cls.subclassDefinition?.name || null,
      kind,
      level: cls.level,
      contributes,
    };
  });

  return {
    single,
    contributions,
    effectiveLevel: Math.min(20, contributions.reduce((t, c) => t + c.contributes, 0)),
  };
}

/** Warlock pact magic: separate pool, separate recovery. */
function pactSlots(data) {
  const warlock = (data.classes || []).find((c) => c.definition?.name === "Warlock");
  if (!warlock) return null;

  const row = PACT_SLOTS[Math.min(20, warlock.level)];
  if (!row) return null;

  const [count, slotLevel] = row;
  const used = (data.pactMagic || []).find((s) => s.level === slotLevel)?.used || 0;
  return { level: slotLevel, available: count, used, remaining: Math.max(0, count - used), recovers: "short rest" };
}

/**
 * Upcast scaling is NOT in the payload as data. `atHigherLevels.higherLevelDefinitions`
 * is empty even for spells that obviously scale, so the only source is the rules
 * text — which is, fortunately, boilerplate:
 *
 *   "The damage increases by 1d6 for each spell slot level above 1."
 *
 * Both the 2014 and 2024 phrasings match. A spell whose scaling doesn't parse
 * simply reports no scaling, and upcasting it consumes the bigger slot without
 * changing dice — which is correct for spells that scale in range, targets, or
 * duration rather than damage.
 */
const UPCAST_RE =
  /(damage|healing)\s+increases\s+by\s+(\d*)d(\d+)\s+for\s+each\s+(?:spell\s+)?slot\s+level\s+above\s+(\d+)/i;

/**
 * Some spells swap their damage die under a stated condition:
 *
 *   "If the target is missing any of its Hit Points, it instead takes 1d12..."
 *
 * That rule exists only in prose. Rather than hand-maintaining a table of
 * exceptions, pull the condition and its die straight out of the text and offer
 * it as an alternate roll the player chooses — the panel never guesses which
 * applies, because it cannot see whether the target is hurt.
 */
const VARIANT_RE =
  /\bIf\s+([^.]{3,80}?),\s*(?:it|the target|they)\s+instead\s+takes?\s+(\d*)d(\d+)/i;

/**
 * Cantrips scale on character level, not slot level: one die at 1st, two at 5th,
 * three at 11th, four at 17th. `scaleType: "characterlevel"` marks these.
 */
function cantripMultiplier(level) {
  if (level >= 17) return 4;
  if (level >= 11) return 3;
  if (level >= 5) return 2;
  return 1;
}

/**
 * How many dice a spell's damage modifier rolls at this character level.
 *
 * Most cantrips scale by multiplying a single die (`scaleType:
 * "characterlevel"`). A few — True Strike among them — instead spell out an
 * absolute count for each tier on the modifier itself, and leave the base count
 * at zero because the base damage comes from somewhere else entirely (a weapon,
 * in True Strike's case). Where that table exists it wins: multiplying a base of
 * zero gives zero dice no matter how high the level goes.
 */
function scaledDiceCount(m, d, level) {
  const tiers = (m.atHigherLevels?.higherLevelDefinitions || []).filter((t) => t.dice && t.level);
  if (d.level === 0 && tiers.length) {
    const reached = tiers.filter((t) => level >= t.level).sort((a, b) => b.level - a.level)[0];
    return reached ? reached.dice.diceCount : m.die.diceCount || 0;
  }
  const scale = d.level === 0 && d.scaleType === "characterlevel" ? cantripMultiplier(level) : 1;
  return (m.die.diceCount || 1) * scale;
}

/**
 * Pull rollable dice out of a spell's modifiers and rules text.
 *
 * `abilityMod` is the caster's spellcasting modifier. D&D Beyond marks the
 * damage rolls that add it with `usePrimaryStat`, which is how spells like True
 * Strike and Produce Flame get their "+ your spellcasting ability modifier"
 * without saying so in any machine-readable field.
 */
function spellDice(d, level, abilityMod = 0) {
  const out = { damage: [], healing: null, healingFlat: 0, upcast: null, variants: [] };
  const scale = d.level === 0 && d.scaleType === "characterlevel" ? cantripMultiplier(level) : 1;

  for (const m of d.modifiers || []) {
    if (!m.die?.diceString) continue;
    const count = scaledDiceCount(m, d, level);

    if (m.type === "damage") {
      const usesAbility = Boolean(m.usePrimaryStat);
      const flat = (m.die.fixedValue || 0) + (usesAbility ? abilityMod : 0);
      if (!count && !flat) continue;
      out.damage.push({
        type: m.subType,
        count,
        sides: m.die.diceValue,
        flat,
        usesAbility,
        roll: count ? `${count}d${m.die.diceValue}${flat ? signed(flat) : ""}` : String(flat),
      });
    } else if (m.type === "bonus" && m.subType === "hit-points") {
      // Healing carries the caster's modifier exactly the way damage does —
      // "regains Hit Points equal to 2d4 plus your spellcasting ability
      // modifier" is `usePrimaryStat`, never written into the dice string. Read
      // only the dice and Healing Word heals 2d4 for a +3 Wisdom cleric.
      const flat = (m.die.fixedValue || 0) + (m.usePrimaryStat ? abilityMod : 0);
      out.healingFlat = flat;
      out.healing = `${count}d${m.die.diceValue}${flat ? signed(flat) : ""}`;
    }
  }

  const text = stripHtml(d.description).replace(/\s+/g, " ");

  const up = UPCAST_RE.exec(text);
  if (up) {
    out.upcast = {
      kind: up[1].toLowerCase(),
      count: parseInt(up[2] || "1", 10),
      sides: parseInt(up[3], 10),
      above: parseInt(up[4], 10),
    };
  }

  const variant = VARIANT_RE.exec(text);
  if (variant) {
    const count = parseInt(variant[2] || "1", 10) * scale;
    out.variants.push({
      when: variant[1].trim(),
      count,
      sides: parseInt(variant[3], 10),
      roll: `${count}d${variant[3]}`,
    });
  }

  return out;
}

/**
 * Apply a higher-level slot to a spell's dice.
 * Returns { damage, healing } roll strings for the chosen slot level.
 */
function upcastRolls(spell, slotLevel) {
  const base = { damage: spell.damage?.[0]?.roll || null, healing: spell.healing || null };

  // The caster's modifier is added once, not once per die, so it survives every
  // upcast untouched. Both paths below rebuild the dice and re-attach it.
  const heal = (dice) => `${dice}${spell.healingFlat ? signed(spell.healingFlat) : ""}`;

  // A spell filled in from the bundled SRD carries the resolved dice for every
  // slot level, which beats re-deriving a progression from prose.
  if (spell.upcastTable) {
    const at = spell.upcastTable[String(slotLevel)];
    if (!at) return base;
    return spell.healing ? { ...base, healing: heal(at) } : { ...base, damage: at };
  }

  const up = spell.upcast;
  if (!up || !slotLevel) return base;

  const steps = Math.max(0, slotLevel - up.above);
  if (!steps) return base;

  const extra = up.count * steps;

  if (up.kind === "healing" && spell.healing) {
    // Anchored on the dice alone: the stored string may carry the caster's
    // modifier ("2d4+3"), which `heal` puts back after the dice are rebuilt.
    const m = /^(\d+)d(\d+)/.exec(spell.healing);
    if (m) return { ...base, healing: heal(`${parseInt(m[1], 10) + extra}d${m[2]}`) };
  }

  if (up.kind === "damage" && spell.damage?.length) {
    const d = spell.damage[0];
    return { ...base, damage: `${d.count + extra}d${d.sides}${d.flat ? signed(d.flat) : ""}` };
  }

  return base;
}

/**
 * D&D Beyond's `resetType`, as words. Uses attach to both actions and spells —
 * Magic Initiate's free cast is a `limitedUse` on the spell itself — so the map
 * and the maximum are shared rather than spelled out twice.
 */
const USE_RESET = { 1: "short rest", 2: "long rest", 3: "dawn", 4: "special" };

/**
 * The use budget on a payload entry, or null when it has none.
 *
 * `maxUses` is 0 for anything whose budget *is* the proficiency bonus, so the
 * real maximum has to be worked out before asking whether there is one.
 */
function limitedUseOf(entry, pb) {
  const lu = entry?.limitedUse;
  if (!lu) return null;
  const max = (lu.maxUses || 0) + (lu.useProficiencyBonus ? pb : 0);
  if (max <= 0) return null;
  const used = lu.numberUsed || 0;
  return { max, used, remaining: max - used, resetsOn: USE_RESET[lu.resetType] || "unknown" };
}

function normalizeSpell(s, level, abilityMod = 0, pb = 0) {
  const d = s.definition || {};
  const dice = spellDice(d, level, abilityMod);
  return {
    damage: dice.damage,
    healing: dice.healing,
    healingFlat: dice.healingFlat,
    upcast: dice.upcast,
    variants: dice.variants,
    canUpcast: Boolean(d.canCastAtHigherLevel) && d.level > 0,
    name: d.name,
    level: d.level,
    school: d.school,
    prepared: s.prepared ?? null,
    alwaysPrepared: s.alwaysPrepared ?? false,
    ritual: d.ritual,
    concentration: d.concentration,
    castingTime: d.activation
      ? `${d.activation.activationTime || ""} ${activationLabel(d.activation.activationType)}`.trim()
      : null,
    range: d.range?.origin === "Ranged" ? `${d.range.rangeValue} ft.` : d.range?.origin,
    aoe: d.range?.aoeType ? `${d.range.aoeValue} ft. ${d.range.aoeType}` : null,
    duration: d.duration
      ? `${d.duration.durationType === "Concentration" ? "Concentration, " : ""}${
          d.duration.durationInterval || ""
        } ${d.duration.durationUnit || ""}`.trim()
      : null,
    components: (d.components || []).map((c) => ({ 1: "V", 2: "S", 3: "M" }[c])).join(", "),
    materials: d.componentsDescription || null,
    requiresAttackRoll: d.requiresAttackRoll,
    requiresSavingThrow: d.requiresSavingThrow,
    saveAbility: ABILITIES.find((a) => a.id === d.saveDcAbilityId)?.name || null,
    description: stripHtml(d.description),
    higherLevels: stripHtml(d.atHigherLevels?.higherLevelDefinitions?.[0]?.details),

    // A spell that comes with its own uses: Magic Initiate grants Goodberry with
    // one free cast per long rest, which the payload states here and nowhere
    // else. Dropping it left the spell looking like any other — castable only by
    // spending a slot it doesn't need.
    limitedUse: limitedUseOf(s, pb),
    // False for feat, species and item spells, which are cast without a slot.
    // Absent on class spells, which always need one.
    usesSpellSlot: s.usesSpellSlot !== false,
  };
}

const activationLabel = (t) =>
  ({ 1: "action", 2: "no action", 3: "bonus action", 4: "reaction", 6: "minute", 7: "hour" }[t] || "");

function attacks(data, scores, mods, pb) {
  const out = [];

  for (const item of data.inventory || []) {
    const d = item.definition;
    if (d?.filterType !== "Weapon") continue;

    const props = (d.properties || []).map((p) => p.name);
    const ranged = d.attackType === 2 || props.includes("Ammunition");
    const finesse = props.includes("Finesse");
    const useDex = ranged || (finesse && scores.dex.mod > scores.str.mod);
    const abilityMod = useDex ? scores.dex.mod : scores.str.mod;

    // Proficiency comes from category (simple/martial) or the specific weapon.
    const category = d.type?.toLowerCase().includes("martial") ? "martial-weapons" : "simple-weapons";
    const proficient =
      has(mods, "proficiency", category) ||
      has(mods, "proficiency", d.name?.toLowerCase().replace(/\s+/g, "-"));

    const magic = d.magic ? d.bonusModifiers?.reduce((t, m) => t + (m.value || 0), 0) || 0 : 0;
    const toHit = abilityMod + (proficient ? pb : 0) + magic;
    const dmgDice = d.damage?.diceString || "—";

    out.push({
      name: d.name,
      equipped: item.equipped,
      kind: ranged ? "ranged" : "melee",
      range: d.range ? `${d.range}${d.longRange ? `/${d.longRange}` : ""} ft.` : null,
      properties: props,
      proficient,
      toHit,
      // The roll string TS.dice.makeRollDescriptors() will be handed.
      attackRoll: `d20${signed(toHit)}`,
      damageRoll: `${dmgDice}${abilityMod + magic ? signed(abilityMod + magic) : ""}`,
      damageType: d.damageType,
      // Kept separately so an effect can rebuild the attack with a different
      // ability or damage die — Shillelagh replaces both rather than adding to
      // them, which a flat bonus can't express.
      ability: useDex ? "dex" : "str",
      abilityMod,
      magicBonus: magic,
      damageDice: dmgDice,
    });
  }

  return out;
}

/**
 * Resolve the template tokens D&D Beyond leaves in rules text.
 *
 *   "DC {{savedc:wis}} Con. saving throw"      -> "DC 13 Con. saving throw"
 *   "{{1+(classlevel/7)@rounddown}}d8{{modifier:wis}}" -> "1d8+3"
 *
 * Anything this doesn't understand is left in place rather than blanked, so an
 * unresolved token reads as "the panel didn't work this out" instead of silently
 * showing a wrong number.
 */
function resolveTemplates(text, ctx) {
  if (!text) return "";

  return text.replace(/\{\{([^}]+)\}\}/g, (whole, body) => {
    const { expr, sign, clamps } = tokenParts(body);

    // How the number reads when the token doesn't say: an ability modifier is a
    // bonus and carries its sign, everything else is a plain count.
    let value = null;
    let defaultSign = "plain";

    const save = /^savedc:(\w+)$/i.exec(expr);
    const modifier = /^modifier:(\w+)$/i.exec(expr);

    // "You can use this class's Channel Divinity {{scalevalue}} times per Long
    // Rest" — for an action with a use budget, that budget *is* the scale value.
    // Anywhere else it means something the payload doesn't say, and is left be.
    if (/^scalevalue$/i.test(expr)) {
      if (ctx.scaleValue == null) return whole;
      value = ctx.scaleValue;
    } else if (save) {
      const mod = ctx.abilities[save[1].toLowerCase()]?.mod;
      if (mod === undefined) return whole;
      value = 8 + ctx.pb + mod;
    } else if (modifier) {
      const mod = ctx.abilities[modifier[1].toLowerCase()]?.mod;
      if (mod === undefined) return whole;
      value = mod;
      defaultSign = "signed";
    } else {
      // Scaling expressions: "1+(classlevel/7)@rounddown", "classlevel".
      value = evalScaling(expr, ctx.level);
      if (value === null) return whole;
    }

    for (const c of clamps) {
      const limit = evalScaling(c.expr, ctx.level);
      if (limit === null) continue;
      value = c.kind === "min" ? Math.max(value, limit) : Math.min(value, limit);
    }

    const how = sign || defaultSign;
    if (how === "signed") return signed(value);
    if (how === "unsigned") return String(Math.abs(value));
    return String(value);
  });
}

/**
 * Peel the decorations D&D Beyond stacks onto a template token.
 *
 *   "modifier:wis@min:1#unsigned" -> { expr: "modifier:wis", sign: "unsigned",
 *                                      clamps: [{ kind: "min", expr: "1" }] }
 *   "classlevel#signed"           -> { expr: "classlevel", sign: "signed" }
 *
 * Decoration can hang off any kind of token, and reading it as part of the token
 * sank the whole thing: Twilight Sanctuary's temporary hit points read
 * "1d6{{classlevel#signed}}" in the rules text and carried no rollable number,
 * and Eyes of Night showed "{{modifier:wis@min:1#unsigned}}" willing creatures.
 * The `,max:` spelling predates `@max:` and still turns up, so both are taken.
 */
function tokenParts(body) {
  let expr = String(body);
  let sign = null;
  const clamps = [];

  const hash = /#(signed|unsigned)\b/i.exec(expr);
  if (hash) {
    sign = hash[1].toLowerCase();
    expr = expr.slice(0, hash.index) + expr.slice(hash.index + hash[0].length);
  }

  // A clamp's value runs to the next clamp or the end of the token, because it
  // can be an expression in its own right, `@rounddown` and all:
  // "1+(classlevel/7)@rounddown,max:1+(classlevel/13)@rounddown+(classlevel/18)@rounddown".
  const MARK = /[@,](min|max):/i;
  let mark;
  while ((mark = MARK.exec(expr))) {
    const rest = expr.slice(mark.index + mark[0].length);
    const next = MARK.exec(rest);
    clamps.push({
      kind: mark[1].toLowerCase(),
      expr: (next ? rest.slice(0, next.index) : rest).trim(),
    });
    expr = expr.slice(0, mark.index) + (next ? rest.slice(next.index) : "");
  }

  return { expr: expr.trim(), sign, clamps };
}

/** Arithmetic over `classlevel` with D&D Beyond's `@rounddown` suffix. */
function evalScaling(expr, level) {
  const e = String(expr)
    .replace(/classlevel/gi, String(level))
    .replace(/\(([^()]+)\)@rounddown/gi, "Math.floor($1)")
    .replace(/\(([^()]+)\)@roundup/gi, "Math.ceil($1)");

  // Only arithmetic survives — this text comes out of a downloaded payload.
  const bare = e.replace(/Math\.(floor|ceil)/g, "");
  if (!/^[\d+\-*/().\s]*$/.test(bare)) return null;

  try {
    const result = Function(`"use strict"; return (${e});`)();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Actions and their limited uses (Channel Divinity 2/short rest, Second Wind,
 * Lay on Hands...) live outside `features` entirely, in `actions` keyed by source.
 *
 * D&D Beyond models a resource and its choices as separate sibling actions named
 * "Channel Divinity" and "Channel Divinity: Divine Spark", so children are matched
 * back to their parent by that prefix and offered as options on the parent.
 */
function actionsAndResources(data, scores, pb, level) {
  const ctx = { abilities: scores, pb, level };

  const flat = [];
  for (const [source, entries] of Object.entries(data.actions || {})) {
    for (const a of entries || []) flat.push({ ...a, source });
  }

  // Long enough for an option that states two alternatives — Twilight Sanctuary
  // spends its first 400 characters getting to the end of the first one.
  const useBudget = (a) => limitedUseOf(a, pb)?.max ?? null;

  const describe = (a) =>
    resolveTemplates(stripHtml(a.snippet || a.description), { ...ctx, scaleValue: useBudget(a) }).slice(0, 600);

  /**
   * Dice stated only in the rules text.
   *
   * Some actions carry no `dice` object at all: Twilight Sanctuary's temporary hit
   * points live in its snippet as "1d6{{classlevel#signed}}" and nowhere else, so
   * it offered no roll to make. Read the first dice expression out of the resolved
   * text instead — by then the templates are numbers.
   *
   * d20 is skipped on purpose: in an action's prose a d20 is a check somebody is
   * being asked to make, not the action's own roll.
   */
  const SNIPPET_DICE = /(\d*)d(\d+)\s*([+-]\s*\d+)?/g;

  function snippetRoll(a) {
    const text = resolveTemplates(stripHtml(a.snippet || a.description), ctx);
    for (const m of text.matchAll(SNIPPET_DICE)) {
      if (parseInt(m[2], 10) === 20) continue;
      return `${m[1] || "1"}d${m[2]}${(m[3] || "").replace(/\s+/g, "")}`;
    }
    return null;
  }

  /** Roll string for an action: its dice plus the ability it keys off, if any. */
  function actionRoll(a) {
    const dice = a.dice?.diceString;
    if (!dice) return snippetRoll(a);
    const key = ABILITIES.find((ab) => ab.id === a.abilityModifierStatId)?.key;
    const mod = key ? scores[key].mod : 0;
    return `${dice}${mod ? signed(mod) : ""}`;
  }

  function saveInfo(a) {
    const saveName = ABILITIES.find((ab) => ab.id === a.saveStatId)?.name;
    if (!saveName) return null;
    const casterKey = ABILITIES.find((ab) => ab.id === a.abilityModifierStatId)?.key;
    const dc = a.fixedSaveDc ?? (casterKey ? 8 + pb + scores[casterKey].mod : null);
    return { ability: saveName, dc };
  }

  const toAction = (a) => ({
    name: a.name,
    source: a.source,
    activation: activationLabel(a.activation?.activationType),
    roll: actionRoll(a),
    save: saveInfo(a),
    description: describe(a),
  });

  const children = new Map(); // parent name -> options
  for (const a of flat) {
    const split = a.name.indexOf(": ");
    if (split > 0) {
      const parent = a.name.slice(0, split);
      const list = children.get(parent) || [];
      list.push({ ...toAction(a), name: a.name.slice(split + 2), fullName: a.name });
      children.set(parent, list);
    }
  }

  const resources = [];
  for (const a of flat) {
    const uses = limitedUseOf(a, pb);
    if (!uses) continue;

    resources.push({
      name: a.name,
      ...uses,
      description: describe(a),
      options: children.get(a.name) || [],
    });
  }

  // Actions with choices but no use budget.
  const resourceNames = new Set(resources.map((r) => r.name));
  const choiceActions = [];
  const claimed = new Set();

  for (const a of flat) {
    if (resourceNames.has(a.name) || a.name.includes(": ")) continue;
    const options = children.get(a.name);
    if (options?.length) {
      choiceActions.push({ ...toAction(a), options });
      claimed.add(a.name);
    }
  }

  // Some groups have no parent action at all: the options are named
  // "Circle Spell: Augment" while the action that triggers them is called
  // "Initiate a Circle Spell". Surface the group under its own prefix rather
  // than dropping every option on the floor.
  for (const [parent, options] of children) {
    if (claimed.has(parent) || resourceNames.has(parent)) continue;
    choiceActions.push({
      name: parent,
      source: options[0]?.source,
      activation: null,
      roll: null,
      save: null,
      description: "",
      options,
    });
  }

  return { actions: flat.map(toAction), resources, choiceActions };
}

/**
 * Spells a feature says you have that the export never included.
 *
 * Only the names are knowable from the payload; the panel fills in the rest
 * from the bundled SRD at render time. Anything already in `classSpells` or
 * `spells` is skipped, so a subclass whose grants D&D Beyond *does* export
 * produces nothing here.
 */
function grantedSpells(data) {
  const key = (n) => String(n || "").toLowerCase().replace(/[\u2019']/g, "'").replace(/\s+/g, " ").trim();

  const known = new Set();
  for (const cs of data.classSpells || []) for (const sp of cs.spells || []) known.add(key(sp.definition?.name));
  for (const list of Object.values(data.spells || {})) for (const sp of list || []) known.add(key(sp.definition?.name));

  const out = [];
  const seen = new Set();
  for (const cls of data.classes || []) {
    const sources = [
      [cls.definition, cls.definition?.name],
      [cls.subclassDefinition, cls.subclassDefinition?.name || cls.definition?.name],
    ];
    for (const [def, source] of sources) {
      for (const f of def?.classFeatures || []) {
        for (const row of spellTableOf(f) || []) {
          if (row.level > cls.level) continue;
          for (const name of row.names) {
            const k = key(name);
            if (known.has(k) || seen.has(k)) continue;
            seen.add(k);
            out.push({ name, atLevel: row.level, source, className: cls.definition?.name, feature: f.name });
          }
        }
      }
    }
  }
  return out;
}

function features(data) {
  const out = [];
  for (const cls of data.classes || []) {
    // Subclass features live only on `subclassDefinition`, and reading just the
    // parent class meant a Twilight Domain cleric saw none of their domain
    // features at all. The subclass's list repeats the parent's features
    // alongside its own, so the two are merged by id rather than concatenated —
    // and an over-level feature is still marked seen, so the subclass copy of it
    // doesn't slip back in.
    const seen = new Set();
    const take = (list, source) => {
      for (const f of list || []) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        if ((f.requiredLevel || 1) > cls.level) continue;
        out.push({ name: f.name, source, level: f.requiredLevel });
      }
    };
    take(cls.definition?.classFeatures, cls.definition?.name);
    take(cls.subclassDefinition?.classFeatures, cls.subclassDefinition?.name || cls.definition?.name);
  }
  for (const f of data.feats || []) {
    out.push({ name: f.definition?.name, source: "Feat" });
  }
  for (const t of data.race?.racialTraits || []) {
    out.push({ name: t.definition?.name, source: data.race.fullName });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Stamped onto every sheet this normalizer produces.
 *
 * A sheet stores its computed values, not just its source, so a correction here
 * would otherwise sit unused until the player happened to re-import. The panel
 * compares this against the stamp on a stored sheet and re-derives when they
 * differ. Bump it whenever a change alters what normalize() returns.
 */
const NORMALIZER_VERSION = "0.12.0";

function normalize(payload, options = {}) {
  const data = applyEquipment(payload.data || payload, options.equipment);
  const mods = allModifiers(data);
  const level = totalLevel(data);
  const classLevels = componentClassLevels(data);
  const pb = proficiencyBonus(level);
  const scores = abilityScores(data, mods);
  const skillList = skills(scores, mods, pb);
  const hp = hitPoints(data, scores, level, mods, classLevels, componentNames(data));
  const ac = armorClass(data, scores, mods);

  return {
    meta: {
      source: "dndbeyond",
      sourceId: data.id,
      sourceUrl: data.readonlyUrl,
      fetchedAt: null, // stamped by the caller
      importerVersion: NORMALIZER_VERSION,
    },
    identity: {
      name: data.name,
      level,
      classes: (data.classes || []).map((c) => ({
        name: c.definition?.name,
        subclass: c.subclassDefinition?.name || null,
        level: c.level,
      })),
      species: data.race?.fullName,
      background: data.background?.definition?.name || null,
      avatarUrl: data.decorations?.avatarUrl || null,
      xp: data.currentXp,
    },
    proficiencyBonus: pb,
    abilities: scores,
    hp,
    ac,
    initiative: initiativeBonus(scores, mods, pb),
    speeds: speeds(data, mods),
    savingThrows: savingThrows(scores, mods, pb),
    skills: skillList,
    senses: senses(data, mods, skillList),
    attacks: attacks(data, scores, mods, pb),
    spellcasting: spellcasting(data, scores, pb, level),
    ...actionsAndResources(data, scores, pb, level),
    features: features(data),
    inventory: inventory(data),
    attunementLimit: ATTUNEMENT_LIMIT,
    currencies: data.currencies,
    conditions: (data.conditions || []).map((c) => ({
      name: CONDITIONS[c.id] || `Condition ${c.id}`,
      level: c.level,
    })),
    defenses: {
      resistances: mods.filter((m) => m.type === "resistance").map((m) => m.friendlySubtypeName),
      immunities: mods.filter((m) => m.type === "immunity").map((m) => m.friendlySubtypeName),
    },
    // What we can project onto a TaleSpire mini: 8 named stats + HP.
    talespireProjection: {
      hp: { current: hp.current, max: hp.max },
      stats: [
        { name: "AC", value: ac.value },
        { name: "Init", value: scores.dex.mod },
        { name: "PP", value: skillList.find((s) => s.key === "perception").passive },
        { name: "Speed", value: speeds(data, mods).walk || 30 },
        { name: "Spell DC", value: spellcasting(data, scores, pb, level).blocks[0]?.saveDc ?? 0 },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Exports — CommonJS for the Node CLI, a global for the Symbiote's classic script.
// ---------------------------------------------------------------------------

if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalize, compactPayload, ATTUNEMENT_LIMIT, NORMALIZER_VERSION, conditionHelp, signed, stripHtml, upcastRolls };
} else if (typeof window !== "undefined") {
  window.DDB = { normalize, compactPayload, ATTUNEMENT_LIMIT, NORMALIZER_VERSION, conditionHelp, signed, stripHtml, upcastRolls };
}
