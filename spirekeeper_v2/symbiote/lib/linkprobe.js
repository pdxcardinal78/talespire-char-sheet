/**
 * Link probe — scaffolding, not a feature.
 *
 * This exists to answer one question before any browser-extension work starts:
 * can an outside program hand work to this Symbiote by opening a
 * `talespire://symbiote/<interopId>/<payload>` URL, and how much payload fits?
 *
 * The API docs say such a URL is delivered to `urls.onUrlMessage`, and that a
 * Symbiote which isn't running "will be loaded and then receives the message".
 * If both hold, an extension on D&D Beyond could drive the panel directly —
 * rolls arrive as our own code rather than as raw dice, so advantage, chat
 * attribution and the GM's damage inbox all keep working. None of that is worth
 * building on until delivery is proven in the actual game.
 *
 * Two paths are tested because they can fail independently:
 *
 *   in-game   TS.urls.submit() from inside the panel. Proves the mechanism and
 *             the API's own length handling.
 *   external  a URL opened from a browser, which is the path an extension would
 *             really take: Chrome -> OS protocol handler -> TaleSpire -> panel.
 *             The ceiling here is the OS's, and is usually the lower of the two.
 *
 * Delete this file, its script tag, the `urls` subscription and the
 * `onUrlMessage` global when the question is answered.
 */
const LinkProbe = (() => {
  // Ladder steps in payload characters. Windows caps some protocol handlers
  // near 2 KB and macOS is more generous, so the interesting range is wide.
  const LADDER = [64, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];

  // The log outlives the panel on purpose.
  //
  // The most important case is the coldest one: TaleSpire shut, a URL opened
  // from a browser, the game and then the panel launched to receive it. An
  // in-memory log is empty by the time anyone can read it, so a message that
  // did arrive looks exactly like one that never came. Persisting it is the
  // difference between measuring the cold path and guessing at it.
  const LOG_KEY = "spirekeeper2:probe-log";

  const state = {
    prefix: null,
    log: [],          // newest first
    pending: new Map(), // probe id -> { chars, at, via, settle }
    running: false,
  };

  try {
    state.log = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
  } catch {
    state.log = [];
  }

  let deps = { host: null, onUpdate: () => {} };

  /**
   * Timestamps carry the date once the log outlives the day it was written.
   *
   * A persisted log is read days later, and a bare clock time from a previous
   * session reads exactly like a message that just landed — which is the one
   * misreading that would turn this probe's answer upside down.
   */
  function stamp(iso) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString();
    const today = new Date().toDateString() === d.toDateString();
    return today ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
  }

  function note(kind, text, detail) {
    state.log.unshift({ kind, text, detail: detail || null, iso: new Date().toISOString() });
    state.log.length = Math.min(state.log.length, 40);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(state.log));
    } catch {
      // A full or unavailable store must not take the probe down with it.
    }
    deps.onUpdate();
  }

  /**
   * A payload big enough to measure but cheap to verify.
   *
   * Filler is a repeating pattern rather than random so a truncated arrival is
   * obvious on sight, and the length travels inside the message — comparing it
   * against what actually lands is how truncation is caught as distinct from
   * outright non-delivery.
   */
  function makePayload(id, chars) {
    const head = `${id}:${chars}:`;
    const filler = "abcdefghij".repeat(Math.ceil(Math.max(0, chars - head.length) / 10));
    return (head + filler).slice(0, Math.max(head.length, chars));
  }

  // Ids are base36, so letters as well as digits — an id pattern of `p\d+` here
  // silently classified every arrival as "not a probe payload" and reported a
  // working mechanism as broken.
  const parse = (payload) => {
    const m = /^(p[a-z0-9]+):(\d+):/.exec(payload || "");
    return m ? { id: m[1], claimed: parseInt(m[2], 10) } : null;
  };

  async function readPrefix() {
    if (!window.TS?.urls?.createUrlPrefixForThisSymbiote) {
      note("fail", "TS.urls is not available — is the API version too old?");
      return null;
    }
    const prefix = await TS.urls.createUrlPrefixForThisSymbiote();
    if (prefix && prefix.cause !== undefined) {
      note("fail", `createUrlPrefixForThisSymbiote failed: ${prefix.cause}`);
      return null;
    }
    state.prefix = prefix;
    deps.onUpdate();
    return prefix;
  }

  /**
   * Pull our payload out of whatever shape the event actually has.
   *
   * The first run of this probe reported "0 chars" on messages that had plainly
   * arrived, because the handler guessed at the field name and guessed wrong.
   * Rather than guess again, walk the event and take the string that looks like
   * a probe payload; failing that, the longest string present. The shape is
   * logged alongside so the real field name stops being a mystery.
   */
  const PROBE_RE = /^p[a-z0-9]+:\d+:/;

  /**
   * TaleSpire hands over the raw URL segment, still percent-encoded.
   *
   * A payload sent as `p123:512:abc…` arrives as `p123%3A512%3Aabc…` — four
   * characters longer, and unrecognisable to a parser expecting colons. Decode
   * before doing anything else, so what is compared against the claimed length
   * is what was actually sent.
   */
  function decode(text) {
    if (typeof text !== "string" || !text.includes("%")) return text;
    try {
      return decodeURIComponent(text);
    } catch {
      return text; // malformed escapes are themselves worth seeing
    }
  }

  function extract(event) {
    const strings = [];
    const seen = new Set();

    // `kind` is the event discriminator, never the payload — without skipping it
    // an event carrying nothing reports its own kind as a short message, which
    // reads as a delivered payload rather than an empty one.
    (function walk(node, depth) {
      if (node == null || depth > 4) return;
      if (typeof node === "string") return void strings.push(node);
      if (typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      for (const [k, v] of Object.entries(node)) {
        if (k === "kind") continue;
        walk(v, depth + 1);
      }
    })(event, 0);

    const decoded = strings.map(decode);
    const tagged = decoded.find((t) => PROBE_RE.test(t));
    if (tagged) return tagged;
    return decoded.sort((a, b) => b.length - a.length)[0] || "";
  }

  /** A compact description of the event, for when extraction comes up empty. */
  function describeShape(event, depth = 0) {
    if (event == null) return String(event);
    if (typeof event === "string") return `string(${event.length})`;
    if (typeof event !== "object") return typeof event;
    if (depth > 2) return "…";
    if (Array.isArray(event)) return `[${event.map((v) => describeShape(v, depth + 1)).join(", ")}]`;
    return `{${Object.entries(event)
      .map(([k, v]) => `${k}: ${describeShape(v, depth + 1)}`)
      .join(", ")}}`;
  }

  /** Called from the global onUrlMessage handler with the whole event. */
  function received(event) {
    const payload = extract(event);
    const text = String(payload ?? "");

    if (!text) {
      // Arrival with nothing usable in it — the shape is the finding.
      note("warn", "Message arrived but no payload was found in it", describeShape(event));
      return;
    }

    const info = parse(text);

    if (!info) {
      note("in", `Message received — ${text.length} chars, not a probe payload`, text.slice(0, 160));
      return;
    }

    const sent = state.pending.get(info.id);
    state.pending.delete(info.id);

    const intact = text.length === info.claimed;
    const ms = sent ? Date.now() - sent.at : null;

    note(
      intact ? "ok" : "warn",
      intact
        ? `${info.claimed} chars arrived intact${ms == null ? "" : ` in ${ms} ms`}`
        : `${info.claimed} chars sent, ${text.length} arrived — TRUNCATED`,
      sent ? `via ${sent.via}` : "via an external link"
    );

    // A truncated arrival is still a failure: it means the ceiling is below this
    // size and silently corrupting, which is worse than dropping.
    sent?.settle?.(intact);
  }

  /** Fire one probe URL through the API and wait for it to come back. */
  async function submit(chars, via = "TS.urls.submit") {
    const prefix = state.prefix || (await readPrefix());
    if (!prefix) return false;

    const id = `p${Date.now().toString(36)}${Math.floor(performance.now()) % 1000}`;
    const payload = makePayload(id, chars);
    const url = prefix + encodeURIComponent(payload);

    // Delivery is asynchronous, so the verdict is settled by received().
    let settle;
    const arrived = new Promise((resolve) => (settle = resolve));
    state.pending.set(id, { at: Date.now(), chars, via, urlChars: url.length, settle });
    note("out", `Sending ${chars} chars (URL ${url.length})`, via);

    try {
      const res = await TS.urls.submit(url);
      if (res && res.cause !== undefined) {
        state.pending.delete(id);
        note("fail", refusal(res.cause, chars, url.length));
        return false;
      }
    } catch (e) {
      state.pending.delete(id);
      note("fail", refusal(e.message, chars, url.length));
      return false;
    }

    // A URL that is simply too long tends to be dropped without a word rather
    // than refused, so silence is itself the failure signal.
    const verdict = await Promise.race([
      arrived,
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);

    if (verdict === null) {
      state.pending.delete(id);
      note("fail", `${chars} chars never arrived — past the limit`);
      return false;
    }
    return verdict;
  }

  /** `urlRejected` is TaleSpire saying the URL was too long — say so plainly. */
  const refusal = (cause, chars, urlChars) =>
    /urlRejected/i.test(String(cause))
      ? `${chars} chars refused — URL of ${urlChars} is over TaleSpire's limit`
      : `submit failed at ${chars} chars: ${cause}`;

  /**
   * Narrow the gap between the last size that worked and the first that didn't.
   *
   * The ladder doubles, so on its own it can report a ceiling up to half the
   * real one — the difference between "a character needs 26 messages" and "13".
   * A few extra probes buy a number worth designing against.
   */
  async function refine(low, high) {
    let lo = low;
    let hi = high;
    while (hi - lo > 64) {
      const mid = Math.floor((lo + hi) / 2);
      if (await submit(mid, "refining")) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Walk the ladder until something fails; the last success is the ceiling. */
  async function runLadder() {
    if (state.running) return;
    state.running = true;
    deps.onUpdate();

    let best = 0;
    let failed = 0;
    for (const chars of LADDER) {
      const ok = await submit(chars);
      if (!ok) {
        failed = chars;
        break;
      }
      best = chars;
    }

    // The doubling ladder brackets the limit; this finds it.
    if (best && failed) {
      note("note", `Narrowing between ${best} and ${failed}…`);
      best = await refine(best, failed);
    }

    const urlAt = (chars) =>
      (state.prefix?.length || 0) + encodeURIComponent(makePayload("p0", chars)).length;

    note(
      best ? "ok" : "fail",
      best
        ? `Ceiling: ${best} payload chars (URL about ${urlAt(best)}).`
        : "Nothing got through — the mechanism is not working here."
    );

    if (best) {
      // Percent-encoding is what makes this worth stating: our probe payload
      // carries colons that trip to %3A, while base64url travels unescaped and
      // so fits far more real data into the same URL.
      const perMessage = Math.floor((best * 3) / 4); // base64url -> bytes
      note(
        "note",
        `One roll (~130 chars) fits easily. Using base64url that is ~${perMessage} bytes per message, ` +
          `so a 19 KB compacted character needs ${Math.ceil((19 * 1024) / perMessage)}.`
      );
    }

    state.running = false;
    deps.onUpdate();
  }

  /**
   * Put a probe URL on the clipboard for the browser test.
   *
   * This is the path that actually matters: an extension cannot call
   * TS.urls.submit, it can only ask the OS to open a URL. That hop has its own
   * limit and its own failure modes, and the panel may not even be open when it
   * lands — which is the other half of what we're checking.
   */
  async function copyExternal(chars) {
    const prefix = state.prefix || (await readPrefix());
    if (!prefix) return;

    const id = `p${Date.now().toString(36)}${Math.floor(performance.now()) % 1000}`;
    const url = prefix + encodeURIComponent(makePayload(id, chars));
    state.pending.set(id, { at: Date.now(), chars, via: "external link" });

    try {
      if (window.TS?.system?.clipboard) await TS.system.clipboard.setText(url);
      else await navigator.clipboard.writeText(url);
      note(
        "out",
        `Test URL copied (${url.length} chars). Paste it into a browser address bar, then come back here.`
      );
    } catch (e) {
      note("fail", `Could not copy: ${e.message}`);
    }
  }

  // --- rendering ------------------------------------------------------------

  function render() {
    const host = deps.host;
    if (!host) return;
    host.replaceChildren();

    const how = document.createElement("p");
    how.className = "hint";
    how.innerHTML =
      "<b>Run length ladder</b> tests delivery inside the game and finds the size limit. " +
      "<b>Copy test URL</b> puts a link on your clipboard — paste it into a browser " +
      "address bar to test the path a browser extension would really take. " +
      "Come back here afterwards: an arrival shows as a green line.";
    host.appendChild(how);

    const prefix = document.createElement("p");
    prefix.className = "hint dimmed";
    prefix.textContent = state.prefix
      ? `Prefix (not a test on its own — it carries no payload): ${state.prefix}`
      : "Prefix not read yet — run a test to fetch it.";
    host.appendChild(prefix);

    const row = document.createElement("div");
    row.className = "row";

    const ladder = document.createElement("button");
    ladder.className = "btn btn-small btn-primary";
    ladder.textContent = state.running ? "Running…" : "Run length ladder";
    ladder.disabled = state.running;
    ladder.onclick = runLadder;
    row.appendChild(ladder);

    for (const chars of [512, 2048]) {
      const b = document.createElement("button");
      b.className = "btn btn-small";
      b.textContent = `Copy test URL (${chars} chars)`;
      b.title = "Paste this into a browser address bar, then come back and check the log";
      b.onclick = () => copyExternal(chars);
      row.appendChild(b);
    }

    const clear = document.createElement("button");
    clear.className = "btn btn-small btn-ghost";
    clear.textContent = "Clear";
    clear.onclick = () => {
      state.log = [];
      try {
        localStorage.removeItem(LOG_KEY);
      } catch {}
      render();
    };
    row.appendChild(clear);

    host.appendChild(row);

    const list = document.createElement("div");
    list.className = "probe-log";
    for (const entry of state.log) {
      const line = document.createElement("div");
      line.className = `probe-line probe-${entry.kind}`;
      // `at` is the pre-0.10.3 field; a stored log shouldn't render as undefined.
      const when = entry.iso ? stamp(entry.iso) : entry.at || "";
      line.textContent = `${when}  ${entry.text}${entry.detail ? `  (${entry.detail})` : ""}`;
      list.appendChild(line);
    }
    host.appendChild(list);
  }

  function configure(next) {
    deps = { ...deps, ...next };
    deps.onUpdate = render;
    render();
  }

  return { configure, received, note, readPrefix, runLadder, copyExternal, render, state };
})();

if (typeof window !== "undefined") window.LinkProbe = LinkProbe;
