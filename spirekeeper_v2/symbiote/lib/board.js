/**
 * Reading creatures off the board.
 *
 * `TS.creatures.getMoreInfo` is documented as taking `Array[fragmentOrId]` —
 * either `{ id }` objects or bare id strings. In practice the bare strings come
 * back with nothing, which surfaced as a GM being told a mini they had just
 * placed themselves was "not visible to you". Every call in this mod that worked
 * happened to pass fragments; every call that failed passed strings.
 *
 * Rather than trust either reading of the docs, this asks with fragments and
 * falls back to ids, so it keeps working whichever form a future build prefers.
 */

const Board = (() => {
  const failed = (r) => r && r.cause !== undefined;

  const idOf = (x) => (typeof x === "string" ? x : x?.id);

  /**
   * Creature details for a list of ids or fragments. Returns an array, empty if
   * the board genuinely has nothing to say; throws only when the call itself
   * failed, so callers can tell "not visible" from "broken".
   */
  async function creatureInfo(list) {
    const ids = (list || []).map(idOf).filter(Boolean);
    if (!ids.length) return [];

    const asFragments = await TS.creatures.getMoreInfo(ids.map((id) => ({ id })));
    if (!failed(asFragments) && asFragments?.length) return asFragments;

    const asIds = await TS.creatures.getMoreInfo(ids);
    if (!failed(asIds) && asIds?.length) return asIds;

    // Both shapes came back empty or failed. Prefer reporting a real cause.
    const cause = (failed(asFragments) && asFragments.cause) || (failed(asIds) && asIds.cause);
    if (cause) throw new Error(String(cause));

    console.warn("[Spirekeeper] getMoreInfo returned nothing for", ids);
    return [];
  }

  /** Details for exactly one creature, or null. */
  async function oneCreature(id) {
    const infos = await creatureInfo([id]);
    return infos[0] || null;
  }

  return { creatureInfo, oneCreature };
})();

if (typeof window !== "undefined") window.Board = Board;
