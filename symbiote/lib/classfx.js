/**
 * Class resources: what a hit can add, point pools, and feature options that
 * place an area or run for a while.
 *
 * On a hit, the damage card offers riders. They're offered, never applied for
 * you, except the ones the rules make automatic:
 *
 *  - Smite spells you have (Divine Smite, Searing Smite, Shining Smite...):
 *    melee weapon hits only, cast at a slot level you pick, the slot spent
 *    when the damage is rolled.
 *  - Hunter's Mark and Hex while you're concentrating on them: ticked, since
 *    the mark is on whoever you're hitting more often than not.
 *  - Sneak Attack: once per turn, ceil(rogue level / 2) d6. Whether you have
 *    advantage or an ally beside the target is yours to say.
 *  - Radiant Strikes (2024) / Improved Divine Smite (2014): +1d8 Radiant on
 *    every melee weapon hit, ticked.
 *
 * A crit doubles rider dice along with the weapon's, as the rules say.
 */

const ClassFx = (() => {
  const SMITE = /smite/i;
  // Spells that add damage to every hit while they run
  const MARKS = /^(hunter'?s mark|hex)$/i;
  const ALWAYS_RADIANT = /^(radiant strikes|improved divine smite)$/i;

  const levelIn = (identity, cls) =>
    (identity?.classes || []).filter((c) => new RegExp(`^${cls}$`, "i").test(c.name)).reduce((t, c) => t + (c.level || 0), 0);

  const hasFeature = (features, re) => (features || []).some((f) => re.test(f.name || ""));

  /**
   * Riders for one hit.
   *   spells: every spell on the sheet (with damage[0].roll and level)
   *   ctx: { melee, weapon, spellAttack, concentration, sneakUsed, slotLevels:[{level,left,kind}] }
   *   upcast(spell, level) -> damage dice at that level
   */
  function ridersFor({ spells = [], features = [], identity = null }, ctx, upcast) {
    const out = [];
    const weaponMelee = ctx.weapon && ctx.melee;

    if (weaponMelee) {
      for (const sp of spells) {
        if (!SMITE.test(sp.name || "") || !(sp.level > 0)) continue;
        const levels = (ctx.slotLevels || []).filter((o) => o.level >= sp.level);
        if (!levels.length) continue;
        const first = levels.find((o) => o.left > 0) || levels[0];
        out.push({
          key: `smite:${sp.name}`,
          kind: "smite",
          name: sp.name,
          spell: sp,
          levels,
          level: first.level,
          slotKind: first.kind,
          dice: upcast(sp, first.level) || sp.damage?.[0]?.roll || null,
          on: false,
          note: String(sp.damage?.[0]?.type || "").toLowerCase(),
        });
      }
    }

    // A mark you're concentrating on adds to weapon hits (Hunter's Mark) or any attack (Hex)
    const conc = ctx.concentration || "";
    if (MARKS.test(conc) && (ctx.weapon || ctx.spellAttack)) {
      const sp = spells.find((s) => (s.name || "").toLowerCase() === conc.toLowerCase());
      const isHex = /^hex$/i.test(conc);
      if (isHex || ctx.weapon) {
        out.push({
          key: `mark:${conc}`,
          kind: "mark",
          name: sp?.name || conc,
          dice: sp?.damage?.[0]?.roll || "1d6",
          on: true,
          note: isHex ? "necrotic" : "force",
        });
      }
    }

    // Sneak Attack: a finesse or ranged weapon, once per turn
    if (ctx.weapon && (ctx.finesse || !ctx.melee) && hasFeature(features, /^sneak attack$/i)) {
      const rogue = levelIn(identity, "rogue");
      if (rogue > 0) {
        out.push({
          key: "sneak",
          kind: "sneak",
          name: "Sneak Attack",
          dice: `${Math.ceil(rogue / 2)}d6`,
          on: false,
          disabled: Boolean(ctx.sneakUsed),
          note: ctx.sneakUsed ? "used this turn" : "once per turn",
        });
      }
    }

    if (weaponMelee && hasFeature(features, ALWAYS_RADIANT)) {
      out.push({ key: "radiant", kind: "always", name: "Radiant Strikes", dice: "1d8", on: true, note: "radiant" });
    }
    return out;
  }

  /** The damage expression with the ticked riders' dice added on. */
  function withRiders(damage, riders) {
    const extra = riders.filter((r) => r.on && !r.disabled && r.dice).map((r) => r.dice);
    return [damage, ...extra].filter(Boolean).join("+");
  }

  // --- point pools -----------------------------------------------------------

  /**
   * A pool is spent in amounts, not uses: Lay on Hands, Sorcery Points, Focus
   * Points. Anything with more than eight uses is treated as one, since pips
   * stop being readable there.
   */
  const isPool = (r) => (r?.max || 0) > 8 || /lay on hands|points?$/i.test(r?.name || "");
  const poolHeals = (r) => /lay on hands/i.test(r?.name || "");

  // --- feature options: areas and durations --------------------------------

  /**
   * The area a feature option covers, for the Zone button. Spell wording first
   * ("30-foot Emanation"); then a feature's "each creature within 30 ft. of
   * you", which for a feature means an area around you. Spells aren't read
   * this way: "a creature within 60 feet of you" is their range, not an area.
   */
  function areaOf(option, spellArea) {
    const text = [option?.description, option?.desc].filter(Boolean).join(" ");
    const fromSpellWords = spellArea ? spellArea({ name: option?.name, description: text }) : null;
    if (fromSpellWords) return fromSpellWords;
    const m = /\b(?:each|every|all)\b[^.]{0,60}?\bwithin (\d+)\s*(?:ft\.?|feet|foot) of you\b/i.exec(text);
    return m ? { shape: "sphere", size: parseInt(m[1], 10) } : null;
  }

  /**
   * How long a feature option runs, as a Turns.LASTS key, or "" when it has no
   * duration of its own (an instant, or one that ends on a condition).
   */
  function lastsOf(option) {
    const text = String(option?.description || "");
    if (/until the start of your next turn/i.test(text)) return "start1";
    if (/until the end of your next turn/i.test(text)) return "end1";
    // "for 1 minute", "lasts for 1 minute", "Duration: 1 minute"
    if (/\b(?:for|lasts?(?: for)?|duration:?)\s+(?:1|one) minute\b/i.test(text)) return "r10";
    if (/\b(?:for|lasts?(?: for)?|duration:?)\s+(?:10|ten) minutes\b/i.test(text)) return "r100";
    return "";
  }

  /**
   * Something an effect does again every turn, read from its text:
   *   "Whenever any creature ... ends its turn in the sphere ... Temporary Hit
   *    Points equal to 1d6 plus your Cleric level"     (Twilight Sanctuary)
   *   "At the start of each of your turns ..."         (your own turns only)
   * Returns { at, whose: "any" | "own", roll, benefit: "temp"|"healing"|"damage", label }
   * or null. `ctx.levelOf(className)` and `ctx.spellMod` resolve "plus your
   * Cleric level" and "your spellcasting ability modifier".
   */
  function recurOf(subject, ctx = {}) {
    const text = String(subject?.description || "").replace(/\s+/g, " ");
    let at = null;
    let whose = null;
    let m = /whenever (?:any|a|each) creature\b[^.]*?\b(ends|starts) its turn/i.exec(text);
    if (m) {
      at = m[1].toLowerCase() === "ends" ? "end" : "start";
      whose = "any";
    } else if ((m = /at the (start|end) of each of your turns/i.exec(text))) {
      at = m[1].toLowerCase();
      whose = "own";
    }
    if (!at) return null;

    // The part after the trigger says what happens
    const rest = text.slice(m.index);
    let roll = null;
    const lvl = /(\d+d\d+)\s*(?:\+|plus)\s*your (\w+) level/i.exec(rest);
    if (lvl) {
      const n = ctx.levelOf ? ctx.levelOf(lvl[2]) : 0;
      roll = n ? `${lvl[1]}+${n}` : lvl[1];
    } else if (/equal to your spellcasting ability modifier/i.test(rest) && ctx.spellMod != null) {
      roll = String(Math.max(1, ctx.spellMod));
    } else {
      const dice = /(\d+d\d+(?:\s*\+\s*\d+)?)/.exec(rest);
      roll = dice ? dice[1].replace(/\s+/g, "") : null;
    }
    if (!roll) return null;

    const benefit = /temporary hit points/i.test(rest) ? "temp" : /\b(regains?|restores?|heals?)\b/i.test(rest) ? "healing" : "damage";
    return { at, whose, roll, benefit, label: benefit === "temp" ? "temp HP" : benefit };
  }

  return { ridersFor, withRiders, isPool, poolHeals, areaOf, lastsOf, recurOf };
})();

if (typeof window !== "undefined") window.ClassFx = ClassFx;
if (typeof module !== "undefined") module.exports = ClassFx;
