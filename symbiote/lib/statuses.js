/**
 * TaleSpire statuses as 5e conditions.
 *
 * A status set from a mini's radial menu (Knocked down, a skull, ...) is a
 * persistent emote, and the symbiote API only reports it as an opaque id. The
 * bridge can read TaleSpire's own emote catalog, which has every status's name,
 * so with the bridge running the GM's Party view lists every status by name,
 * with a condition picker and a suggestion where the names match. Without it,
 * the list falls back to statuses seen on minis, named by the minis wearing them.
 *
 * Status ids are TaleSpire content ids, the same in every campaign, so the GM
 * pairs them once and the pairings hold everywhere. They're kept in the global
 * library and broadcast over sync; a player's panel asks for them when it opens.
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

  /** A status's name from TaleSpire's catalog, cached from the last bridge read. */
  const nameOf = (emoteId) => Store.statusNames()[emoteId] || null;

  /** Read TaleSpire's status catalog through the bridge and cache the names. */
  async function loadCatalog() {
    const list = await Bridge.statuses();
    if (!list) return false;
    const names = {};
    for (const st of list) if (st?.id) names[st.id] = st.name || st.id;
    await Store.setStatusNames(names);
    onChange();
    return true;
  }

  // Status names, lower-cased, that mean a 5e condition. Exact condition names
  // match on their own; these cover TaleSpire's wording and common synonyms.
  const ALIASES = {
    Prone: ["knocked down", "knocked out", "fallen", "prone"],
    Unconscious: ["asleep", "sleeping", "sleep", "unconscious", "knocked out cold"],
    Frightened: ["scared", "afraid", "fear", "frightened", "terrified"],
    Stunned: ["stunned", "dazed"],
    Restrained: ["restrained", "entangled", "webbed", "tied up"],
    Poisoned: ["poisoned", "sick", "poison"],
    Blinded: ["blind", "blinded"],
    Deafened: ["deaf", "deafened"],
    Charmed: ["charmed", "love", "hearts"],
    Paralyzed: ["paralyzed", "paralysed", "frozen", "held"],
    Petrified: ["petrified", "stone", "turned to stone"],
    Exhaustion: ["exhausted", "exhaustion", "tired", "fatigued"],
    Concentrating: ["concentrating", "concentration"],
    Invisible: ["invisible", "invisibility"],
    Incapacitated: ["incapacitated"],
    Grappled: ["grappled", "grabbed"],
    Hidden: ["hidden", "hiding", "stealth"],
    Dodging: ["dodging", "dodge"],
  };

  /** The condition a status name most likely means, or null. */
  function suggest(statusName) {
    const n = String(statusName || "").trim().toLowerCase();
    if (!n) return null;
    for (const [condition, words] of Object.entries(ALIASES)) {
      if (n === condition.toLowerCase() || words.includes(n)) return condition;
    }
    for (const [condition, words] of Object.entries(ALIASES)) {
      if (words.some((w) => w.length > 3 && n.includes(w))) return condition;
    }
    return null;
  }

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

  /**
   * Every status for the GM's pairing list: TaleSpire's whole catalog when we
   * have its names, plus anything seen on a mini or already paired. Statuses on
   * minis right now come first, then the rest by name.
   */
  function list() {
    const ids = new Set([
      ...Object.keys(Store.statusNames()),
      ...seen.keys(),
      ...Object.keys(Store.statusMap()),
    ]);
    const used = new Set(Object.values(Store.statusMap()));
    return [...ids]
      .map((id) => {
        const name = nameOf(id);
        const suggestion = conditionFor(id) ? null : suggest(name);
        return {
          emoteId: id,
          name,
          names: [...(seen.get(id) || [])],
          condition: conditionFor(id),
          // Don't suggest a condition another status already has
          suggestion: suggestion && !used.has(suggestion) ? suggestion : null,
        };
      })
      .sort((a, b) =>
        (b.names.length > 0) - (a.names.length > 0) ||
        String(a.name || "~").localeCompare(String(b.name || "~")));
  }

  /** Pair every status that has a suggestion and no pairing yet. Returns how many. */
  async function acceptSuggestions() {
    let n = 0;
    const taken = new Set(Object.values(Store.statusMap()));
    for (const it of list()) {
      if (it.condition || !it.suggestion || taken.has(it.suggestion)) continue;
      taken.add(it.suggestion);
      await setMapping(it.emoteId, it.suggestion, true);
      n += 1;
    }
    return n;
  }

  return {
    configure, observe, on, conditionFor, emoteFor, nameOf, setMapping, shareAll, list,
    loadCatalog, suggest, acceptSuggestions,
  };
})();

if (typeof window !== "undefined") window.Statuses = Statuses;
