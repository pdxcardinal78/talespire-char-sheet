# Spirekeeper Importer

A browser extension that copies a D&D Beyond character straight into
Spirekeeper's import box — **including private ones**.

## What it replaces

Importing today is four steps: paste the character link, press **Get JSON URL**,
open that URL in a browser, select all, copy, paste back. And the character has
to be set to **Public** first, which is a real concession — it makes the sheet
readable by anyone with the link.

Both exist for the same reason: D&D Beyond sends no CORS headers, so a Symbiote
running at a file origin is refused outright. An extension is not subject to
that, and it carries the user's own session.

So this becomes: open the character, click the toolbar button, click **Copy**,
paste. No public toggle.

## Loading it

Not packaged yet — load it unpacked:

1. Chrome → `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → pick `spirekeeper_v2/extension`
3. Open a D&D Beyond character page and click the toolbar button

Firefox is `about:debugging` → **This Firefox** → **Load Temporary Add-on**,
pointing at `manifest.json`. The manifest is MV3 with no background worker, so
it should load on both without changes.

## How it works

Two requests, both to D&D Beyond, nothing else leaves the machine.

1. `POST auth-service.dndbeyond.com/v1/cobalt-token` with the browser's session
   cookie, which returns a short-lived bearer token. This is what D&D Beyond's
   own site does. Signed out, it answers `{"token": null}` rather than an error —
   so a missing token means "not signed in", not "request failed", and a public
   character still imports fine in that state.
2. `GET character-service.dndbeyond.com/character/v5/character/<id>`, with the
   token as a bearer if there was one.

The popup shows the character's name, species, class and level before you copy,
so you can see it got the right one without switching to TaleSpire first. It
also says whether your session was used or whether the character was simply
public — the difference matters when something later goes wrong.

## Files

| | |
|---|---|
| `manifest.json` | MV3. `activeTab` for the current URL, host permissions for `*.dndbeyond.com`. No `cookies` permission — `credentials: "include"` carries the session on its own, and asking for less means a smaller install prompt |
| `ddb.js` | URL parsing, the token exchange, the fetch, and the summary line |
| `popup.html` / `popup.css` / `popup.js` | The popup. Palette matches the Symbiote's |

`ddb.js` exports for CommonJS too, so its logic is testable from Node against
the live API without loading the extension.

## Status

Verified: URL parsing across the shapes D&D Beyond uses, the live fetch, the
error paths (private without a session, private with the wrong account, 404,
500, non-character page), and the copied string surviving `JSON.parse` and the
Symbiote's normalizer — producing AC 18 / HP 33 / DC 13 with all four Twilight
Domain spells, identical to a manual paste.

Confirmed in a real install: `chrome.tabs`, the clipboard write, and the session
token path. The popup reports "Read using your signed-in session" for **both
public and private** characters, and a private character imports — so the
"set privacy to Public" requirement is gone.

## Rolling — blocked, and not by this code

**Do not spend more time here without re-testing the finding below.**

A Symbiote URL only reaches the panel when TaleSpire is *not already running*.
Verified by hand, with no extension involved: the same URL pasted into a
browser address bar arrives when TaleSpire is closed (~7 s, cold launch) and
never arrives when it is open. Chrome reports `Launched external handler` in
both cases, so the browser does its part and the message is lost after the
hand-off. Meanwhile `TS.urls.submit()` from inside the panel arrives in 6–9 ms,
which proves the subscription, the handler and the decoder are all fine.

"TaleSpire already running" is the only state that matters during a session, so
rolling over a Symbiote URL cannot work. The code below is complete and
correct as far as it can be tested; what it depends on is not available.

Everything still works up to that last hop, and it is all verified:

- 45 of 45 rollable buttons read off a live sheet
- capture-phase interception ahead of D&D Beyond's own menu
- base64url message, ~90 characters, well inside any measured ceiling
- `window.location.href` — the one launch Chrome permits (see below)
- the panel decodes, queues if mid-boot, and stages with roll mode and
  effects applied — a click with advantage and Bless produced two d20 groups
  plus a separate `Bless 1d4`

If it is ever unblocked, that is the whole feature working. Worth re-testing
after a TaleSpire update; it may be a bug rather than a policy. It is also
worth checking whether `talespire://dice/` behaves differently, since that verb
needs no Symbiote — it would cost advantage, effects, chat attribution and the
GM's damage inbox, which is why it was not the first choice.

## How it was built

`rolls.js` reads the rollable buttons off a D&D Beyond sheet. Verified against
a live level-3 cleric: **45 of 45 buttons** classified — 6 abilities, 6 saves,
18 skills, initiative, 8 attacks and 6 damage rolls — each with its real name
and roll (`Club | 1d4+2`, `Guiding Bolt | 4d6`, `Shillelagh | 1d20+5`).

Two things make it survivable. D&D Beyond's buttons carry **no roll data** —
a skill button's whole content is the string `+2` — so meaning comes from
position, and the trick is which class names to trust:

| | |
|---|---|
| `integrated-dice__container` | stable, the hook |
| `ct-*`, `ddbc-*` | stable component names, used to classify |
| `F8U5pq_button` | a build hash — never matched on |

And damage is identified by **printing dice**, not by its container. Damage
buttons sit *inside* attack rows, so container-first classification calls them
attacks — "Club attack 1d4+2" is a wrong result rather than a wrong label,
since a d20 roll and a damage roll are not interchangeable.

`Rolls.probe()` reports coverage. Run it on a sheet after a D&D Beyond update:
if `unmatched` climbs, a selector has gone stale and the sample says where.

`content.js` intercepts the click, `link.js` sends it. Interception is **off by
default** and toggled from the popup — D&D Beyond's own dice are perfectly good,
and an extension that silently hijacks every click on someone's sheet is one
they uninstall. The listener runs in the capture phase, because these buttons
open a menu and a bubbling listener arrives too late.

The roll travels as base64url in a `talespire://symbiote/<id>/…` URL, about 150
characters against a measured 1984-character ceiling. base64url specifically:
standard base64's `/` would split the URL path.

Arriving as the panel's own code is the entire point, and it shows. A click on
D&D Beyond with advantage set and Bless active stages:

    Shillelagh (Adv)  1d20+5
    Shillelagh (Adv)  1d20+5
    Bless             1d4

— two d20s to compare and a separate buff die, thrown quietly so the panel can
report the surviving one. A raw `talespire://dice/` URL can do none of that.

### Launching the URL

Chrome only launches an external protocol while a real user gesture is live,
and it is strict about what counts. Two plausible methods are both refused with
*"Not allowed to launch … because a user gesture is required"*:

| Method | Why it fails |
|---|---|
| `a.click()` on a created anchor | a synthesised click is `isTrusted: false` and carries no activation, even inside a real handler |
| hidden `iframe.src` | a subframe navigating to an external protocol is the case browsers hardened against |

What works is a direct `window.location.href = url` during the real click.
It does **not** navigate the page — for a registered custom scheme the browser
hands off to the handler and the document stays put. Verified on a live sheet:
`navigator.userActivation.isActive` true, no refusal, sheet still loaded.

Only one method fires. Trying several "to be safe" would send the same roll
twice the moment more than one is permitted, and two sets of dice in someone's
game is a worse failure than none.

The call must be synchronous from the click handler; anything awaited first
spends the activation. `open()` warns when activation has already gone, because
Chrome's own message names the cause but not the culprit.

## Next

After rolling: Beyond the Spire already does it well, and it is
the half that breaks whenever D&D Beyond restyles its sheet. When it happens it
should go over a Symbiote URL rather than `talespire://dice/`, so rolls arrive
as Spirekeeper's own code and keep advantage, chat attribution and the GM's
damage inbox working. See the main README's link-probe section for the measured
limits — 1984 characters per message, base64url only.
