/**
 * Damage types and defenses.
 *
 * A damage roll keeps its types apart: the weapon's piercing and Divine
 * Smite's radiant are separate dice groups, named "Rapier damage [piercing]"
 * and "Divine Smite [radiant]", so whoever reads the result (this panel, or
 * the GM's reading someone else's dice) can tell them apart.
 *
 * Applying it, each type is adjusted on its own, then summed (2024 PHB):
 * resistance halves (rounded down), vulnerability doubles, immunity zeroes.
 * Defenses come from a monster's stat block or a player's sheet, as defaults
 * the GM can change per type before applying.
 */

const Damage = (() => {
  const TYPES = [
    "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
    "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
  ];
  const MODES = ["normal", "resist", "vuln", "immune"];

  const typeOf = (text) => {
    const t = String(text || "").toLowerCase();
    return TYPES.find((x) => t.includes(x)) || null;
  };

  /** "Rapier damage [piercing]" -> "piercing"; untyped groups give null. */
  const typeFromGroupName = (name) => {
    const m = /\[([a-z]+)\]\s*$/i.exec(String(name || ""));
    return m && TYPES.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
  };

  /** A group name carrying its type, for staging. */
  const groupName = (name, type) => (type && TYPES.includes(type) ? `${name} [${type}]` : name);

  /**
   * A stat block's defense text to the types it names. "bludgeoning,
   * piercing, and slashing from nonmagical attacks" lists all three: the
   * qualifier is the GM's to judge, so they're defaults, marked `qualified`.
   */
  function parseList(text) {
    const t = String(text || "").toLowerCase();
    if (!t.trim()) return { types: [], qualified: false };
    return {
      types: TYPES.filter((x) => new RegExp(`\\b${x}\\b`).test(t)),
      qualified: /nonmagical|silvered|adamantine|magical|except/.test(t),
    };
  }

  /**
   * Defenses as { resist: [], vuln: [], immune: [] }, from a monster's
   * { resistant, vulnerable, immune } strings or a sheet's
   * { resistances: [], immunities: [], vulnerabilities: [] } lists.
   */
  function defensesOf(src) {
    if (!src) return { resist: [], vuln: [], immune: [], qualified: false };
    if (Array.isArray(src.resistances) || Array.isArray(src.immunities)) {
      const lower = (l) => (l || []).map((x) => typeOf(x)).filter(Boolean);
      return { resist: lower(src.resistances), vuln: lower(src.vulnerabilities), immune: lower(src.immunities), qualified: false };
    }
    const r = parseList(src.resistant);
    const v = parseList(src.vulnerable);
    const i = parseList(src.immune);
    return { resist: r.types, vuln: v.types, immune: i.types, qualified: r.qualified || i.qualified };
  }

  const defaultMode = (type, def) =>
    !type || !def ? "normal" : def.immune.includes(type) ? "immune" : def.resist.includes(type) ? "resist" : def.vuln.includes(type) ? "vuln" : "normal";

  const adjust = (amount, mode) =>
    mode === "immune" ? 0 : mode === "resist" ? Math.floor(amount / 2) : mode === "vuln" ? amount * 2 : amount;

  /**
   * Parts by type, merged: [{ type, amount }] with untyped parts as type null.
   * `modes` (type -> mode) overrides the defaults from `def`.
   */
  function apply(parts, def, modes = {}) {
    const byType = new Map();
    for (const p of parts || []) {
      const k = p.type || null;
      byType.set(k, (byType.get(k) || 0) + (Number(p.amount) || 0));
    }
    const rows = [...byType.entries()].map(([type, amount]) => {
      const mode = modes[type ?? ""] || defaultMode(type, def);
      return { type, amount, mode, final: adjust(amount, mode) };
    });
    return { rows, total: rows.reduce((t, r) => t + r.final, 0) };
  }

  /** Compact defenses for sync messages: "r:fire,poison;i:psychic". */
  function pack(def) {
    if (!def) return "";
    return [["r", def.resist], ["v", def.vuln], ["i", def.immune]]
      .filter(([, l]) => l?.length)
      .map(([k, l]) => `${k}:${l.join(",")}`)
      .join(";");
  }
  function unpack(text) {
    const def = { resist: [], vuln: [], immune: [], qualified: false };
    for (const part of String(text || "").split(";")) {
      const [k, list] = part.split(":");
      const types = (list || "").split(",").filter((t) => TYPES.includes(t));
      if (k === "r") def.resist = types;
      if (k === "v") def.vuln = types;
      if (k === "i") def.immune = types;
    }
    return def;
  }

  return { TYPES, MODES, typeOf, typeFromGroupName, groupName, parseList, defensesOf, defaultMode, adjust, apply, pack, unpack };
})();

if (typeof window !== "undefined") window.Damage = Damage;
if (typeof module !== "undefined") module.exports = Damage;
