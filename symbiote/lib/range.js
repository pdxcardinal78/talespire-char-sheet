/**
 * Distance, reach and range between minis.
 *
 * Distance is counted the 5e grid way, diagonals as one square, from the edge
 * of one creature's space to the edge of the other's: two Medium creatures
 * side by side are 5 ft apart, and so is a Large one next to a Medium one.
 * Positions are TaleSpire world units (one per tile); `size` is a mini's
 * footprint in tiles (its scale).
 */

const Range = (() => {
  /** Feet between two creatures' spaces. a, b: { x, y, z, size } */
  function distanceFt(a, b, perTile = 5) {
    if (!a || !b) return null;
    const centre = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    const sa = Math.max(1, a.size || 1);
    const sb = Math.max(1, b.size || 1);
    const squares = Math.max(0, Math.round(centre - (sa + sb) / 2 + 1));
    return squares * perTile;
  }

  /**
   * What a weapon reaches: melee 5 ft (10 with Reach), ranged its normal and
   * long range ("80/320 ft."), thrown both.
   */
  function weaponReach(attack) {
    const props = attack?.properties || [];
    const m = /(\d+)\s*\/\s*(\d+)/.exec(String(attack?.range || ""));
    const ranged = m ? { normal: Number(m[1]), long: Number(m[2]) } : null;
    const melee = attack?.kind === "melee" ? (props.includes("Reach") ? 10 : 5) : null;
    // A plain "5/5 ft." is melee reach written as a range, not a ranged weapon
    const realRange = ranged && !(attack?.kind === "melee" && ranged.normal === ranged.long && ranged.normal <= 10) ? ranged : null;
    return { melee, ranged: realRange, thrown: props.includes("Thrown") };
  }

  /**
   * Whether an attack can land at this distance, and how:
   * { ok, disadvantage, text }. `enemyAdjacent` warns a ranged attack.
   */
  function attackAt(attack, distance, { enemyAdjacent = false } = {}) {
    if (distance == null) return null;
    const { melee, ranged } = weaponReach(attack);
    if (melee != null && distance <= melee) return { ok: true, disadvantage: false, text: `in reach (${melee} ft)` };
    if (ranged) {
      if (distance <= ranged.normal) {
        return enemyAdjacent
          ? { ok: true, disadvantage: true, text: "in range, but an enemy within 5 ft gives Disadvantage" }
          : { ok: true, disadvantage: false, text: `in range (${ranged.normal} ft)` };
      }
      if (distance <= ranged.long) return { ok: true, disadvantage: true, text: `long range: Disadvantage (${ranged.long} ft max)` };
      return { ok: false, disadvantage: false, text: `out of range (${ranged.long} ft max)` };
    }
    if (melee != null) return { ok: false, disadvantage: false, text: `out of reach (${melee} ft)` };
    return null;
  }

  /** A spell's range in feet from "60 ft.", "Touch" (5), "Self" (0), or null. */
  function spellRangeFt(range) {
    const t = String(range || "").toLowerCase();
    if (/touch/.test(t)) return 5;
    if (/^self/.test(t)) return 0;
    const m = /(\d+)\s*(?:ft|feet)/.exec(t);
    return m ? Number(m[1]) : null;
  }

  return { distanceFt, weaponReach, attackAt, spellRangeFt };
})();

if (typeof window !== "undefined") window.Range = Range;
if (typeof module !== "undefined") module.exports = Range;
