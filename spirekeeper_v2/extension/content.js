/**
 * Intercepting rolls on a D&D Beyond character sheet.
 *
 * Runs on every character page but does nothing until the player turns it on
 * from the popup. That default matters: D&D Beyond's own dice are perfectly
 * good, and an extension that silently hijacks every click on someone's sheet
 * is an extension they uninstall.
 *
 * When it is on, a capture-phase listener takes the click before D&D Beyond's
 * own handler sees it. Capture rather than bubble because these buttons open a
 * menu (`aria-haspopup="menu"`) — by the time a bubbling listener runs, the
 * menu is already opening.
 */
(() => {
  const SETTING = "interceptRolls";
  const state = { on: false };

  // --- telling the player what happened --------------------------------------

  let toastEl = null;
  let toastTimer = null;

  function toast(text, isError = false) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "spirekeeper-toast";
      Object.assign(toastEl.style, {
        position: "fixed",
        bottom: "18px",
        right: "18px",
        zIndex: "2147483647",
        padding: "9px 14px",
        borderRadius: "4px",
        font: "14px/1.4 'Segoe UI', system-ui, sans-serif",
        color: "#e8eaee",
        background: "#1b1d22",
        border: "1px solid #3a3f49",
        boxShadow: "0 6px 20px rgba(0,0,0,.45)",
        pointerEvents: "none",
        transition: "opacity .15s",
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.borderColor = isError ? "#d9534f" : "#c8873b";
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.opacity = "0"), 2200);
  }

  // --- the interception ------------------------------------------------------

  function onClick(event) {
    if (!state.on) return;

    const button = event.target?.closest?.(SpirekeeperRolls.HOOK);
    if (!button) return;

    const roll = SpirekeeperRolls.describe(button);
    if (!roll) {
      // Not something we understand. Leaving it to D&D Beyond is the honest
      // outcome — better their dice than a roll we guessed at — but say so,
      // because "nothing happened" is indistinguishable from a broken hook.
      console.log("[Spirekeeper] clicked a rollable this build doesn't recognise", button);
      return;
    }

    // Take the click before the menu opens.
    event.preventDefault();
    event.stopPropagation();

    try {
      SpirekeeperLink.sendRoll(roll);
      toast(`${roll.name || "Roll"} — ${roll.roll} → TaleSpire`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  document.addEventListener("click", onClick, true);

  // --- the toggle ------------------------------------------------------------

  function apply(on) {
    state.on = Boolean(on);
    document.documentElement.classList.toggle("spirekeeper-active", state.on);
  }

  chrome.storage?.local?.get(SETTING, (got) => {
    apply(got?.[SETTING]);
    console.log(`[Spirekeeper] interception ${state.on ? "ON" : "OFF"}`);
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && SETTING in changes) {
      apply(changes[SETTING].newValue);
      toast(changes[SETTING].newValue ? "Rolls now go to TaleSpire" : "Rolls back to D&D Beyond");
    }
  });

  /**
   * Report what we can see, once there is anything to see.
   *
   * D&D Beyond is a React app: at `document_idle` the sheet has not rendered
   * and the count is always zero. Reporting that reads as "the hook is broken"
   * when nothing is wrong — the click listener is delegated from `document`, so
   * buttons that appear later are caught regardless. Waiting for the first ones
   * to exist makes the line mean what it says.
   *
   * It gives up after ten seconds rather than watching forever, because a sheet
   * that never renders is worth reporting too.
   */
  function reportWhenReady() {
    const started = Date.now();

    const report = (count) =>
      console.log(
        `[Spirekeeper] content script ready — ${count} rollable buttons, ` +
          `interception ${state.on ? "ON" : "OFF"}` +
          (count === 0 ? " (sheet may still be loading; clicks are caught either way)" : "")
      );

    const tick = () => {
      const count = SpirekeeperRolls.all().length;
      if (count > 0) return report(count);
      if (Date.now() - started > 10000) return report(0);
      setTimeout(tick, 400);
    };
    tick();
  }

  reportWhenReady();
})();
