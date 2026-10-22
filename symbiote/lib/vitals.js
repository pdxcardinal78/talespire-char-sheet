/**
 * Hit points, temporary hit points and AC as the GM sees them on minis.
 *
 * Temporary hit points are their own pool, never folded into HP: damage takes
 * them first, healing never touches them, a new pool replaces the old only if
 * it's larger, and a long rest clears them. One number can't do that once a
 * creature is hurt, so they're kept apart everywhere.
 *
 * Where a mini's temp HP lives depends on the campaign:
 *
 *  - If the campaign has a named stat for it ("Temp HP", "THP", ...), that stat
 *    on the mini is the truth. Everyone, and TaleSpire's own UI, sees it.
 *  - If not, the player's own panel holds it and reports it to the GM over sync
 *    (see Party "vit" messages). If that player's panel isn't open, the GM's
 *    panel says temp HP is unknown rather than assuming zero.
 *
 * Stats are matched by name and never renamed here: campaign stat names belong
 * to the campaign's owners.
 */

const Vitals = (() => {
  const TEMP_NAME = /^\s*(temp(orary)?[\s._-]*(hp|hit[\s_-]*points?)|thp)\s*$/i;
  const AC_NAME = /^\s*(ac|armou?r(\s*class)?)\s*$/i;

  // creatureId -> { temp, hp, max, at } as last reported by the owner's panel
  const reported = new Map();

  /** Find a named stat on a mini; index is its slot (0 to 7). */
  function findStat(stats, re) {
    const list = stats || [];
    for (let i = 0; i < list.length; i += 1) {
      const st = list[i];
      if (st && re.test(st.name || "")) {
        return { index: i, value: Number.isFinite(st.value) ? st.value : null, max: st.max };
      }
    }
    return null;
  }

  const tempStatOf = (info) => findStat(info?.stats, TEMP_NAME);

  function acOf(info) {
    const st = findStat(info?.stats, AC_NAME);
    return st && st.value != null ? st.value : null;
  }

  /** Does this campaign name a stat for temp HP? Any mini's stat list answers it. */
  const campaignHasTempStat = (info) => Boolean(tempStatOf(info));

  /** The first empty stat slot, for the GM's opt-in "add a Temp HP stat" action. */
  function emptyStatSlot(names) {
    const i = (names || []).findIndex((n) => !String(n || "").trim());
    return i === -1 ? null : i;
  }

  function report(creatureId, data) {
    if (!creatureId) return;
    reported.set(creatureId, { ...data, at: Date.now() });
  }

  /**
   * A mini's vitals as the GM sees them.
   * tempSource: "stat" (on the mini), "panel" (reported by its player), or null
   * when nobody knows; temp is null in that last case, never a guessed zero.
   */
  function read(info) {
    const hp = info?.hp || {};
    const stat = tempStatOf(info);
    const rep = info?.id ? reported.get(info.id) : null;
    let temp = null;
    let tempSource = null;
    if (stat) {
      temp = stat.value ?? 0;
      tempSource = "stat";
    } else if (rep) {
      temp = rep.temp ?? 0;
      tempSource = "panel";
    }
    return {
      id: info?.id,
      name: info?.name || "Unnamed",
      hp: Number.isFinite(hp.value) ? hp.value : null,
      max: Number.isFinite(hp.max) ? hp.max : null,
      temp,
      tempSource,
      tempIndex: stat ? stat.index : null,
      tempMax: stat ? stat.max : null,
      ac: acOf(info),
    };
  }

  /** Damage takes temp HP first. Returns the new pools and how much temp absorbed. */
  function takeDamage({ hp, temp }, amount) {
    const t = Math.max(0, temp || 0);
    const absorbed = Math.min(t, Math.max(0, amount));
    return {
      hp: Math.max(0, (hp ?? 0) - (amount - absorbed)),
      temp: t - absorbed,
      absorbed,
    };
  }

  /** Temp HP doesn't stack: keep the larger pool. */
  const grantTemp = (current, amount) => Math.max(current || 0, amount || 0);

  /**
   * Write new vitals to a mini through the bridge, as the GM.
   * Returns { ok, error, syncTemp } where syncTemp is set when the temp pool
   * lives in the player's panel and the caller must tell it over sync.
   */
  async function write(v, next) {
    if (!Bridge.canWrite()) return { ok: false, error: "bridge unavailable" };
    const hpChanged = next.hp != null && (next.hp !== v.hp || (next.max != null && next.max !== v.max));
    if (hpChanged) {
      const r = await Bridge.setHp(v.id, next.hp, next.max ?? v.max);
      if (!r.ok) return r;
    }
    if (next.temp != null && next.temp !== v.temp) {
      if (v.tempIndex != null) {
        // The stat's max is only a display ceiling; keep it at least the pool
        const max = Math.max(next.temp, v.tempMax || 0);
        const r = await Bridge.setStat(v.id, v.tempIndex, next.temp, max);
        if (!r.ok) return r;
      } else {
        return { ok: true, syncTemp: next.temp };
      }
    }
    return { ok: true };
  }

  /** Short text for a temp pool, for rows and chat. */
  function tempLabel(v) {
    if (v.temp == null) return v.hp != null ? "temp ?" : "";
    return v.temp > 0 ? `+${v.temp} temp` : "";
  }

  return {
    TEMP_NAME, AC_NAME, findStat, tempStatOf, acOf, campaignHasTempStat, emptyStatSlot,
    report, read, takeDamage, grantTemp, write, tempLabel,
    reportedFor: (id) => reported.get(id) || null,
  };
})();

if (typeof window !== "undefined") window.Vitals = Vitals;
