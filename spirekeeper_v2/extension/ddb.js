/**
 * Fetching a character from D&D Beyond, from inside the extension.
 *
 * This is the whole reason the extension earns its place. The Symbiote cannot
 * do any of it: D&D Beyond sends no CORS headers, so a panel running at a file
 * origin is refused outright, which is why importing means "open the URL, select
 * all, copy, paste". An extension with host permissions is not subject to that,
 * and it carries the user's own session — so it can also read characters that
 * are not public, removing the "set privacy to Public" step entirely.
 *
 * Nothing here leaves the machine except the two requests to D&D Beyond itself.
 */
const DDB = (() => {
  const CHARACTER_API = "https://character-service.dndbeyond.com/character/v5/character";
  const TOKEN_API = "https://auth-service.dndbeyond.com/v1/cobalt-token";

  /** Character ids are the one stable thing in a D&D Beyond URL. */
  const ID_RE = /dndbeyond\.com\/characters\/(\d+)/;

  function idFromUrl(url) {
    const m = ID_RE.exec(String(url || ""));
    return m ? m[1] : null;
  }

  /**
   * Trade the browser's session cookie for a short-lived bearer token.
   *
   * This is what D&D Beyond's own site does. Without it, only public characters
   * are readable. With no session the endpoint answers `{token: null}` rather
   * than an error, so a null token means "not signed in", not "request failed" —
   * and a public character will still import fine in that state.
   */
  async function sessionToken() {
    try {
      const res = await fetch(TOKEN_API, { method: "POST", credentials: "include" });
      if (!res.ok) return null;
      const body = await res.json();
      return body?.token || null;
    } catch {
      return null; // offline, blocked, or signed out — the caller copes
    }
  }

  /**
   * Fetch one character.
   *
   * Returns `{ payload, usedSession }`, because whether the session was used is
   * worth telling the user: it is the difference between "this worked because
   * your character is public" and "this worked because you are signed in".
   */
  async function fetchCharacter(id, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    let res;
    try {
      res = await fetch(`${CHARACTER_API}/${encodeURIComponent(id)}`, {
        headers,
        credentials: "include",
      });
    } catch (e) {
      // fetch rejects with a bare "Failed to fetch" for offline, DNS and CORS
      // alike, which is the least useful string a user could be handed.
      throw new Error(`Could not reach D&D Beyond (${e.message}). Check your connection.`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        token
          ? "D&D Beyond refused the request. Is this character on the signed-in account?"
          : "This character is private. Sign in to D&D Beyond in this browser and try again."
      );
    }
    if (res.status === 404) throw new Error("No character with that id.");
    if (!res.ok) throw new Error(`D&D Beyond returned ${res.status}.`);

    const body = await res.json();
    // The API answers 200 with `success: false` for its own errors, so status
    // alone is not enough to know the fetch worked.
    if (body?.success === false) throw new Error(body.message || "D&D Beyond reported an error.");
    if (!body?.data?.name) throw new Error("That response has no character in it.");

    return { payload: body, usedSession: Boolean(token) };
  }

  /**
   * A one-line description, so the popup can prove it got the right character
   * before anyone switches applications to paste it.
   */
  function describe(payload) {
    const c = payload?.data || {};
    const classes = (c.classes || [])
      .map((k) => `${k.definition?.name || "?"} ${k.level}`)
      .join(" / ");
    const level = (c.classes || []).reduce((n, k) => n + (k.level || 0), 0);
    return {
      name: c.name || "Unnamed",
      line: [c.race?.fullName, classes].filter(Boolean).join(" ") || "Unknown",
      level,
      bytes: JSON.stringify(payload).length,
    };
  }

  async function grab(url) {
    const id = idFromUrl(url);
    if (!id) throw new Error("Open a D&D Beyond character page first.");
    const token = await sessionToken();
    const { payload, usedSession } = await fetchCharacter(id, token);
    return { id, payload, usedSession, summary: describe(payload) };
  }

  return { idFromUrl, sessionToken, fetchCharacter, describe, grab };
})();

if (typeof module !== "undefined" && module.exports) module.exports = DDB;
