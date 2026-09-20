/**
 * Sending a message from the browser to Spirekeeper's panel in TaleSpire.
 *
 * TaleSpire registers a `talespire://` protocol handler, and a URL addressed to
 * a Symbiote's interop id is delivered to its `onUrlMessage`. The link probe
 * measured what that path can carry, in the game, on a real machine:
 *
 *   - a browser-opened URL reaches the panel, and cold-launches TaleSpire if
 *     it is not running
 *   - the ceiling is 1984 payload characters; past it TaleSpire answers
 *     `urlRejected` rather than dropping the message silently
 *   - the payload arrives **still percent-encoded**
 *
 * A roll costs about 130 characters, so rolling has room to spare. Importing a
 * whole character does not, which is why that goes via the clipboard instead.
 */
const Link = (() => {
  // Spirekeeper v2's interop id, from its manifest. The shipping mod has a
  // different one on purpose, so messages meant for the work-in-progress build
  // cannot reach the one someone is playing with.
  const INTEROP_ID = "2f7d6457-3438-489a-a959-6283a8f40dd5";
  const PREFIX = `talespire://symbiote/${INTEROP_ID}/`;

  // Measured, not assumed. Kept a little under the real ceiling so a long
  // weapon name can never push a message over it.
  const MAX_PAYLOAD = 1900;

  /**
   * base64url, not base64.
   *
   * Standard base64's `+` and `/` are both hostile here: `/` splits the URL
   * path, so a payload containing one arrives truncated at the slash. The
   * base64url alphabet travels through a URL untouched, and skipping `=`
   * padding buys back a few characters.
   */
  function encode(obj) {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** The message the panel expects. Short keys: every character is budget. */
  function rollMessage(roll) {
    return {
      v: 1,
      t: "roll",
      k: roll.kind,
      n: (roll.name || "Roll").slice(0, 60),
      r: roll.roll,
      d: roll.isDamage ? 1 : 0,
    };
  }

  function urlFor(obj) {
    const payload = encode(obj);
    if (payload.length > MAX_PAYLOAD) {
      throw new Error(`Message is ${payload.length} characters; the limit is ${MAX_PAYLOAD}.`);
    }
    return PREFIX + payload;
  }

  /**
   * Hand a URL to the operating system without leaving the page.
   *
   * Setting `location.href` would navigate D&D Beyond away mid-roll, and
   * `window.open` is treated as a popup and blocked. A throwaway hidden iframe
   * triggers the protocol handler and leaves the sheet where it is.
   */
  function open(url) {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.src = url;
    document.body.appendChild(frame);
    // Long enough for the handler to fire, short enough to leave no litter.
    setTimeout(() => frame.remove(), 1000);
  }

  function sendRoll(roll) {
    open(urlFor(rollMessage(roll)));
  }

  return { INTEROP_ID, PREFIX, MAX_PAYLOAD, encode, rollMessage, urlFor, open, sendRoll };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Link;
if (typeof window !== "undefined") window.SpirekeeperLink = Link;
