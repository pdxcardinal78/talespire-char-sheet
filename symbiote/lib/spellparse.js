/**
 * Reading a pasted spell.
 *
 * A spell the bundled SRD doesn't have is filled in by hand, and the quickest
 * way to fill it in is to paste its text from D&D Beyond or the book. This
 * picks out what the form needs and leaves the rest as the description. It
 * understands three layouts:
 *
 *   D&D Beyond's spell page, label then value:  "Casting Time\n1 Action"
 *   The 2024 book:   "Level 3 Evocation (Cleric)" then "Casting Time: Action"
 *   The 2014 book:   "3rd-level evocation" then "Casting Time: 1 action"
 *
 * It only suggests. Everything it finds lands in a form the person checks.
 * The result uses the bundled spells' field names (Open5e's), so a filled-in
 * spell goes through the same code as an SRD one.
 */

const SpellParse = (() => {
  const ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
  const ABBR = { str: "strength", dex: "dexterity", con: "constitution", int: "intelligence", wis: "wisdom", cha: "charisma" };
  const TYPES = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
  const SCHOOLS = ["abjuration", "conjuration", "divination", "enchantment", "evocation", "illusion", "necromancy", "transmutation"];
  const SHAPES = ["sphere", "cube", "cone", "line", "cylinder", "emanation", "radius"];

  const LABELS = {
    level: /^level$/i,
    castingTime: /^casting\s*time$/i,
    range: /^range(?:\s*\/\s*area)?$/i,
    components: /^components?$/i,
    duration: /^duration$/i,
    school: /^school$/i,
    attackSave: /^attack\s*\/\s*save$/i,
    damageEffect: /^damage\s*\/\s*effect$/i,
  };

  const ordinal = (t) => {
    const m = /(\d)/.exec(String(t));
    return m ? Number(m[1]) : null;
  };
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  /**
   * Pull "Label: value" and "Label\nvalue" lines into fields; return them and
   * the lines left over (the description).
   */
  function fields(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n").map((l) => l.trim());
    const out = {};
    const rest = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) {
        rest.push("");
        continue;
      }
      const colon = /^([A-Za-z /]+?)\s*:\s*(.+)$/.exec(line);
      const label = colon ? colon[1] : line;
      const which = Object.keys(LABELS).find((k) => LABELS[k].test(label.trim()));
      if (which && colon) {
        out[which] = colon[2].trim();
        continue;
      }
      // D&D Beyond: the label alone on its line, the value on the next
      if (which && !colon && lines[i + 1]) {
        out[which] = lines[i + 1].trim();
        i += 1;
        continue;
      }
      rest.push(line);
    }
    return { out, rest };
  }

  /** "3rd-level evocation", "Level 3 Evocation (Cleric)", "Evocation cantrip". */
  function levelAndSchool(lines, labelled) {
    let level = null;
    let school = null;
    if (labelled.level) level = /cantrip/i.test(labelled.level) ? 0 : ordinal(labelled.level);
    if (labelled.school) school = SCHOOLS.find((s) => labelled.school.toLowerCase().includes(s)) || null;
    for (const line of lines.slice(0, 4)) {
      const l = line.toLowerCase();
      if (level == null) {
        let m = /(\d)(?:st|nd|rd|th)[- ]level/.exec(l) || /^level\s+(\d)\b/.exec(l);
        if (m) level = Number(m[1]);
        else if (/\bcantrip\b/.test(l)) level = 0;
      }
      if (!school) school = SCHOOLS.find((s) => new RegExp(`\\b${s}\\b`).test(l)) || null;
    }
    return { level, school: school ? cap(school) : null };
  }

  /** The heading lines that only said level and school, so they stay out of the description. */
  const isHeading = (line) =>
    /^(\d(?:st|nd|rd|th)[- ]level\b|level\s+\d\b|\w+\s+cantrip\b)/i.test(line) && line.length < 80;

  function parse(text, { name = null } = {}) {
    const { out: L, rest } = fields(text);
    let lines = rest.filter((l, i) => !(i === 0 && name && l.toLowerCase() === String(name).toLowerCase()));
    const { level, school } = levelAndSchool(lines, L);
    lines = lines.filter((l) => !isHeading(l));
    const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const all = `${body}\n${L.range || ""}\n${L.duration || ""}`;

    // Higher levels: "At Higher Levels." (2014) or "Using a Higher-Level Spell Slot." (2024)
    const hl = /(?:at higher levels|using a higher[- ]level spell slot|cantrip upgrade)\.?\s*(.+)$/is.exec(body);
    const higher = hl ? hl[1].trim() : "";
    const desc = hl ? body.slice(0, hl.index).trim() : body;

    const rec = { level, school };

    if (L.castingTime) {
      const ct = L.castingTime.toLowerCase().replace(/\s+/g, " ").trim();
      // The 2024 book writes a bare "Action"
      rec.casting_time = /^(action|bonus action|reaction)\b/.test(ct) ? `1 ${ct}` : ct;
    }
    if (L.range) rec.range_text = L.range;
    if (L.components) {
      rec.components_text = L.components.replace(/\s*\*\s*-?\s*\(.*$/, "").trim();
      const mat = /\(([^)]+)\)/.exec(L.components);
      if (mat) rec.material_specified = mat[1];
    }
    if (L.duration) {
      rec.concentration = /concentration/i.test(L.duration);
      rec.duration = L.duration.replace(/^concentration,?\s*(up to\s*)?/i, "").trim();
      rec.duration = rec.duration ? cap(rec.duration.toLowerCase()) : rec.duration;
    } else if (/\bconcentration\b/i.test(desc)) {
      rec.concentration = true;
    }
    if (/\britual\b/i.test(`${L.castingTime || ""} ${(lines[0] || "")} ${L.level || ""}`)) rec.ritual = true;

    // How it lands
    const save = /\b(strength|dexterity|constitution|intelligence|wisdom|charisma)\s+saving throw/i.exec(desc)
      || /\b(str|dex|con|int|wis|cha)\s+save\b/i.exec(L.attackSave || "");
    if (save) rec.saving_throw_ability = ABBR[save[1].toLowerCase()] || save[1].toLowerCase();
    if (/\b(ranged|melee) spell attack\b/i.test(desc) || /\b(ranged|melee)\b/i.test(L.attackSave || "")) {
      if (!rec.saving_throw_ability) rec.attack_roll = true;
    }

    // Healing or damage, the first dice the text gives
    const heal = /regains?\s+(?:a number of\s+)?hit points?\s+(?:equal to\s+)?(\d+d\d+)/i.exec(desc)
      || /(\d+d\d+)[^.]{0,40}\bhit points\b/i.exec(desc);
    const dmg = new RegExp(`(\\d+d\\d+)(?:\\s*\\+\\s*\\d+)?\\)?\\s+(${TYPES.join("|")})\\s+damage`, "i").exec(desc)
      || new RegExp(`(\\d+d\\d+)[^.]{0,30}?\\b(${TYPES.join("|")})\\b`, "i").exec(desc);
    if (dmg && (!heal || dmg.index <= heal.index || /healing/i.test(L.damageEffect || "") === false)) {
      rec.damage_roll = dmg[1].toLowerCase();
      rec.damage_types = [dmg[2].toLowerCase()];
    } else if (heal) {
      rec.damage_roll = heal[1].toLowerCase();
      rec.damage_types = [];
      if (/plus your spellcasting ability modifier/i.test(desc)) rec.adds_mod = true;
    }
    if (rec.damage_types?.length === 0 && /healing/i.test(L.damageEffect || "") === false && !heal) delete rec.damage_types;

    // Area: "30-foot radius", "15-foot cone", "Self (30 ft.)", "20-foot-radius sphere"
    const area = /(\d+)[- ](?:foot|feet|ft\.?)[- ](?:radius[- ])?(sphere|cube|cone|line|cylinder|emanation|radius)\b/i.exec(all)
      || /\((\d+)[- ]?(?:foot|feet|ft\.?)\s*(sphere|cube|cone|line|cylinder|emanation|radius)?\)/i.exec(L.range || "");
    if (area) {
      rec.shape_size = Number(area[1]);
      const shape = (area[2] || "radius").toLowerCase();
      rec.shape_type = shape === "radius" || shape === "emanation" ? "sphere" : shape;
      rec.shape_size_unit = "feet";
    }

    // Upcast: "increases by 1d6 for each slot level above 2nd"
    if (higher) rec.higher_level = higher;
    const up = /(?:increases?|by)\s+(?:by\s+)?(\d+d\d+)\s+for each (?:spell )?slot level above\s+(\d)/i.exec(higher);
    if (up) rec.upcast_step = up[1].toLowerCase();

    rec.desc = desc;
    for (const k of Object.keys(rec)) if (rec[k] == null || rec[k] === "") delete rec[k];
    return rec;
  }

  /**
   * The per-level dice table the sheet upcasts from, built from the base dice
   * and the step: 2d6 with +1d6 per level from 3rd is { 4: "3d6", 5: "4d6", ... }.
   */
  function upcastTable(level, baseRoll, stepRoll) {
    const b = /^(\d+)d(\d+)$/i.exec(String(baseRoll || "").trim());
    const s = /^(\d+)d(\d+)$/i.exec(String(stepRoll || "").trim());
    if (!b || !s || !(level > 0) || b[2] !== s[2]) return null;
    const table = {};
    for (let l = level + 1; l <= 9; l += 1) table[l] = `${Number(b[1]) + Number(s[1]) * (l - level)}d${b[2]}`;
    return table;
  }

  return { parse, upcastTable, ABILITIES, TYPES, SCHOOLS, SHAPES };
})();

if (typeof window !== "undefined") window.SpellParse = SpellParse;
if (typeof module !== "undefined" && module.exports) module.exports = SpellParse;
