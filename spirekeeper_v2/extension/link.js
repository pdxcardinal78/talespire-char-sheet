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
   * Hand a URL to the operating system.
   *
   * Chrome will only launch an external protocol while a real user gesture is
   * live, and it is strict about what counts. Two plausible-looking methods are
   * both refused with "Not allowed to launch … because a user gesture is
   * required":
   *
   *   a.click()     a synthesised click is isTrusted:false and carries no
   *                 activation, even when fired from inside a real handler
   *   iframe.src    a subframe navigating to an external protocol is exactly
   *                 the case browsers hardened against
   *
   * A direct assignment to `location` during the real click is what works. It
   * does not navigate the page: for a registered custom scheme the browser
   * hands off to the handler and the document stays where it is.
   *
   * Only one method fires. Trying several "to be safe" would send the same roll
   * more than once the moment more than one of them is permitted — two sets of
   * dice in someone's game is a worse failure than none.
   *
   * Must be called synchronously from the click handler; anything awaited first
   * spends the activation.
   */
  function open(url) {
    const active = navigator.userActivation?.isActive;
    if (active === false) {
      // Worth saying out loud, because Chrome's own refusal names the cause but
      // not the culprit, and the culprit is always "something awaited first".
      console.warn("[Spirekeeper] no user activation left — the launch will be refused");
    }
    window.location.href = url;
    return "location";
  }

  function sendRoll(roll) {
    const url = urlFor(rollMessage(roll));
    const how = open(url);
    console.log(`[Spirekeeper] ${roll.name} ${roll.roll} -> ${url.length} chars via ${how}`);
    return how;
  }

  return { INTEROP_ID, PREFIX, MAX_PAYLOAD, encode, rollMessage, urlFor, open, sendRoll };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Link;
if (typeof window !== "undefined") window.SpirekeeperLink = Link;
