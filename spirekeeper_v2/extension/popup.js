/**
 * The importer popup.
 *
 * Opens, works out which character is on screen, fetches it, and waits for one
 * click to put it on the clipboard. The fetch happens on open rather than on
 * the click for two reasons: it lets the popup show *which* character it got
 * before anyone switches applications, and it keeps the clipboard write in a
 * direct response to a click, which is where browsers want it.
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const state = { payload: null };

  function status(text, isError = false) {
    const el = $("status");
    el.textContent = text;
    el.classList.toggle("is-error", isError);
    $("state").classList.remove("hidden");
    $("found").classList.add("hidden");
  }

  function show({ summary, usedSession }) {
    $("char-name").textContent = summary.name;
    $("char-line").textContent = `${summary.line} · level ${summary.level}`;
    $("hint").textContent = usedSession
      ? "Read using your signed-in session."
      : "Read as a public character.";
    $("state").classList.add("hidden");
    $("found").classList.remove("hidden");
  }

  async function activeTabUrl() {
    // Without this guard a missing API surfaces as "Cannot read properties of
    // undefined", which tells a user nothing about what to do.
    if (typeof chrome === "undefined" || !chrome.tabs?.query) {
      throw new Error("Extension APIs unavailable — open this from the toolbar button.");
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url || "";
  }

  async function copy() {
    const button = $("copy");
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.payload));
    } catch (e) {
      $("hint").textContent = `Could not reach the clipboard: ${e.message}`;
      return;
    }

    const kb = Math.round(JSON.stringify(state.payload).length / 1024);
    button.textContent = `Copied — ${kb} KB`;
    button.classList.add("is-done");
    button.disabled = true;
    $("hint").textContent = "Now paste it into Spirekeeper's import box.";
  }

  const SETTING = "interceptRolls";

  /**
   * The roll toggle.
   *
   * Stored rather than held in the popup, because the popup is destroyed every
   * time it closes and the content script needs the answer long after that.
   */
  async function wireToggle(onCharacterPage) {
    const box = $("intercept");
    const hint = $("intercept-hint");

    const got = await chrome.storage.local.get(SETTING);
    box.checked = Boolean(got?.[SETTING]);

    box.onchange = async () => {
      await chrome.storage.local.set({ [SETTING]: box.checked });
      hint.textContent = box.checked
        ? "Clicking a roll on this sheet throws it in TaleSpire."
        : "Rolls stay on D&D Beyond.";
    };

    if (!onCharacterPage) {
      hint.textContent = "Open a character sheet for this to do anything.";
    }
    // Default off, and it stays off unless someone deliberately turns it on:
    // the feature is complete but its delivery path is unavailable.

  }

  async function boot() {
    try {
      const url = await activeTabUrl();
      // The toggle is wired either way — it is a standing preference, not
      // something that only applies to the page currently open.
      await wireToggle(Boolean(DDB.idFromUrl(url)));

      if (!DDB.idFromUrl(url)) {
        status("Open a D&D Beyond character page, then click here again.");
        return;
      }

      status("Fetching from D&D Beyond…");
      const result = await DDB.grab(url);
      state.payload = result.payload;
      show(result);
      $("copy").onclick = copy;
    } catch (e) {
      status(e.message, true);
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
