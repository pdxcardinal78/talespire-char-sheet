/**
 * Saving throw requests.
 *
 * One request is a "save session": which save, what DC, what damage (if any)
 * and who must roll. It lives on the GM's panel, because only the GM can see
 * every creature and write hit points to monsters; a player who asks for
 * saves (casting Fireball) sends the request there. With no GM panel open,
 * the player's own panel runs it and monsters' results are entered by hand.
 *
 *  - Player characters get a prompt on their own panel: the save and the
 *    spell, never the DC. They roll with their sheet's bonus and the result
 *    comes back.
 *  - Monsters roll on the GM's panel, all in one throw, with their stat
 *    block's save bonus (the ability modifier when it lists none).
 *  - Damage is rolled once. Each creature takes it in full on a fail, half on
 *    a success if the spell says so, then through its own defenses.
 *
 * This module is the bookkeeping; app.js draws it and moves the messages.
 */

const Saves = (() => {
  const ABILITIES = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };

  /** "Dexterity", "DEX", "dex" -> "dex" */
  function abilityKey(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return null;
    return Object.keys(ABILITIES).find((k) => t === k || t.startsWith(k) || ABILITIES[k].toLowerCase() === t) || null;
  }

  let seq = 0;
  const newId = () => `sv${Date.now().toString(36)}${(++seq).toString(36)}`;

  /**
   * A new session. rows: [{ id, name, kind: "pc" | "monster", bonus?, hidden? }]
   * damage: { expr, type } or null; half: whether a success takes half.
   */
  function create({ id, name, ability, dc, damage = null, half = true, rows = [], from = null }) {
    return {
      id: id || newId(),
      name: name || "Save",
      ability: abilityKey(ability) || "dex",
      dc: Number.isFinite(Number(dc)) && Number(dc) > 0 ? Number(dc) : null,
      damage,
      half,
      from,
      rows: rows.map((r) => ({ ...r, total: null, natural: null, pass: null, manual: false })),
      rolled: null, // the damage once rolled: { parts, total }
      applied: false,
    };
  }

  /** Add creatures to a session without duplicating one already in it. */
  function addRows(session, rows) {
    for (const r of rows) {
      if (session.rows.some((x) => x.id === r.id)) continue;
      session.rows.push({ ...r, total: null, natural: null, pass: null, manual: false });
    }
  }

  /** Record a roll; pass/fail follows from the DC unless overridden by hand. */
  function record(session, creatureId, total, natural) {
    const row = session.rows.find((r) => r.id === creatureId);
    if (!row) return null;
    row.total = total;
    row.natural = natural ?? null;
    if (!row.manual) row.pass = verdict(session, row);
    return row;
  }

  /** 5e saves: no automatic success on a 20 or failure on a 1, just the total against the DC. */
  function verdict(session, row) {
    if (row.total == null || session.dc == null) return null;
    return row.total >= session.dc;
  }

  function setDc(session, dc) {
    session.dc = Number(dc) > 0 ? Number(dc) : null;
    for (const r of session.rows) if (!r.manual) r.pass = verdict(session, r);
  }

  /** The GM's ✓ / ✗, which beats the dice (Legendary Resistance, a ruling). */
  function override(session, creatureId, pass) {
    const row = session.rows.find((r) => r.id === creatureId);
    if (!row) return;
    row.manual = pass != null;
    row.pass = pass != null ? pass : verdict(session, row);
  }

  /** How much damage a row takes before defenses: full on a fail, half (or none) on a success. */
  function damageFor(session, row) {
    if (!session.rolled || row.pass == null) return null;
    const scale = row.pass ? (session.half ? 0.5 : 0) : 1;
    return session.rolled.parts.map((p) => ({ type: p.type, amount: Math.floor(p.amount * scale) }));
  }

  const waiting = (session) => session.rows.filter((r) => r.pass == null);

  return { ABILITIES, abilityKey, create, addRows, record, verdict, setDc, override, damageFor, waiting, newId };
})();

if (typeof window !== "undefined") window.Saves = Saves;
if (typeof module !== "undefined") module.exports = Saves;
