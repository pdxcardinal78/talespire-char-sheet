/**
 * Turns: who's up, and what that ends.
 *
 * TaleSpire's initiative queue says whose turn it is and nothing else, so this
 * watches the active entry change and turns each change into two boundaries:
 * the end of the previous creature's turn and the start of the next one's.
 * A move back to an earlier entry in the queue is a new round.
 *
 * Effect durations are counted in those boundaries, always on one creature's
 * turns (its owner: yours, or the caster's for a buff someone gave you):
 *
 *   { at: "start" | "end", of: creatureId | null, left: n }
 *
 * "Until the start of your next turn" is the next start boundary (left 1).
 * "Until the end of your next turn" skips the end of the turn it was cast on,
 * if it was. "1 minute" is ten start boundaries. `of: null` means this sheet's
 * own mini. Nothing here enforces anything: it counts, and says what ended.
 */

const Turns = (() => {
  // How an effect can last. `rounds` counts the owner's turn starts.
  const LASTS = {
    "": { label: "Until removed" },
    start1: { label: "Until the start of the next turn", at: "start", n: 1 },
    end1: { label: "Until the end of the next turn", at: "end", n: 1 },
    r1: { label: "1 round", at: "start", n: 1 },
    r10: { label: "1 minute (10 rounds)", at: "start", n: 10 },
    r100: { label: "10 minutes (100 rounds)", at: "start", n: 100 },
  };

  /** The queue's active creature id, or null when nobody is in initiative. */
  function activeOf(queue) {
    const items = queue?.items || [];
    if (!items.length) return null;
    const i = queue.activeItemIndex;
    return items[i]?.id ?? null;
  }

  /**
   * Compare the queue with what was last seen. Returns the boundaries crossed,
   * in order, and the new bookkeeping to store.
   *   prev: { active, index, round } (or empty)
   */
  function step(prev, queue) {
    const active = activeOf(queue);
    const index = active != null ? queue.activeItemIndex : null;
    // Which creatures are in it: a GM adding or removing someone shifts the
    // indexes without starting a new round
    const ids = (queue?.items || []).map((i) => i.id).join("|");
    const was = prev?.active ?? null;
    let round = prev?.round || 0;
    const boundaries = [];
    if (active == null) {
      // Initiative ended (or never started): the last turn ends with it
      if (was != null) boundaries.push({ at: "end", of: was });
      return { boundaries, next: { active: null, index: null, round: 0, ids: "" }, combatOver: was != null };
    }
    if (was === active) return { boundaries, next: { active, index, round: round || 1, ids } };
    if (was != null) boundaries.push({ at: "end", of: was });
    if (was == null) round = 1;
    else if (prev.index != null && index <= prev.index && prev.ids === ids) round += 1;
    boundaries.push({ at: "start", of: active });
    return { boundaries, next: { active, index, round, ids } };
  }

  /**
   * An effect's countdown when it's created. `owner` is the creature whose
   * turns it counts; `activeNow` is whose turn it is right now.
   */
  function expiryFor(lastsKey, owner, activeNow) {
    const spec = LASTS[lastsKey];
    if (!spec?.at) return null;
    let left = spec.n;
    // Cast during the owner's own turn: that turn's end doesn't count
    if (spec.at === "end" && owner != null && owner === activeNow) left += 1;
    return { at: spec.at, of: owner ?? null, left, lasts: lastsKey };
  }

  /**
   * Apply one boundary to a list of effects. `me` is this sheet's mini, used
   * where an expiry's owner is null. Returns the effects that just ran out;
   * the rest have their counters updated in place.
   */
  function tick(effects, boundary, me) {
    const ended = [];
    for (const fx of effects || []) {
      const x = fx.expires;
      if (!x || x.left <= 0) continue;
      const owner = x.of ?? me;
      if (owner == null || owner !== boundary.of || x.at !== boundary.at) continue;
      x.left -= 1;
      if (x.left <= 0) ended.push(fx);
    }
    return ended;
  }

  /**
   * Words for what's left, for the effect list. `ownerName` is null for your
   * own turns; `ownersTurnNow` says whether the owner is up right now.
   */
  function describe(x, ownerName, ownersTurnNow) {
    if (!x) return "";
    const whose = ownerName ? `${ownerName}'s` : "your";
    const counted = x.lasts === "r1" || x.lasts === "r10" || x.lasts === "r100";
    if (x.at === "start" && !counted) return `until the start of ${whose} next turn`;
    if (x.at === "end") {
      return x.left === 1 && ownersTurnNow ? `until the end of ${whose} turn` : `until the end of ${whose} next turn`;
    }
    return `${x.left} ${x.left === 1 ? "round" : "rounds"} left`;
  }

  // --- movement --------------------------------------------------------------

  /** Tiles between two board positions, counting diagonals as one (the 5e grid rule). */
  function tilesBetween(a, b) {
    if (!a || !b) return 0;
    const d = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    return Math.round(d);
  }

  const NO_MOVE = ["Grappled", "Restrained", "Paralyzed", "Petrified", "Stunned", "Unconscious"];

  /** This turn's speed: the sheet's walk speed, 0 under a condition that stops you, doubled by Haste or a Dash. */
  function speedFor({ walk, conditions = [], effects = [], dashes = 0 }) {
    const base = Number(walk) || 0;
    if (conditions.some((c) => NO_MOVE.includes(c))) return { speed: 0, why: conditions.find((c) => NO_MOVE.includes(c)) };
    const hasted = effects.some((e) => e.active && /^haste$/i.test(e.name));
    const perTurn = hasted ? base * 2 : base;
    return { speed: perTurn * (1 + dashes), why: hasted ? "Haste" : null };
  }

  return { LASTS, activeOf, step, expiryFor, tick, describe, tilesBetween, speedFor, NO_MOVE };
})();

if (typeof window !== "undefined") window.Turns = Turns;
if (typeof module !== "undefined") module.exports = Turns;
