/**
 * Reading rolls off a D&D Beyond character sheet.
 *
 * This is the fragile half of the extension and it is worth being honest about
 * why. D&D Beyond does not publish a roll API; the sheet is a React app whose
 * buttons carry no roll data at all — a skill button's entire content is the
 * string "+2". The meaning has to be reconstructed from where the button sits.
 *
 * What makes that survivable is picking the right hooks. Three kinds of class
 * name appear on these elements:
 *
 *   integrated-dice__container   stable, and the same name DDB has used for years
 *   ct-* / ddbc-*                stable component names from DDB's own library
 *   F8U5pq_button                a build hash, different on every deploy
 *
 * So: find buttons by `integrated-dice__container`, classify them by their
 * nearest `ct-` or `ddbc-` ancestor, and never match on anything hashed. When
 * D&D Beyond restyles, the hashes churn and this keeps working; when they
 * rename a component, one entry in SHAPES needs updating and `probe()` says
 * which.
 */
const Rolls = (() => {
  const HOOK = ".integrated-dice__container";

  /**
   * How to read each kind of rollable.
   *
   * `at` is the stable ancestor that identifies the roll; `label` finds the
   * human-readable name within it. Order matters — the first match wins, so
   * the more specific selectors come first.
   */
  const SHAPES = [
    { kind: "attack", at: ".ddbc-combat-item-attack", label: ".ddbc-combat-item-attack__label" },
    { kind: "attack", at: ".ddbc-combat-attack", label: ".ddbc-combat-attack__label" },
    { kind: "save", at: ".ddbc-saving-throws-summary__ability", label: ".ddbc-saving-throws-summary__ability-name" },
    { kind: "ability", at: ".ddbc-ability-summary", label: ".ddbc-ability-summary__label" },
    { kind: "skill", at: ".ct-skills__item", label: ".ct-skills__col--skill" },
    { kind: "initiative", at: ".ct-combat__summary-group--initiative", label: null, name: "Initiative" },
  ];

  /** "+2", "−1" (DDB uses a real minus sign), "5" -> a number. */
  function modifierOf(el) {
    const text = (el.textContent || "").trim().replace(/[−–—]/g, "-");
    const m = /^([+-]?\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Dice notation as printed, e.g. "1d8 + 3" on a damage button. */
  function diceOf(el) {
    const text = (el.textContent || "").trim().replace(/[−–—]/g, "-").replace(/\s+/g, "");
    return /^\d*d\d+([+-]\d+)?$/i.test(text) ? text : null;
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  /**
   * Describe one rollable button, or null if it is not one we understand.
   *
   * Returning null rather than guessing matters: a wrong label on a roll is
   * worse than no button, because it lands in someone's game as a real result.
   */
  function describe(el) {
    const dice = diceOf(el);
    const mod = modifierOf(el);
    if (dice === null && mod === null) return null;

    // Find the nearest shape that recognises this button, for its label.
    let shape = null;
    let host = null;
    for (const candidate of SHAPES) {
      const found = el.closest(candidate.at);
      if (found) {
        shape = candidate;
        host = found;
        break;
      }
    }

    // A button that prints dice is a damage button wherever it sits. Deciding
    // that from the text rather than the container matters: damage buttons live
    // *inside* attack rows, so container-first classification calls them
    // attacks — and "Club attack 1d4+2" is a wrong result, not just a wrong
    // label, because a d20 roll and a damage roll are not interchangeable.
    if (dice !== null) {
      const labelEl = shape?.label ? host.querySelector(shape.label) : null;
      const name = clean(labelEl?.textContent) || null;
      return { kind: "damage", name, roll: dice, isDamage: true };
    }

    if (!shape) return null;

    const labelEl = shape.label ? host.querySelector(shape.label) : null;
    const name = shape.name || clean(labelEl?.textContent) || clean(host.getAttribute("aria-label")) || null;

    return {
      kind: shape.kind,
      name,
      roll: `1d20${mod >= 0 ? "+" : ""}${mod}`,
      isDamage: false,
    };
  }

  /** Every rollable on the page that we can describe. */
  function all(root = document) {
    return [...root.querySelectorAll(HOOK)]
      .map((el) => ({ el, roll: describe(el) }))
      .filter((r) => r.roll);
  }

  /**
   * Coverage report, for when D&D Beyond changes something.
   *
   * Run it in the console on a character sheet: if `unmatched` climbs, a
   * selector in SHAPES has gone stale, and the sample says which part of the
   * sheet stopped being understood.
   */
  function probe(root = document) {
    const found = [...root.querySelectorAll(HOOK)];
    const described = found.map((el) => ({ el, roll: describe(el) }));
    const unmatched = described.filter((d) => !d.roll);
    const byKind = {};
    for (const d of described) {
      if (!d.roll) continue;
      byKind[d.roll.kind] = (byKind[d.roll.kind] || 0) + 1;
    }
    return {
      total: found.length,
      matched: found.length - unmatched.length,
      byKind,
      unmatched: unmatched.slice(0, 5).map((d) => ({
        text: clean(d.el.textContent).slice(0, 20),
        parent: String(d.el.parentElement?.className || "").slice(0, 60),
      })),
    };
  }

  return { HOOK, SHAPES, describe, all, probe, modifierOf, diceOf };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Rolls;
if (typeof window !== "undefined") window.SpirekeeperRolls = Rolls;
