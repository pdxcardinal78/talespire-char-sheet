/**
 * TaleSpire statuses as 5e conditions.
 *
 * A status set from a mini's radial menu (Knocked down, a skull, ...) is a
 * persistent emote, and the API only ever reports it as an opaque id. So the
 * GM pairs each status with a condition once per campaign: set the status on
 * any mini, and it shows up in the Party view, named by the minis wearing it,
 * with a condition picker beside it. The pairing then holds for every creature
 * and every player.
 *
 * The GM's panel stores the pairings in campaign storage and broadcasts each
 * one over sync; a player's panel asks for them when it opens and keeps its
 * own copy. Only the GM sets pairings.
 */

const Statuses = (() => {
  // emoteId -> Set of mini names it has been seen on, this session
  const seen = new Map();
  let onChange = () => {};

  function configure({ changed }) {
    if (changed) onChange = changed;
  }

  const emotesOf = (info) => info?.idsOfActivePersistentEmotes || [];

  /** Note which statuses a mini wears, so the GM's mapping list can name them. */
  function observe(info) {
    for (const id of emotesOf(info)) {
      if (!seen.has(id)) seen.set(id, new Set());
      if (info.name) seen.get(id).add(info.name);
    }
  }

  const conditionFor = (emoteId) => Store.statusMap()[emoteId] || null;

  /** The status that stands for a condition, if one is paired with it. */
  function emoteFor(condition) {
    const entry = Object.entries(Store.statusMap()).find(([, c]) => c === condition);
    return entry ? entry[0] : null;
  }

  /** Conditions a mini shows on the board, by name, plus statuses not yet paired. */
  function on(info) {
    observe(info);
    const conditions = [];
    const unknown = [];
    for (const id of emotesOf(info)) {
      const c = conditionFor(id);
      if (c) {
        if (!conditions.includes(c)) conditions.push(c);
      } else {
        unknown.push(id);
      }
    }
    return { conditions, unknown };
  }

  /**
   * Pair a status with a condition (or clear it with null). From the GM's
   * picker, `share` broadcasts it; from sync, it's just stored.
   */
  async function setMapping(emoteId, condition, share = true) {
    if (!emoteId) return;
    if ((conditionFor(emoteId) || null) === (condition || null)) return;
    // One status per condition: pairing a second one moves the condition over
    if (condition) {
      const previous = emoteFor(condition);
      if (previous && previous !== emoteId) await Store.setStatusMapping(previous, null);
    }
    await Store.setStatusMapping(emoteId, condition || null);
    if (share) await Party.statusMapping(emoteId, condition || null).catch(() => {});
    onChange();
  }

  /** Answer a player's request for the pairings, one message each (sync caps at 500 chars). */
  async function shareAll() {
    for (const [emoteId, condition] of Object.entries(Store.statusMap())) {
      await Party.statusMapping(emoteId, condition).catch(() => {});
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  /** Every status seen this session or already paired, for the GM's mapping list. */
  function list() {
    const ids = new Set([...seen.keys(), ...Object.keys(Store.statusMap())]);
    return [...ids].map((id) => ({
      emoteId: id,
      names: [...(seen.get(id) || [])],
      condition: conditionFor(id),
    }));
  }

  return { configure, observe, on, conditionFor, emoteFor, setMapping, shareAll, list };
})();

if (typeof window !== "undefined") window.Statuses = Statuses;
