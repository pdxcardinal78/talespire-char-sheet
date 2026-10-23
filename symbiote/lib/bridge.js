/**
 * The Spirekeeper bridge: an optional BepInEx plugin that lets this panel
 * write to the board (plugin/ in this repo).
 *
 * A Symbiote can read minis but never change them. When the GM's TaleSpire is
 * running the bridge, the panel can set a mini's hit points through it; the
 * change syncs to every client, plugin or not. Without the bridge everything
 * here reports "unavailable" and the panel behaves exactly as it did before:
 * the board stays read-only and the panel keeps its own counts.
 *
 * Only a GM's writes are accepted (the plugin checks), so `canWrite` is false
 * for players even if they happen to have the plugin installed.
 */

const Bridge = (() => {
  const BASE = "http://127.0.0.1:47817";
  const PROBE_TIMEOUT_MS = 800;
  const RETRY_MS = 30000;

  let status = { available: false, canGm: false, version: null, checkedAt: 0 };
  let listeners = [];
  let retryTimer = null;

  // Swappable so browser dev mode can fake the plugin (see app.js)
  let transport = async (method, path, params) => {
    const qs = params ? `?${new URLSearchParams(params)}` : "";
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS * 4) : null;
    try {
      const url = `${BASE}${path}${qs}`; // absolute: the plugin, not this panel's origin
      const res = await fetch(url, { method, signal: ctl?.signal });
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  function useTransport(fn) {
    transport = fn;
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  function set(next) {
    const changed = next.available !== status.available || next.canGm !== status.canGm;
    status = { ...next, checkedAt: Date.now() };
    if (changed) for (const fn of listeners) fn(status);
  }

  /**
   * Is the plugin there, and is this client a GM? Cheap enough to call on
   * boot and whenever a GM view opens. While it's missing, check again every
   * 30 seconds, so starting TaleSpire through BepInEx mid-session is noticed.
   */
  async function probe() {
    clearTimeout(retryTimer);
    try {
      const ping = await Promise.race([
        transport("GET", "/ping"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS)),
      ]);
      if (!ping?.ok) throw new Error(ping?.error || "no answer");
      const who = await transport("GET", "/whoami");
      set({ available: true, canGm: Boolean(who?.ok && who.canGm), version: ping.version || null });
      // Refused rather than answered (for example, asked before TaleSpire's
      // panel server was up): ask again later instead of giving up for good
      if (!who?.ok) {
        console.warn("[Spirekeeper] bridge refused /whoami:", who?.error);
        retryTimer = setTimeout(probe, RETRY_MS);
      }
    } catch {
      set({ available: false, canGm: false, version: null });
      retryTimer = setTimeout(probe, RETRY_MS);
    }
    return status;
  }

  const canWrite = () => status.available && status.canGm;

  /**
   * Set a mini's hit points on the board. `max` is optional; pass it when the
   * mini has none yet, so the board gains a proper bar rather than 12/0.
   * Resolves to { ok, error }; never throws, because a failed write should
   * fall back to the panel's own count rather than break the view.
   */
  /**
   * Board writes are reported to a listener with the values they replaced, so
   * the panel can undo them (see History in app.js). `before(id)` reads a mini
   * just before it's written; `after(record)` hears about each write that
   * succeeded. An undo's own writes pass { quiet: true }.
   */
  let writeHook = null;
  function onWrite(hook) {
    writeHook = hook;
  }
  async function readBefore(creatureId, quiet) {
    if (quiet || !writeHook?.before) return null;
    try {
      return await writeHook.before(creatureId);
    } catch {
      return null;
    }
  }

  async function setHp(creatureId, value, max, { quiet = false } = {}) {
    if (!canWrite()) return { ok: false, error: "bridge unavailable" };
    const params = { id: creatureId, value: String(Math.round(value)) };
    if (Number.isFinite(max) && max > 0) params.max = String(Math.round(max));
    try {
      const prior = await readBefore(creatureId, quiet);
      const r = await transport("POST", "/hp", params);
      if (r?.ok && !quiet && prior?.hp) {
        writeHook?.after?.({ kind: "hp", id: creatureId, name: prior.name, before: { value: prior.hp.value, max: prior.hp.max }, after: { value: Math.round(value), max: params.max ? Number(params.max) : prior.hp.max } });
      }
      return r?.ok ? { ok: true } : { ok: false, error: r?.error || "write refused" };
    } catch (e) {
      // The plugin went away mid-session (TaleSpire restarted without it)
      set({ available: false, canGm: false, version: null });
      retryTimer = setTimeout(probe, RETRY_MS);
      return { ok: false, error: "bridge unreachable" };
    }
  }

  /**
   * Set one of the campaign's eight named stats (index 0 to 7) on a mini.
   * Used for a "Temp HP" stat; the index comes from matching stat names, and
   * the panel never renames stats.
   */
  async function setStat(creatureId, index, value, max, { quiet = false } = {}) {
    if (!canWrite()) return { ok: false, error: "bridge unavailable" };
    const params = { id: creatureId, index: String(index), value: String(Math.round(value)) };
    if (Number.isFinite(max)) params.max = String(Math.round(max));
    try {
      const prior = await readBefore(creatureId, quiet);
      const r = await transport("POST", "/stat", params);
      const was = prior?.stats?.[index];
      if (r?.ok && !quiet && was) {
        writeHook?.after?.({ kind: "stat", id: creatureId, name: prior.name, index, statName: was.name, before: { value: was.value, max: was.max }, after: { value: Math.round(value), max: Number(params.max ?? was.max) } });
      }
      return r?.ok ? { ok: true } : { ok: false, error: r?.error || "write refused" };
    } catch {
      set({ available: false, canGm: false, version: null });
      retryTimer = setTimeout(probe, RETRY_MS);
      return { ok: false, error: "bridge unreachable" };
    }
  }

  /** Add (on) or remove a persistent emote, TaleSpire's mini status, on a mini. */
  async function setEmote(creatureId, emoteId, on) {
    if (!canWrite()) return { ok: false, error: "bridge unavailable" };
    try {
      const r = await transport("POST", "/emote", { id: creatureId, emote: emoteId, on: on ? "1" : "0" });
      return r?.ok ? { ok: true } : { ok: false, error: r?.error || "write refused" };
    } catch {
      set({ available: false, canGm: false, version: null });
      retryTimer = setTimeout(probe, RETRY_MS);
      return { ok: false, error: "bridge unreachable" };
    }
  }

  /** TaleSpire's statuses by name: [{ id, name, icon }]. A read, so any panel may ask. */
  async function statuses() {
    if (!status.available) return null;
    try {
      const r = await transport("GET", "/statuses");
      return r?.ok ? r.statuses || [] : null;
    } catch {
      return null;
    }
  }

  /** Every mini on the board with position and size, for spell zones. GM's machine only. */
  async function creatures() {
    if (!status.available) return null;
    try {
      const r = await transport("GET", "/creatures");
      return r?.ok ? r.creatures || [] : null;
    } catch {
      return null;
    }
  }

  /** Open TaleSpire's ruler as sphere, line, cone or box (the API has no box). Returns { ok, id }. */
  async function startRuler(kind) {
    if (!canWrite()) return { ok: false, error: "bridge unavailable" };
    try {
      const r = await transport("POST", "/ruler", { kind });
      return r?.ok ? { ok: true, id: r.id } : { ok: false, error: r?.error || "refused (the plugin may be older than 0.5.0)" };
    } catch {
      return { ok: false, error: "bridge unreachable" };
    }
  }

  /** A ruler's kind, whether it's being dragged, and its handles; { gone: true } once put away. */
  async function rulerInfo(rulerId) {
    if (!status.available) return null;
    try {
      const r = await transport("GET", "/ruler-info", { id: String(rulerId) });
      if (!r?.ok) return null;
      return r.gone ? { gone: true } : { kind: r.kind, editing: Boolean(r.editing), handles: r.handles || [] };
    } catch {
      return null;
    }
  }

  /**
   * A kept zone's current shape: { kind, handles: [{x,y,z}], name }, { gone: true }
   * once it's been removed, or null when the bridge can't say (pre-0.4.3).
   */
  async function zoneInfo(zoneId) {
    if (!status.available || !zoneId) return null;
    try {
      const r = await transport("GET", "/zone-info", { id: zoneId });
      if (!r?.ok) return null;
      return r.gone ? { gone: true } : { kind: r.kind, handles: r.handles || [], name: r.name };
    } catch {
      return null;
    }
  }

  /**
   * Keep a zone on the board. `geometry` ({ kind, handles }) lets the plugin
   * build the marker if the ruler has already been put away.
   */
  async function keepZone(rulerId, name, geometry) {
    if (!canWrite()) return { ok: false, error: "bridge unavailable" };
    try {
      const params = { ruler: String(rulerId), name: String(name || "").slice(0, 50) };
      if (geometry?.kind && geometry?.handles) Object.assign(params, { kind: geometry.kind, handles: geometry.handles });
      const r = await transport("POST", "/zone", params);
      if (r?.ok && !r.from) {
        // Bridge 0.4.0 and 0.4.1 answer ok but TaleSpire drops the marker
        return { ok: false, error: `the bridge plugin running in TaleSpire is ${status.version || "older than 0.4.2"} and can't keep zones. Quit TaleSpire, run plugin/install-mac.sh, and relaunch` };
      }
      return r?.ok ? { ok: true, id: r.id, from: r.from } : { ok: false, error: r?.error || "refused" };
    } catch {
      return { ok: false, error: "bridge unreachable" };
    }
  }

  async function removeZone(zoneId) {
    if (!canWrite()) return { ok: false, error: "bridge unavailable" };
    try {
      const r = await transport("POST", "/zone-remove", { id: zoneId });
      return r?.ok ? { ok: true } : { ok: false, error: r?.error || "refused" };
    } catch {
      return { ok: false, error: "bridge unreachable" };
    }
  }

  return {
    probe, canWrite, setHp, setStat, onWrite, setEmote, statuses, creatures, keepZone, removeZone, zoneInfo, startRuler, rulerInfo, onChange, useTransport,
    get status() { return status; },
  };
})();

if (typeof window !== "undefined") window.Bridge = Bridge;
