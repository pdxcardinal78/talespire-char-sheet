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
  async function setHp(creatureId, value, max) {
    if (!canWrite()) return { ok: false, error: "bridge unavailable" };
    const params = { id: creatureId, value: String(Math.round(value)) };
    if (Number.isFinite(max) && max > 0) params.max = String(Math.round(max));
    try {
      const r = await transport("POST", "/hp", params);
      return r?.ok ? { ok: true } : { ok: false, error: r?.error || "write refused" };
    } catch (e) {
      // The plugin went away mid-session (TaleSpire restarted without it)
      set({ available: false, canGm: false, version: null });
      retryTimer = setTimeout(probe, RETRY_MS);
      return { ok: false, error: "bridge unreachable" };
    }
  }

  return {
    probe, canWrite, setHp, onChange, useTransport,
    get status() { return status; },
  };
})();

if (typeof window !== "undefined") window.Bridge = Bridge;
