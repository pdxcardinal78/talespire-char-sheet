/**
 * Spell zones: who is inside a Fireball.
 *
 * The caster clicks Zone on a spell with an area, TaleSpire's own ruler tool
 * opens already set to the right shape (TS.rulers.startRuler), and when the
 * ruler is placed TaleSpire reports its geometry (rulers.onRulerEvent). The
 * panel then checks every mini it knows about against that shape and lists
 * who's inside.
 *
 * Which minis it can check:
 *  - The GM's panel with the bridge: every mini on the board (GET /creatures).
 *  - The GM's panel without it: the party, linked combatants and any lassoed
 *    minis.
 *  - A player's panel: it asks the GM's panel over sync, which checks the
 *    ruler (rulers are shared) and answers with the names inside, leaving out
 *    hidden minis. If no GM panel answers, it checks its own mini and any
 *    minis the player has lassoed.
 *
 * Counting a creature: 5e counts a creature if any part of its space is in
 * the area, so each mini is treated as a disc of radius half its size
 * (scale 1 = one tile = a Medium creature's 5 ft square). Heights use the
 * mini's base. It's an approximation of a square on a grid, and a close one.
 *
 * The API's ruler has sphere, cone and line, but no cube: a cube is placed with
 * the sphere ruler (centre to corner of a face) and checked as a square
 * around that centre. Cylinders and emanations use the sphere.
 */

const Zones = (() => {
  let deps = {}; // { toast, onResult, requestFromGm, me }
  let pending = null; // { rulerId, spell, area, startedAt }
  let units = { name: "ft", perTile: 5 };
  let creatureSource = null; // async () => [{ id, name, x, y, z, scale, hidden }]

  const failed = (r) => r && r.cause !== undefined;

  function configure(d) {
    deps = d;
  }

  function useCreatures(fn) {
    creatureSource = fn;
  }

  // --- reading a spell's area ----------------------------------------------

  const SHAPES = {
    sphere: "sphere", radius: "sphere", cylinder: "sphere", emanation: "sphere", circle: "sphere",
    cone: "cone", line: "line", cube: "cube", square: "cube",
  };
  const RULER_KIND = { sphere: "sphere", cube: "sphere", cone: "cone", line: "line" };

  /**
   * A spell's area from what the sheet has: D&D Beyond's "20 ft. Sphere", the
   * SRD's "20 feet sphere", or failing both the description's
   * "20-foot-radius Sphere". Returns { shape, size } in feet, or null.
   */
  function areaOf(spell) {
    const texts = [spell?.aoe, spell?.description, spell?.desc].filter(Boolean).map(String);
    for (const t of texts) {
      let m = /(\d+)\s*(?:ft\.?|feet|foot)\s*-?\s*(sphere|radius|cylinder|emanation|cone|line|cube|square|circle)/i.exec(t);
      if (!m) m = /(\d+)-foot(?:-(?:radius|long|wide))?\s+(sphere|cylinder|emanation|cone|line|cube|square)/i.exec(t);
      if (m) {
        const shape = SHAPES[m[2].toLowerCase()];
        if (shape) return { shape, size: parseInt(m[1], 10) };
      }
    }
    return null;
  }

  const describeArea = (a) => (a ? `${a.size} ft ${a.shape}` : "");

  // --- geometry ------------------------------------------------------------
  //
  // Positions are TaleSpire world units: one unit per tile, y up.

  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const len = (a) => Math.sqrt(dot(a, a));
  const flat = (a) => Math.sqrt(a.x * a.x + a.z * a.z);

  /** Half a creature's footprint, in tiles. */
  const reach = (c) => Math.max(0.25, (c.scale || 1) * 0.5);

  /** Is the creature inside the ruler's shape? `ruler` is TaleSpire's rulerResult payload. */
  function contains(shape, ruler, c) {
    const p = { x: c.x, y: c.y, z: c.z };
    const r = reach(c);
    if (shape === "sphere") {
      const radius = len(sub(ruler.endPosition, ruler.startPosition));
      return len(sub(p, ruler.startPosition)) - r <= radius + 1e-6;
    }
    if (shape === "cube") {
      // Placed with the sphere ruler: centre, and a handle on the edge of a face
      const half = Math.max(Math.abs(ruler.endPosition.x - ruler.startPosition.x),
        Math.abs(ruler.endPosition.z - ruler.startPosition.z),
        flat(sub(ruler.endPosition, ruler.startPosition)) / Math.SQRT2);
      const d = sub(p, ruler.startPosition);
      return Math.abs(d.x) - r <= half && Math.abs(d.z) - r <= half && Math.abs(d.y) <= half * 2;
    }
    if (shape === "cone") {
      const axis = sub(ruler.endPosition, ruler.startPosition);
      const length = len(axis);
      if (!length) return false;
      const u = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
      const v = sub(p, ruler.startPosition);
      const t = dot(v, u);
      if (t < -r || t > length + r) return false;
      const perp = len(sub(v, { x: u.x * t, y: u.y * t, z: u.z * t }));
      const half = ((ruler.angle || 53.13) / 2) * (Math.PI / 180);
      return perp <= Math.max(0, t) * Math.tan(half) + r;
    }
    if (shape === "line") {
      // 5 ft wide unless the spell says otherwise: half a tile either side
      const pts = ruler.positions || [];
      const halfWidth = (ruler.widthTiles || 1) / 2;
      for (let i = 0; i + 1 < pts.length; i += 1) {
        const a = pts[i];
        const ab = sub(pts[i + 1], a);
        const l2 = dot(ab, ab);
        const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
        const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t };
        if (len(sub(p, closest)) - r <= halfWidth) return true;
      }
      return false;
    }
    return false;
  }

  /** What the ruler measures, in feet, to check against the spell. */
  function measured(shape, ruler) {
    const tiles = (() => {
      if (shape === "line") {
        const pts = ruler.positions || [];
        let total = 0;
        for (let i = 0; i + 1 < pts.length; i += 1) total += len(sub(pts[i + 1], pts[i]));
        return total;
      }
      if (shape === "cube") return flat(sub(ruler.endPosition, ruler.startPosition)) * 2;
      return len(sub(ruler.endPosition, ruler.startPosition));
    })();
    return Math.round(tiles * units.perTile * 10) / 10;
  }

  /** Which shape a ruler is, from TaleSpire's payload. */
  function shapeOfRuler(ruler) {
    if (Array.isArray(ruler?.positions)) return "line";
    if (ruler && "angle" in ruler && ruler.angle) return "cone";
    return "sphere";
  }

  // --- the flow ------------------------------------------------------------

  async function loadUnits() {
    try {
      const u = await TS.rulers.getDistanceUnitsForThisCampaign();
      if (!failed(u) && u?.numberPerTile) units = { name: u.name || "ft", perTile: u.numberPerTile };
    } catch {
      /* keep 5 ft per tile */
    }
  }

  /** Open TaleSpire's ruler for a spell's area. */
  async function cast(spell) {
    const area = areaOf(spell);
    if (!area) return deps.toast?.(`${spell?.name || "That spell"} has no area to place.`, true);
    await loadUnits();
    const res = await TS.rulers.startRuler(RULER_KIND[area.shape]);
    if (failed(res) || !res) {
      return deps.toast?.(`Couldn't open the ruler (${res?.cause || "no ruler"}). Another tool or symbiote may be using it.`, true);
    }
    const rulerId = typeof res === "string" ? res : res.id || res.rulerId;
    pending = { rulerId: String(rulerId), spell, area, startedAt: Date.now() };
    const how = area.shape === "cube"
      ? `place it centred where the ${area.size} ft cube goes, dragged out to the middle of a face (${area.size / 2} ft)`
      : area.shape === "cone"
        ? `drag it ${area.size} ft from you, angle about 53°`
        : area.shape === "line"
          ? `drag it ${area.size} ft along the line`
          : `drag it out to ${area.size} ft`;
    deps.toast?.(`${spell.name}: ${how}, then let go.`);
  }

  /** TaleSpire's rulers.onRulerEvent. Only the ruler this panel started is ours. */
  async function onRulerEvent(event) {
    if (event?.kind === "rulerRemoved" && pending && String(event.payload?.rulerId) === pending.rulerId) {
      pending = null;
      return;
    }
    if (event?.kind !== "rulerResult" || !pending) return;
    const ruler = event.payload?.ruler;
    if (!ruler || String(ruler.id) !== pending.rulerId) return;
    const job = pending;
    pending = null;
    const result = await check(job.area.shape, ruler, job);
    deps.onResult?.(result);
  }

  /** Check a placed ruler against every mini we can see. */
  async function check(shape, ruler, job, { hideHidden = false } = {}) {
    await loadUnits();
    let creatures = [];
    let source = "";
    try {
      ({ creatures, source } = await creatureSource());
    } catch (e) {
      console.warn("[Spirekeeper] zone creature list", e);
    }
    const area = job?.area || null;
    const r = area?.shape === "line" ? { ...ruler, widthTiles: 5 / units.perTile } : ruler;
    const inside = creatures
      .filter((c) => !(hideHidden && c.hidden))
      .filter((c) => contains(shape, r, c))
      .map((c) => ({ id: c.id, name: c.name, hidden: Boolean(c.hidden) }));
    const size = measured(shape, ruler);
    const expected = area?.size ?? null;
    return {
      rulerId: String(ruler.id),
      spell: job?.spell || null,
      area,
      shape,
      size,
      units: units.name,
      // A ruler more than half a tile off the spell's size is worth a warning
      offBy: expected != null && Math.abs(size - expected) > units.perTile / 2 ? size - expected : 0,
      inside,
      checked: creatures.length,
      source,
    };
  }

  return {
    configure, useCreatures, areaOf, describeArea, contains, measured, shapeOfRuler,
    cast, onRulerEvent, check, get pending() { return pending; },
    _setUnits: (u) => { units = u; },
  };
})();

if (typeof window !== "undefined") window.Zones = Zones;
