/**
 * Dice, advantage, and chat output.
 *
 * Three TaleSpire facts drive the design here:
 *
 *  1. Roll strings are basic: `+` and `-` only. No keep-highest, no rerolls.
 *     Advantage is therefore two identical roll groups plus a comparison we make
 *     ourselves — `evaluateDiceResultsGroup` exists precisely so we can, per its
 *     own docs, "implement a 'keep highest group' function".
 *
 *  2. `putDiceInTray` STAGES dice; the player still throws them. The only way to
 *     produce a result without a throw is `sendDiceResult`, which marks the
 *     result as Symbiote-originated so GMs can cross-check.
 *
 *  3. For advantage we stage quietly (`quiet = true`), pick the surviving group,
 *     and send that one back. The docs describe this exact pairing as the
 *     intended use. The Symbiote marker on those rolls is expected, not a bug —
 *     it is what lets a GM verify we kept the right die.
 */

const Rolls = (() => {
  const MODE = { NORMAL: "normal", ADVANTAGE: "advantage", DISADVANTAGE: "disadvantage" };

  // rollId -> context, so we can recognise our own rolls and know what to do
  // with them. Cleared on rollRemoved (dismissed dice) to avoid leaking.
  const tracked = new Map();

  const failed = (r) => r && r.cause !== undefined;
  const label = (mode) =>
    mode === MODE.ADVANTAGE ? " (Adv)" : mode === MODE.DISADVANTAGE ? " (Disadv)" : "";

  /**
   * Stage a roll.
   *
   * @param {object} spec
   * @param {string} spec.name      what the roll is called, e.g. "Club"
   * @param {string} spec.roll      the d20 part, e.g. "d20+4" (omit for damage-only)
   * @param {string} [spec.damage]  damage/healing dice rolled in the same throw
   * @param {string} [spec.mode]    normal | advantage | disadvantage
   * @param {Array}  [spec.bonuses] external buffs, e.g. [{name:"Bless", roll:"1d4"}]
   * @param {object} [spec.context] anything to hand back to the result handler
   */
  async function stage(spec) {
    const mode = spec.mode || MODE.NORMAL;
    const suffix = label(mode);
    const descriptors = [];

    if (spec.roll) {
      descriptors.push({ name: spec.name + suffix, roll: spec.roll });
      // Advantage and disadvantage are a second identical group.
      if (mode !== MODE.NORMAL) descriptors.push({ name: spec.name + suffix, roll: spec.roll });
    }

    // Buffs are their own groups rather than being folded into the d20 string.
    // With advantage that distinction is the difference between right and wrong:
    // Bless is one d4 added to the surviving d20, not a d4 rolled twice and
    // compared along with it.
    for (const bonus of spec.bonuses || []) {
      descriptors.push({ name: bonus.name, roll: bonus.roll });
    }

    // Damage rides along in the same throw so one set of dice answers
    // "did it hit" and "for how much". The label is overridable because not every
    // dice pool is damage — Divine Spark heals or harms on the same 1d8.
    // A damage type rides in the group's name ("Rapier damage [piercing]"), so
    // anyone reading the result can apply resistances per type (lib/damage.js).
    const typed = (name, type) => (typeof Damage !== "undefined" ? Damage.groupName(name, type) : name);
    const damageName = typed(spec.damageName || `${spec.name} damage`, spec.damageType);
    if (spec.damage) descriptors.push({ name: damageName, roll: spec.damage });
    // More damage of other types in the same throw: a smite's radiant, Sneak Attack
    const extraNames = [];
    for (const x of spec.extraDamage || []) {
      if (!x?.roll) continue;
      const n = typed(x.name, x.type);
      extraNames.push(n);
      descriptors.push({ name: n, roll: x.roll });
    }

    // Independent groups in one throw, each read on its own: a row of monsters'
    // saves (each "Goblin 2: Dexterity save"). Results come back in summary.groups.
    const groupNames = [];
    for (const g of spec.groups || []) {
      if (!g?.roll) continue;
      groupNames.push(g.name);
      descriptors.push({ name: g.name, roll: g.roll });
    }

    if (!descriptors.length) throw new Error("Nothing to roll.");

    // Quiet only when we intend to override the displayed result — that is, when
    // two d20 groups need collapsing to one. A normal roll shows TaleSpire's own
    // result and carries no Symbiote marker.
    const quiet = mode !== MODE.NORMAL;

    const rollId = await TS.dice.putDiceInTray(descriptors, quiet);
    if (failed(rollId)) throw new Error(`Could not put dice in tray: ${rollId.cause}`);

    tracked.set(rollId, {
      ...spec,
      mode,
      quiet,
      stagedAt: Date.now(),
      damageName,
      extraNames,
      groupNames,
      // Was the label supplied by the caller, or did we derive "<name> damage"?
      customDamageName: Boolean(spec.damageName),
      damageIncluded: Boolean(spec.damage),
    });

    return rollId;
  }

  /**
   * Handle a roll result. Returns a summary for the UI, or null if the roll
   * wasn't ours.
   */
  async function handleResult(payload) {
    const ctx = tracked.get(payload.rollId);
    if (!ctx) return null; // someone else's dice

    const groups = payload.resultsGroups || [];
    const d20Groups = ctx.roll ? groups.filter((g) => g.name === ctx.name + label(ctx.mode)) : [];
    const damageGroups = groups.filter((g) => g.name === (ctx.damageName || `${ctx.name} damage`));
    const extraGroups = groups.filter((g) => (ctx.extraNames || []).includes(g.name));
    const bonusNames = new Set((ctx.bonuses || []).map((b) => b.name));
    const bonusGroups = groups.filter((g) => bonusNames.has(g.name));

    const summary = { rollId: payload.rollId, name: ctx.name, mode: ctx.mode, context: ctx.context || {}, bonuses: [] };

    // Buff dice land once and apply to whichever d20 survives.
    let bonusTotal = 0;
    for (const g of bonusGroups) {
      const value = await TS.dice.evaluateDiceResultsGroup(g);
      const amount = failed(value) ? 0 : value;
      bonusTotal += amount;
      summary.bonuses.push({ name: g.name, amount });
    }

    if (d20Groups.length) {
      const totals = [];
      for (const g of d20Groups) {
        const value = await TS.dice.evaluateDiceResultsGroup(g);
        totals.push(failed(value) ? 0 : value);
      }

      let keepIndex = 0;
      if (ctx.mode === MODE.ADVANTAGE) keepIndex = totals.indexOf(Math.max(...totals));
      else if (ctx.mode === MODE.DISADVANTAGE) keepIndex = totals.indexOf(Math.min(...totals));

      summary.total = totals[keepIndex] + bonusTotal;
      summary.allTotals = totals;
      summary.dropped = totals.filter((_, i) => i !== keepIndex);
      summary.natural = naturalD20(d20Groups[keepIndex]);

      // Quiet rolls hid the raw result, so send back the group that survived —
      // along with the buff dice, which were never in the comparison.
      if (ctx.quiet) {
        const keep = [d20Groups[keepIndex], ...bonusGroups, ...damageGroups, ...extraGroups];
        const sent = await TS.dice.sendDiceResult(keep, payload.rollId);
        if (failed(sent)) console.error("[Spirekeeper] sendDiceResult failed", sent);
      }
    }

    if (damageGroups.length || extraGroups.length) {
      const typeOf = (g) => (typeof Damage !== "undefined" ? Damage.typeFromGroupName(g.name) : null);
      const parts = [];
      if (damageGroups.length) {
        const value = await TS.dice.evaluateDiceResultsGroup(damageGroups[0]);
        // A damage-only roll has no d20, so its buffs belong on the damage total.
        if (!failed(value)) parts.push({ name: damageGroups[0].name, type: typeOf(damageGroups[0]), amount: value + (d20Groups.length ? 0 : bonusTotal) });
      }
      for (const g of extraGroups) {
        const value = await TS.dice.evaluateDiceResultsGroup(g);
        if (!failed(value)) parts.push({ name: g.name, type: typeOf(g), amount: value });
      }
      summary.damageParts = parts;
      summary.damage = parts.length ? parts.reduce((t, p) => t + p.amount, 0) : null;
      // A custom group name means the pool isn't necessarily damage — Divine
      // Spark's 1d8 heals or harms — so don't assert which it was.
      summary.damageIsNamed = Boolean(ctx.customDamageName);
    }

    if ((ctx.groupNames || []).length) {
      summary.groups = [];
      for (const name of ctx.groupNames) {
        const g = groups.find((x) => x.name === name);
        if (!g) continue;
        const value = await TS.dice.evaluateDiceResultsGroup(g);
        summary.groups.push({ name, total: failed(value) ? null : value, natural: naturalD20(g) });
      }
    }

    tracked.delete(payload.rollId);
    return summary;
  }

  function forget(rollId) {
    tracked.delete(rollId);
  }

  /**
   * Rolls this Symbiote has staged that haven't landed yet.
   *
   * TaleSpire has no API to take dice back out of the tray — `putDiceInTray` is
   * one-way, and the only removal signal is the `rollRemoved` event fired when
   * the player dismisses them in game. So a misclick leaves dice sitting there
   * and leaves us armed to narrate a roll nobody wanted. The panel can at least
   * stop listening, which is what `forgetAll` is for.
   */
  function staged() {
    const now = Date.now();
    return [...tracked.entries()].map(([rollId, ctx]) => ({
      rollId,
      name: ctx.name,
      mode: ctx.mode,
      roll: ctx.roll,
      damage: ctx.damage,
      waitingMs: ctx.stagedAt ? now - ctx.stagedAt : 0,
    }));
  }

  /**
   * Forget rolls that were staged and never thrown.
   *
   * TaleSpire gives a Symbiote no way to take dice back out of the tray, so this
   * cannot tidy the board — only the player can do that. What it does tidy is the
   * panel's own memory: a misclick otherwise leaves us armed indefinitely, ready
   * to narrate a roll nobody wanted and to arm a damage button off it, possibly
   * an hour later in a different fight.
   *
   * Returns how many were dropped, so the caller knows whether to redraw.
   */
  const STALE_AFTER_MS = 2 * 60 * 1000;

  function sweep(now = Date.now()) {
    let dropped = 0;
    for (const [rollId, ctx] of tracked) {
      if (ctx.stagedAt && now - ctx.stagedAt > STALE_AFTER_MS) {
        tracked.delete(rollId);
        dropped += 1;
      }
    }
    return dropped;
  }

  function forgetAll() {
    const count = tracked.size;
    tracked.clear();
    return count;
  }

  /**
   * Dig the raw d20 face out of a results group so we can spot nat 1s and 20s.
   * A group's `result` is a tree of nested operations, so walk it depth-first.
   */
  function naturalD20(group) {
    let found = null;

    function walk(node) {
      if (!node || found !== null) return;
      if (node.kind === "d20" && Array.isArray(node.results)) {
        found = node.results[0];
        return;
      }
      if (Array.isArray(node.operands)) node.operands.forEach(walk);
    }

    walk(group?.result);
    return found;
  }

  /**
   * A critical hit doubles the dice, not the modifier: 1d4+2 becomes 2d4+2.
   * Applied to every dice term so 2d6+1d8 scales as a whole.
   */
  function critical(roll) {
    return String(roll).replace(/(\d*)d(\d+)/g, (_, count, sides) =>
      `${(parseInt(count || "1", 10)) * 2}d${sides}`
    );
  }

  // --- chat ----------------------------------------------------------------

  /**
   * Post a result to chat. Chat reaches every player in the game whether or not
   * they have this Symbiote installed, which makes it the one output channel
   * that works for a mixed table. Messages cap at 400 characters.
   */
  async function post(text, creatureId, target = "board") {
    const body = text.length > 400 ? `${text.slice(0, 397)}...` : text;
    const res = creatureId
      ? await TS.chat.sendAsCreature(body, creatureId, target)
      : await TS.chat.send(body, target);
    if (failed(res)) console.error("[Spirekeeper] chat send failed", res);
    return res;
  }

  /** TaleSpire chat understands TextMeshPro rich text. */
  const bold = (s) => `<b>${s}</b>`;
  const dim = (s) => `<color=#9aa0ab>${s}</color>`;

  function describe(summary) {
    const parts = [bold(summary.name)];

    if (summary.total !== undefined) {
      let roll = `${summary.total}`;
      if (summary.natural === 20) roll = `${summary.total} ${bold("CRIT")}`;
      else if (summary.natural === 1) roll = `${summary.total} ${dim("(nat 1)")}`;
      parts.push(roll);
      if (summary.dropped?.length) parts.push(dim(`[dropped ${summary.dropped.join(", ")}]`));
    }

    if (summary.bonuses?.length) {
      parts.push(dim(`(${summary.bonuses.map((b) => `${b.name} +${b.amount}`).join(", ")})`));
    }

    if (summary.damage != null) {
      parts.push(summary.damageIsNamed ? `· ${summary.damage}` : `· ${summary.damage} damage`);
    }
    return parts.join(" ");
  }

  return { MODE, stage, handleResult, forget, forgetAll, staged, sweep, STALE_AFTER_MS, post, describe, critical, bold, dim };
})();

if (typeof window !== "undefined") window.Rolls = Rolls;
