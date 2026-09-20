# Spirekeeper v2 — workspace

A copy of the shipping Symbiote, taken at **v0.10.6**, to develop the browser
extension against without disturbing the mod that gets played with.

`../symbiote/` stays the working build. Nothing in here affects it.

## Why a copy and not a branch

This project is not under version control, so a branch isn't available and a
copy is the only real isolation. That is worth fixing — `git init` at the repo
root would make this directory unnecessary and give the work an undo button.
Until then, treat `../symbiote/` as the thing that must keep working.

## Installing both at once

The two builds carry different names and different interop ids, so TaleSpire
lists them separately and they cannot receive each other's messages:

| | `../symbiote` | `spirekeeper_v2/symbiote` |
|---|---|---|
| Name | Spirekeeper | Spirekeeper v2 |
| Version | 0.10.6 | 2.0.0-dev |
| Interop id | `6f1c9d84-…` | `2f7d6457-…` |

```bash
./dev/install.sh                                                   # the one you play with
./dev/install.sh --src spirekeeper_v2/symbiote --name "Spirekeeper v2"
```

**Both must be installed for the extension to work.** Rolls are addressed to v2
by interop id, so with only v1 installed the browser launches the URL happily
and nothing receives it — Chrome logs success, the panel logs nothing, and
there is no error to follow. `dev/preflight.mjs spirekeeper_v2/symbiote` now
checks that the id in `extension/link.js` still matches this manifest, which
catches the same failure when the two drift rather than when someone notices
their dice stopped arriving.

Stored data lives inside each Symbiote's own folder, so characters and
encounters don't cross between them. Browser-storage keys are namespaced
(`spirekeeper2:…`) for the same reason — both builds run from a file origin in
the game, and sharing a key would let v2 change which character v1 last opened.

One thing deliberately **not** renamed: `ENVELOPE` in `lib/store.js` is still
`sheetbridge/gzip-base64`. It identifies the format of already-stored data, so
changing it would make existing characters unreadable.

## Dev tooling

The scripts in `../dev/` take a target, so there is one copy of each rather than
two that drift:

```bash
node dev/preflight.mjs spirekeeper_v2/symbiote
node dev/serve.mjs --root spirekeeper_v2/symbiote --port 8778   # v1 stays on 8777
```

Running both servers at once is the point — the two panels can be compared side
by side without reinstalling either.

## What this is for

Settled by the link probe, measured in the game (see the main README):

- A `talespire://symbiote/<id>/…` URL opened from a browser reaches the panel,
  and TaleSpire will cold-launch to receive one.
- The payload limit is **1984 characters** (2048-char URL); over it,
  `urlRejected` comes back explicitly.
- TaleSpire delivers the URL segment **still percent-encoded**.

So the plan this workspace exists to build:

- **Rolls travel as Symbiote URLs.** ~130 characters against a 1984 budget, and
  they arrive as our own code — advantage, chat attribution and the GM's damage
  inbox all keep working, which the bare `talespire://dice/` verb cannot do.
- **Characters travel via the clipboard, not chunked URLs.** An extension reads
  the character with the user's own session — no CORS problem and no "set
  privacy to Public" — and hands it over in one paste instead of 14 messages.
- Payloads are **base64url**. Plain base64's `/` would split the URL path.

`extension/` is where the Chrome/Firefox extension will go. Empty until the
first slice — the importer — is started.
