/**
 * TaleSpire statuses as 5e conditions.
 *
 * A status set from a mini's radial menu (Knocked down, a skull, ...) is a
 * persistent emote, and the symbiote API only reports it as an opaque id. The
 * bridge reads the radial menu's own list, which has every status's name.
 *
 * The GM pairs each 5e condition with a TaleSpire status. TaleSpire has fewer
 * statuses than 5e has conditions, so several conditions may share one status
 * (Paralyzed and Stunned both on a dizzy-stars status, say). Reading the board:
 *  - a status that stands for one condition means that condition;
 *  - a status shared by several is ambiguous, so it's reported as "shared"
 *    and the panel asks which applies instead of guessing.
 * Writing the board, a shared status stays on the mini while any of its
 * conditions does.
 *
 * Status ids are TaleSpire content ids, the same in every campaign, so the
 * pairings live in the global library and are shared with players over sync.
 */

const Statuses = (() => {
  const CONDITIONS = [
    "Blinded", "Charmed", "Deafened", "Exhaustion", "Frightened", "Grappled",
    "Incapacitated", "Invisible", "Paralyzed", "Petrified", "Poisoned", "Prone",
    "Restrained", "Stunned", "Unconscious", "Concentrating", "Dodging", "Hidden",
  ];

  // emoteId -> Set of mini names it has been seen on, this session
  const seen = new Map();
  let onChange = () => {};

  function configure({ changed }) {
    if (changed) onChange = changed;
  }

  const emotesOf = (info) => info?.idsOfActivePersistentEmotes || [];

  function observe(info) {
    for (const id of emotesOf(info)) {
      if (!seen.has(id)) seen.set(id, new Set());
      if (info.name) seen.get(id).add(info.name);
    }
  }

  /** The status paired with a condition, or null. */
  const emoteFor = (condition) => Store.conditionMap()[condition] || null;

  /** Every condition paired with a status, in the standard order. */
  const conditionsFor = (emoteId) =>
    CONDITIONS.filter((c) => Store.conditionMap()[c] === emoteId)
      .concat(Object.keys(Store.conditionMap()).filter((c) => !CONDITIONS.includes(c) && Store.conditionMap()[c] === emoteId));

  /** The condition a status means, when it means exactly one. */
  const conditionFor = (emoteId) => {
    const l = conditionsFor(emoteId);
    return l.length === 1 ? l[0] : null;
  };

  const nameOf = (emoteId) => Store.statusNames()[emoteId] || null;

  /** A status's name, or the minis it's been seen on when TaleSpire's list isn't loaded. */
  const labelOf = (emoteId) => {
    const n = nameOf(emoteId);
    if (n) return n;
    const on = [...(seen.get(emoteId) || [])];
    return on.length ? `Status on ${on.join(", ")}` : "Unnamed status";
  };

  let loading = null;
  let lastTry = 0;
  /** Read TaleSpire's status list through the bridge and cache the names. */
  async function loadCatalog({ force = false } = {}) {
    if (loading) return loading;
    if (!force && Date.now() - lastTry < 10000) return false;
    lastTry = Date.now();
    loading = (async () => {
      const list = await Bridge.statuses();
      if (!list || !list.length) return false;
      const names = {};
      for (const st of list) if (st?.id) names[st.id] = st.name || st.id;
      await Store.setStatusNames(names);
      onChange();
      return true;
    })().finally(() => { loading = null; });
    return loading;
  }
  const catalogLoaded = () => Object.keys(Store.statusNames()).length > 0;

  // Status names, lower-cased, that mean a 5e condition.
  const ALIASES = {
    Prone: ["knocked down", "fallen", "prone"],
    Unconscious: ["asleep", "sleeping", "sleep", "unconscious", "knocked out", "knocked out cold"],
    Frightened: ["scared", "afraid", "fear", "frightened", "terrified"],
    Stunned: ["stunned", "dazed", "dizzy"],
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

  /** The status whose name suggests this condition, if TaleSpire has one. */
  function suggestionFor(condition) {
    for (const [id, name] of Object.entries(Store.statusNames())) {
      if (suggest(name) === condition) return id;
    }
    return null;
  }

  /**
   * What a mini shows on the board:
   *  conditions: unambiguous ones, by name
   *  shared: [{ emoteId, name, conditions }] for statuses several conditions share
   *  unknown: status ids no condition is paired with
   */
  function on(info) {
    observe(info);
    const conditions = [];
    const shared = [];
    const unknown = [];
    for (const id of emotesOf(info)) {
      const l = conditionsFor(id);
      if (l.length === 1) {
        if (!conditions.includes(l[0])) conditions.push(l[0]);
      } else if (l.length > 1) {
        shared.push({ emoteId: id, name: labelOf(id), conditions: l });
      } else {
        unknown.push(id);
      }
    }
    return { conditions, shared, unknown, emotes: [...emotesOf(info)] };
  }

  /** Pair a condition with a status (or clear it with null). `share` broadcasts it. */
  async function setMapping(condition, emoteId, share = true) {
    if (!condition) return;
    if ((emoteFor(condition) || null) === (emoteId || null)) return;
    await Store.setConditionMapping(condition, emoteId || null);
    if (share) await Party.conditionMapping(condition, emoteId || null).catch(() => {});
    onChange();
  }

  /** Answer a player's request for the pairings, one message each (sync caps at 500 chars). */
  async function shareAll() {
    for (const [condition, emoteId] of Object.entries(Store.conditionMap())) {
      await Party.conditionMapping(condition, emoteId).catch(() => {});
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  /** One row per condition for the GM's pairing list. */
  function list() {
    return CONDITIONS.map((condition) => {
      const emoteId = emoteFor(condition);
      const suggestion = emoteId ? null : suggestionFor(condition);
      return {
        condition,
        emoteId,
        sharedWith: emoteId ? conditionsFor(emoteId).filter((c) => c !== condition) : [],
        suggestion,
        suggestionName: suggestion ? labelOf(suggestion) : null,
      };
    });
  }

  /**
   * Every TaleSpire status for the pickers: the radial menu's list when the
   * bridge has read it, plus any seen on a mini or already paired. By name.
   */
  function statuses() {
    const ids = new Set([...Object.keys(Store.statusNames()), ...seen.keys(), ...Object.values(Store.conditionMap())]);
    return [...ids]
      .map((id) => ({ emoteId: id, name: labelOf(id), named: Boolean(nameOf(id)), conditions: conditionsFor(id) }))
      .sort((a, b) => (b.named - a.named) || a.name.localeCompare(b.name));
  }

  /** Pair every unpaired condition that has a suggested status. Returns how many. */
  async function acceptSuggestions() {
    let n = 0;
    for (const it of list()) {
      if (it.emoteId || !it.suggestion) continue;
      await setMapping(it.condition, it.suggestion, true);
      n += 1;
    }
    return n;
  }

  return {
    CONDITIONS, configure, observe, on, conditionFor, conditionsFor, emoteFor, nameOf, labelOf,
    setMapping, shareAll, list, statuses, loadCatalog, catalogLoaded, suggest, acceptSuggestions,
  };
})();

if (typeof window !== "undefined") window.Statuses = Statuses;
if (typeof module !== "undefined") module.exports = Statuses;
