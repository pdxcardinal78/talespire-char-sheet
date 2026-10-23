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

  // Spells whose bundled SRD text lost the sentence with their size
  const KNOWN_AREAS = {
    moonbeam: { shape: "sphere", size: 5 },
  };

  // Spells that mention a shape without having an area to place: a portion
  // of a target, a wall's panels, a light radius
  const NOT_AREAS = new Set([
    "disintegrate", "wall of ice", "wall of force", "wall of fire", "wall of stone",
    "flaming sphere", "dancing lights", "forcecage", "private sanctum",
  ]);

  const U = "(?:feet|foot|ft\\.?)";
  // Most specific first; each pattern is tried against all of a spell's text
  // before the next, so a description's "100-foot-long, 5-foot-wide Line"
  // beats a data field that recorded only the 5
  const PATTERNS = [
    // "a 100-foot-long, 5-foot-wide Line"
    [new RegExp(`(\\d+)[\\s-]*${U}[\\s-]*long\\b[^.]{0,20}?(\\d+)[\\s-]*${U}[\\s-]*wide\\b[^.]{0,12}?\\bline\\b`, "i"), (m) => ["line", m[1], m[2]]],
    // "a 5-foot-wide, 60-foot-long Line"
    [new RegExp(`(\\d+)[\\s-]*${U}[\\s-]*wide\\b[^.]{0,20}?(\\d+)[\\s-]*${U}[\\s-]*long\\b[^.]{0,12}?\\bline\\b`, "i"), (m) => ["line", m[2], m[1]]],
    // "a Line 60 feet long and 10 feet wide"
    [new RegExp(`\\bline\\b[^.]{0,20}?(\\d+)[\\s-]*${U}[\\s-]*long\\b(?:[^.]{0,20}?(\\d+)[\\s-]*${U}[\\s-]*wide)?`, "i"), (m) => ["line", m[1], m[2]]],
    // "20-foot-radius Sphere", "10-foot-radius, 40-foot-high Cylinder", "50-foot-radius, 100 foot high Cylinder"
    [/(\d+)-foot[- ]radius(?:,?\s*\d+[- ]?foot[- ]?(?:high|tall))?,?\s+(sphere|cylinder|emanation|circle)\b/i, (m) => [m[2], m[1]]],
    // "20 ft. Sphere", "20 feet sphere", "a 15-foot Emanation", "a 15-foot Cone", "a 10-foot Cube"
    [new RegExp(`(\\d+)[\\s-]*${U}\\s*-?\\s*(sphere|cylinder|emanation|cone|line|cube|square|circle)\\b`, "i"), (m) => [m[2], m[1]]],
    // "a Cylinder that is 10 feet tall with a 60-foot radius"
    [/\b(cylinder|sphere)\b[^.]{0,40}?(\d+)-foot[- ]radius/i, (m) => [m[1], m[2]]],
  ];

  /**
   * A spell's area from what the sheet has: D&D Beyond's "20 ft. Sphere", the
   * SRD's shape and size, or the description's wording. Returns
   * { shape, size, width? } in feet, or null. Light radii ("sheds Bright Light
   * in a 20-foot radius") don't match: every pattern needs a shape word.
   */
  function areaOf(spell) {
    const name = String(spell?.name || "").trim().toLowerCase();
    if (NOT_AREAS.has(name)) return null;
    const texts = [spell?.description, spell?.desc, spell?.aoe].filter(Boolean).map(String);
    for (const [re, parts] of PATTERNS) {
      for (const t of texts) {
        const m = re.exec(t);
        if (!m) continue;
        const [word, size, width] = parts(m);
        const shape = SHAPES[String(word).toLowerCase()];
        if (shape) return { shape, size: parseInt(size, 10), ...(width ? { width: parseInt(width, 10) } : {}) };
      }
    }
    return KNOWN_AREAS[name] || null;
  }

  const describeArea = (a) => (a ? `${a.size} ft ${a.shape}${a.width ? `, ${a.width} ft wide` : ""}` : "");

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

  /**
   * TaleSpire's rulers.onRulerEvent. Only the ruler this panel started is ours,
   * and it stays ours until it's put away or the card is closed: TaleSpire
   * sends a fresh rulerResult every time a handle is let go, so moving the
   * ruler re-checks who's inside. 0.17.1 stopped listening after the first.
   */
  let seq = 0;
  async function onRulerEvent(event) {
    if (event?.kind === "rulerRemoved") {
      if (pending && String(event.payload?.rulerId) === pending.rulerId) {
        pending = null;
        deps.onRulerGone?.(String(event.payload.rulerId));
      }
      return;
    }
    if (event?.kind !== "rulerResult" || !pending) return;
    const ruler = event.payload?.ruler;
    if (!ruler || String(ruler.id) !== pending.rulerId || ruler.beingEdited) return;
    const job = pending;
    const mine = ++seq;
    const result = await check(job.area.shape, ruler, job);
    if (mine !== seq || pending !== job) return; // a newer move, or put away meanwhile
    result.moved = Boolean(job.placed);
    job.placed = true;
    deps.onResult?.(result);
  }

  /**
   * A kept marker's handles (GET /zone-info) as the ruler payload check()
   * takes. A cone's third handle holds half its angle in x.
   */
  function rulerFromMarker(info, id) {
    const h = info?.handles || [];
    if (info?.kind === "line") return h.length >= 2 ? { id, positions: h } : null;
    if (h.length < 2) return null;
    if (info?.kind === "cone") return h.length >= 3 ? { id, startPosition: h[0], endPosition: h[1], angle: h[2].x * 2 } : null;
    return { id, startPosition: h[0], endPosition: h[1] };
  }

  /** Stop following the ruler (the card was closed). */
  function release(rulerId) {
    if (pending && (!rulerId || pending.rulerId === String(rulerId))) pending = null;
  }

  /**
   * The ruler as TaleSpire's area-marker handles, so the GM's plugin can keep
   * the zone even if the ruler itself has been put away: a sphere is centre
   * and edge, a line its points, and a cone start, end and a third handle
   * whose x is half the angle in degrees (the API reports the full angle).
   * A cube is placed with the sphere ruler, so it's kept as that sphere.
   */
  function geometryOf(shape, ruler) {
    const fmt = (p) => [p.x, p.y, p.z].map((n) => Math.round(n * 1000) / 1000).join(",");
    if (shape === "line") {
      const pts = ruler.positions || [];
      return pts.length >= 2 && pts.length <= 10 ? { kind: "line", handles: pts.map(fmt).join(";") } : null;
    }
    if (!ruler.startPosition || !ruler.endPosition) return null;
    if (shape === "cone") {
      const half = (ruler.angle || 53.13) / 2;
      return { kind: "cone", handles: [fmt(ruler.startPosition), fmt(ruler.endPosition), `${Math.round(half * 1000) / 1000},0,0`].join(";") };
    }
    return { kind: "sphere", handles: [fmt(ruler.startPosition), fmt(ruler.endPosition)].join(";") };
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
    const r = area?.shape === "line" ? { ...ruler, widthTiles: (area.width || 5) / units.perTile } : ruler;
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
      geometry: geometryOf(shape, ruler),
      ruler,
    };
  }

  return {
    configure, useCreatures, areaOf, describeArea, contains, measured, shapeOfRuler,
    cast, onRulerEvent, release, geometryOf, rulerFromMarker, check, get pending() { return pending; },
    _setUnits: (u) => { units = u; },
  };
})();

if (typeof window !== "undefined") window.Zones = Zones;
