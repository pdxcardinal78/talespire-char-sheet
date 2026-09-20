# Spirekeeper — Feasibility Research

Research date: 2026-09-13. All endpoint probes were run on that date from this machine.

## Verdict

Feasible, and now proven end to end against a real sheet. TaleSpire's side is solved, documented, and
officially supported — a Symbiote can read minis, roll real dice, talk to other clients, and store 5 MB of
sheet data per campaign. A live probe of a public D&D Beyond character returned the complete sheet, and a
prototype normalizer in this repo computes the derived numbers correctly from it.

What's left is not "can we get the data" but three narrower problems: a **server-side adapter is mandatory**
(no CORS headers, confirmed on a successful response), **staying current is expensive** (no cache validators,
so every refresh is a full 410 KB download), and the **ToS/fragility risk is unchanged** — the endpoint is
undocumented, only Public sheets are readable, and the one person who shipped this before abandoned the
approach.

Recommended shape: a **remotely hosted web app** whose "mod" is a ~2 KB `manifest.json` pointing at your
domain, published to **mod.io** (the in-game channel), with **manual JSON import shipping first** and
URL-based D&D Beyond import added behind a server-side adapter.

---

## 0. Live probe against a real sheet

Tested against `https://www.dndbeyond.com/characters/123456789` (Doran Stoneborne, Dwarf Cleric 2),
set to Public, on 2026-09-13.

| Check | Result |
|---|---|
| `GET character-service…/character/123456789` | **200**, 410 KB of JSON, ~0.65 s |
| `Access-Control-Allow-Origin` on success | **Absent** — a server-side adapter is mandatory, confirmed |
| `ETag` / `Last-Modified` / `Cache-Control` | **All absent** — no conditional requests possible |
| Repeat requests | No rate limiting observed over a short burst |
| Content completeness | Full spell descriptions, item stats, modifier arrays, actions with limited uses |

### What this changes

**The import path itself is trivial.** One HTTP call through a proxy and you have everything. That part took
about thirty minutes to prove.

**Polling is expensive and there's no cheap way to check for changes.** With no `ETag` or `Last-Modified`,
every freshness check is a full 410 KB download. At BeyondLink's 10-second interval that's ~2.5 MB/minute per
character — roughly 720 MB/hour for a five-person party through a shared proxy. Design for **manual refresh
plus a server-side `dateModified` comparison**, not tight polling. The payload does carry `dateModified`, so a
proxy can download, compare, and return `304`-equivalent "unchanged" to clients cheaply on your side of the wire.

**The payload also carries the campaign roster — and we are deliberately ignoring it.** A `campaign` object
lists every character in the D&D Beyond campaign, with ids, names and player usernames. Skipping it is the
right call for three reasons: characters frequently aren't attached to a D&D Beyond campaign at all (the field
is simply absent, so a feature built on it would work erratically); a D&D Beyond campaign roster is not the
same set of people as tonight's session; and pulling sheets nobody asked you to pull is the wrong default.

**Each player imports their own link.** That turns into a privacy stance you can state plainly in the mod
description: the adapter reads the one character it was given and discards the rest of the payload. Never log
it, never persist it.

**The normalizer is the real work, and it is tractable.** `prototype/ddb-normalize.mjs` in this repo turns the
raw payload into a usable sheet and computes correctly on the first real character:

```
AC 18 (Chain Mail 16 + shield +2)   HP 23/23   Init +0   PP 13   Darkvision 120 ft.
Saves: WIS +5 ●  CHA +4 ●           Spell DC 13, attack +5      Slots L1: 3/3
Channel Divinity 2/2 (long rest)    Club d20+4 / 1d4+2          Shortbow d20+2 / 1d6
```

### The long tail, made concrete

Every one of these came out of one level-2 character. They are the reason the normalizer is measured in weeks,
not days:

1. **Spell slots aren't in the payload.** `spellSlots` reports `used` but leaves `available` at 0. The table
   has to be reconstructed from class levels, including the multiclass combined-progression rule and separate
   handling for warlock `pactMagic`, half-casters and third-casters.
2. **Modifiers carry prose restrictions.** The Dwarf's `advantage / saving-throws` modifier has
   `restriction: "to avoid or end the Poisoned condition"`. My first pass ignored that field and rendered
   advantage on *every* save — a confidently wrong sheet. Conditional modifiers must be surfaced as caveats,
   never folded into a number.
3. **Ability scores arrive pre-split.** CON 18 is `16 base + 2` from a background ASI feat; WIS 16 is `15 + 1`.
   You must sum `stats` + `bonusStats` + `overrideStats` + every `bonus / <ability>-score` modifier.
4. **Rules-edition drift.** This is a 2024-rules character — Guide background, ASIs delivered as feats, a Club
   with the "Slow" property. Structure is stable across editions; content isn't.
5. **Interactions nothing models for you.** Chain Mail imposes disadvantage on Stealth, and this character is
   proficient in Stealth. Nothing in the payload connects those two facts.
6. **Actions live outside features.** Channel Divinity's 2-use budget is in `actions.class[].limitedUse`, not
   in `features`. Resource trackers need their own pass.
7. **Live state rides along.** This sheet currently carries the Poisoned condition (id 11) — worth knowing
   it's there, whether or not it's intentional.

---

## 1. What TaleSpire gives you

Symbiotes are TaleSpire's official modding system: a directory containing `manifest.json` plus an HTML entry
point, rendered in an embedded Chromium (currently v111) side panel. TaleSpire injects the `TS` API object on
every page load when the manifest declares `api.version`.

**The single most important manifest fact:** `entryPoint` accepts *either* a local path *or* a full remote
URL. You can host the entire application on your own domain and ship a tiny manifest as the mod. The API
injection procedure repeats on every page load, including remote pages, so a hosted app still gets the full
`TS.*` surface. This also makes CORS a non-issue for your own backend and lets you ship updates without
republishing the mod.

### Relevant API surface (v0.1)

| Namespace | What you get | Use in this project |
|---|---|---|
| `TS.creatures` | `getSelectedCreatures`, `getMoreInfo` (stats, HP, name, owners, morphs), `getCreaturesOwnedByPlayer`, `createBlueprint` | Bind a sheet to a mini; click a mini to switch sheets |
| `TS.dice` | `isValidRollString`, `makeRollDescriptors`, `putDiceInTray`, `evaluateDiceResultsGroup`, `sendDiceResult` | Roll real TaleSpire dice from sheet actions |
| `TS.chat` | `send`, `sendAsCreature`, `multiSend*` (400 char cap) | Post formatted attack/save results in-character |
| `TS.sync` | Realtime messaging between clients running the same interop ID (500 UTF-16 chars, max 20 targets) | Party status digests, GM ↔ player handshakes |
| `TS.localStorage` | `global` and `campaign` scoped blobs, 5 MB each | Store imported sheets without a backend |
| `TS.players` / `TS.clients` | GM rights vs current GM/player view mode | Gate the DM party panel |
| `TS.urls` | `submit()` for `talespire://` URLs; `createUrlPrefixForThisSymbiote()` for inbound messages | The only real write path (see below) |
| `TS.initiative`, `TS.rulers`, `TS.contentPacks`, `TS.bookmarks` | Turn queue, measurement results, asset thumbnails | Turn-aware sheet, "your turn" notification |
| Events | `onCreatureStateChange` (HP, stats, owners, name...), `onCreatureSelectionChange`, `onRollResults`, `onChatMessage`, `onSyncMessage`, `onInitiativeEvent` | Live updates without polling |

### Limits you must design around

1. **The board is read-only to Symbiotes.** The docs are explicit: "Symbiotes can't do anything that gets
   saved to the board." There is no `setHp` / `setStats`. You can *read* a mini's HP and stats and react to
   changes, but you cannot write the sheet's HP back onto the mini from a Symbiote.
   - Indirect write paths that *do* exist: `creatures.createBlueprint()` returns a `talespire://` blueprint URL
     that spawns a mini pre-populated with name/HP/stats, `urls.submit()` can submit `talespire://stat-names/`
     links to rename the campaign's generic stats, and chat can carry anything.
   - True live write-back to an existing mini requires a **BepInEx C# plugin**, not a Symbiote. That is exactly
     what LordAshes' `BeyondLink` plugin does, and it is why that route exists separately.
2. **Minis hold 8 generic named stats plus HP.** A full character sheet will never live on the mini. The sheet
   lives in your Symbiote; the mini gets a projection of it (AC, passive perception, whatever the campaign
   names its 8 slots).
3. **Sync messages cap at 500 characters.** You cannot push a whole sheet over `TS.sync`. Send compact digests
   (name, AC, HP, conditions) or use your own backend, which a remotely hosted Symbiote can reach freely.
4. **Symbiote-submitted dice results are flagged** as potentially modified so GMs can cross-check. Prefer
   `putDiceInTray` (real dice, real physics, no flag) and read results from `onRollResults`.
5. **Rate limiting is explicit** — excessive calls return `rateLimited`. Batch `getMoreInfo` calls.
6. **Page navigation re-runs injection.** Build a one-pager that swaps content, not a multi-page site.

---

## 2. What a click actually does

Three questions about in-game interaction, three different answers — and the differences matter more than the
similarities.

### Targeting: supported natively

`TS.picking.startPicking()` switches the cursor into a pick mode; the user clicks something on the board and
you get back `pickingCompleted { id, kindOfPicked, idOfPicked }`, where `kindOfPicked` is one of
`"creature" | "tile" | "prop" | "unknown"`. So "click the goblin, then choose an attack" is a first-class flow.

One constraint: only one picking operation can be open across all Symbiotes at once. A second
`startPicking()` returns `toolInUse`, so handle that state rather than assuming the tool is yours.

### Reading the target's AC: permission-gated, and that's structural

`creatureInfo` exposes `stats: [{ name, value, max }]` alongside `hp`, so a target's AC is readable — but only
when three things line up: the campaign spent one of its 8 stat slots on AC, the mini actually has it filled
in, and **the client asking is allowed to see it**. The docs are unambiguous:

> GMs (including players who can GM, but are in player mode currently) can see all the info on all the minis,
> players will only see data they themselves can find out through the TaleSpire UI, meaning most data is only
> visible on minis they own.

**A player's client cannot read an enemy's AC.** Automatic hit/miss resolution is therefore a *DM-client
feature*; on a player's client the same action degrades to "you rolled 17" with no verdict. This isn't
engineering-around-able — it's the game's information model, and it matches how most tables actually play.

### The loop can't close

Even when the DM's client knows the attack hit and knows the damage, it cannot write HP onto the target —
Symbiotes can't modify the board (see §1). The honest ceiling is: **pick target → roll → post a formatted
result to chat → a human applies it.** Automatic damage application is BepInEx-plugin territory.

### Named rolls: free

Roll names are first-class in two places at once. `rollDescriptor` is literally `{ name: string, roll: string }`,
and the dice-string grammar accepts `name:2d6+3` directly. Names appear in chat history and result pop-ups
natively, and come back attached to `rollResultsGroup.name` — nothing to reconstruct.

Attack and damage can share a single throw using roll groups:

```
Club attack:d20+4 / Club damage:1d4+2
```

One set of dice hits the table; both results return labelled. Given TaleSpire's physical-dice presentation,
prefer this to the sequential "roll to hit, then roll damage on a hit" pattern — two throws per attack gets
tedious at the table.

Note that `putDiceInTray` *stages* dice "ready for the player to roll" — the player still throws them. There is
no silent auto-roll except via `sendDiceResult`, which stamps the result as Symbiote-originated.

### Advantage and disadvantage: not native, but anticipated

The dice grammar is deliberately basic — `+` and `-` only, no keep-highest, no rerolls, no exploding dice. The
API was clearly designed with this gap in mind, though: `evaluateDiceResultsGroup` exists, per its own docs, so
you can handle groups separately *"to for example implement a 'keep highest group' function."*

So advantage is two roll groups and a comparison:

```js
// Roll d20+4 twice, evaluate each group, keep the higher.
const descs  = TS.dice.makeRollDescriptors("Attack:d20+4/Attack:d20+4");
const rollId = await TS.dice.putDiceInTray(descs, true);   // quiet = true

// …later, in the rollResults handler for that rollId:
const totals = results.resultsGroups.map((g) => TS.dice.evaluateDiceResultsGroup(g));
const keep   = totals.indexOf(Math.max(...totals));        // Math.min for disadvantage
await TS.dice.sendDiceResult([results.resultsGroups[keep]], rollId);
```

The `quiet` flag is the designed-in other half. Quiet rolls hide the raw result from chat, and the docs state
it is *"meant to work in conjunction with sendDiceResult so Symbiotes can 'override' the roll result, while
retaining the GMs ability to cross check."* The GM gets an indicator they can click to see what was really
rolled. **The Symbiote tamper marker is not a smell here — it is the sanctioned mechanism for exactly this.**

Two real d20s land on the table and everyone sees one kept result, which is visually perfect for advantage.

**The tradeoff, stated plainly:**

| Approach | Chat output | Downside |
|---|---|---|
| Loud (no quiet flag) | Both group totals, then your summary line | Noisy and slightly confusing — the table sees a discarded number |
| Quiet + `sendDiceResult` | One kept result | Every advantage roll carries the Symbiote marker |

Go quiet-and-override, and say so in the mod description so DMs know why the marker shows up.

### Summary

| Capability | Works? | Where |
|---|---|---|
| Click a mini to target it | **Yes** | Any client |
| Click an attack, roll it with its name shown | **Yes** | Any client |
| Attack + damage in one throw | **Yes** | Any client |
| Advantage / disadvantage | **Yes**, ~a day's work | Any client |
| Auto hit/miss vs. target AC | **Partly** | DM client only, and only if AC occupies a stat slot |
| Apply damage to the target's HP | **No** | Needs a BepInEx plugin |

---

## 3. The actual risk: getting sheet data out

### D&D Beyond

There is no supported, documented, public API. The undocumented endpoint the community uses is:

```
https://character-service.dndbeyond.com/character/v5/character/{characterId}
```

Probed 2026-09-13 (unauthenticated):

| Request | Result |
|---|---|
| `.../character/123456789` (a real Public sheet) | `200` — 410 KB, complete character, ~0.65 s |
| `.../character/1` | `403` — `{"serverMessage":"Unauthorized Access Attempt."}` |
| `.../character/138467`, `4183498`, `71862959`, `100000000` | `404` — resource not found |
| Any response, with `Origin:` header set | **No `Access-Control-Allow-Origin` header** |
| Any response | **No `ETag`, `Last-Modified` or `Cache-Control`** |

So the service is alive and answers unauthenticated requests, but:

- **CORS blocks browser-side fetches.** A Symbiote page cannot call it directly. You need a server-side
  adapter — free if you are already hosting the app remotely (a Cloudflare Worker is enough).
- **Only characters set to Public are readable anonymously.** "Campaign only" and private sheets return 403.
  Reaching those means proxying the user's D&D Beyond credentials (the `ddb-proxy` model used by Foundry's
  DDB-Importer) or reading the already-loaded page in the user's browser (the Beyond20 model, via extension).
- **The strongest warning sign is prior art.** LordAshes shipped `BeyondLink` (poll the character URL, sync
  HP/max HP/AC/shield AC/used HD/max HD into TaleSpire on a ~10 s interval), then **marked it obsolete in
  favor of `BeyondLinkViaChrome`**, which extracts the data through a Chrome extension instead. Someone who
  already solved this problem moved off the direct-URL approach.

**ToS posture.** D&D Beyond's terms prohibit accessing the site "by means of any robot, spider, scraper,
crawler or other automated means." Beyond20's long-standing defense is that it never touches DDB servers — it
reads data already loaded in the user's own browser. Ranked by exposure: server-side proxy (highest) →
client-side fetch with user credentials → browser extension reading the DOM → **user pastes/uploads the JSON
themselves (zero exposure)**. Separately, the character JSON embeds licensed spell and item text; rendering a
user's own data in their client is a very different act from caching and redistributing it from your server.
SRD 5.1/5.2 is CC-BY if you need bundled reference data.

### Other sources, ranked by friction

| Source | System(s) | Access | Notes |
|---|---|---|---|
| **File / paste import** | anything | None needed | Always works, zero ToS surface, zero infra. Ship this first. |
| **Pathbuilder 2e** | PF2e | `pathbuilder2e.com/json.php?id={6-digit}` | Explicit user-initiated export. Probed 2026-09-13: **Cloudflare bot challenge** (`cf-mitigated: challenge`) for non-browser clients, and no CORS. Needs a proxy or a file drop. |
| **Demiplane** | Daggerheart, Alien, Marvel, Avatar, Cosmere | Official Character API | The **only sanctioned API in the space** — built for the Roll20 integration. Partner-gated; worth an email before you build anything else. |
| **Dicecloud v2** | 5e | Open source, has an API | Small user base, but friendly. |
| **Foundry / Roll20 exports** | many | JSON export | Assumes the user already runs another VTT. |
| **Open5e / dnd5eapi.co** | 5e SRD | Free, CORS-enabled | Reference data (spells, items, monsters), not user sheets. Good fallback for descriptions. |

---

## 4. Architecture

```
Sheet source          Adapter (yours)        Symbiote (hosted)        TaleSpire
────────────          ───────────────        ─────────────────        ─────────
DDB JSON  ─┐
Pathbuilder ├─ fetch ─→ normalize to ──────→ render sheet ─────────→ TS.dice.putDiceInTray
Demiplane  │           system-agnostic       + campaign               TS.chat.sendAsCreature
File drop ─┘           sheet schema          localStorage             TS.creatures (read + select)
                                             + TS.sync digests        TS.urls.submit (blueprints)
```

- **manifest.json** — `entryPoint: "https://yourdomain/app"`, `api.version`, `api.interop.id` (required for
  sync, notifications, and inbound URLs), event subscriptions, `capabilities: ["runInBackground"]`.
- **Adapter service** — one endpoint per source (`/import/ddb/:id`, `/import/pathbuilder/:code`), returning
  your normalized schema. Pass through, don't persist licensed content.
- **Normalization is the real product.** DDB's JSON hands you raw `modifiers` arrays, not computed values —
  resolving proficiency bonus, ability scores, AC from feats/items/class features is where the work is.
  MrPrimate's `ddb-importer` has already mapped this ground; check its license before reusing logic.
- **Mini binding** — store a `creatureId → sheetId` map in campaign-scoped localStorage; use
  `onCreatureSelectionChange` to swap the visible sheet when a mini is clicked. Fully supported, high UX payoff.
- **DM party view** — each player's Symbiote emits a compact digest over `TS.sync` (fits in 500 chars); the DM
  instance renders the party panel, gated on `TS.clients.whoAmI()` mode and GM rights.

---

## 5. Distribution

- **mod.io is the channel for Symbiotes.** TaleSpire's in-game mod browser pulls from `mod.io/g/talespire`.
  The docs note third-party repositories may be supported later, but today this is the route to users.
- **Thunderstore / r2modman is the BepInEx plugin channel.** r2modman is designed for plugins, not Symbiotes —
  community members install Thunderstore-hosted Symbiotes via LordAshes' `SymbioteManagerPlugin`. Treat it as
  a secondary mirror, *unless* you decide you need live write-back to minis, in which case you're writing a C#
  plugin anyway and Thunderstore becomes primary.
### Can a DM push the mod onto a player? No.

Checked against the docs: installation is entirely per-user and opt-in. A player installs a Symbiote from the
in-game library's "Community Mods" tab, or by dropping a folder into the Symbiotes directory themselves. There
is **no campaign-level requirement, no host push, no auto-install on join**, and nothing in the API that
installs or enables a Symbiote on another client. This is a deliberate stance on BouncyRock's part and is
unlikely to change.

Two related limits worth knowing before you design around it:

- `TS.sync` only reaches clients running a Symbiote with the **same interop ID**. Players without the mod are
  simply unreachable over that channel.
- `sync.getClientsConnected()` returns clients that have the Symbiote **loaded**, and explicitly *"does not
  include clients that have the Symbiote installed but not open."* So you can detect who's actively running it,
  but you cannot distinguish "doesn't have it" from "has it closed." Don't build logic that depends on telling
  those apart.

**So design for a mixed table from day one.** Some players will have the mod, some won't, and that will be the
normal case rather than an edge case. Three fallbacks, in order of how well they work:

1. **The DM holds the sheet.** The DM imports a player's public link into their own instance and reads from it.
   This is the mode you described, and it works with zero cooperation from the player's client — worth treating
   as a first-class feature rather than a degraded path, including a way to keep several imported sheets side
   by side.
2. **Chat is the universal output channel.** `TS.chat.send` and `sendAsCreature` reach *every* player in the
   game regardless of what they have installed. A compact stat block fits inside the 400-character cap with
   TextMeshPro formatting, so a modless player can still receive "Tor: AC 18, HP 23/23, PP 13" or a formatted
   attack result. This is the single most valuable thing the mod can do for players who never install it.
3. **Real dice still land for everyone.** `TS.dice.putDiceInTray` rolls actual TaleSpire dice, visible to the
   whole table through the normal game UI. A DM rolling a player's attack from an imported sheet looks
   identical to that player rolling it themselves.

The practical onboarding story is a mod.io link in the campaign invite, and a DM who can cover anyone who
didn't click it.

- **Manual install for testing:** drop a folder into
  `%AppData%\..\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes\`. TaleSpire watches the directory and
  hot-reloads on file change.

---

## 6. Build plan

| Phase | Scope | Effort (part-time) | Risk |
|---|---|---|---|
| 0 | *Done* — normalizer prototype, verified against a real sheet | — | — |
| 1 | Symbiote shell, manual JSON import, 5e sheet render, campaign localStorage | 2–3 weeks | Low |
| 2 | Dice: named rolls, attack+damage in one throw, `onRollResults` → chat as creature | 1 week | Low |
| 2b | Advantage / disadvantage via two groups + quiet override | 1 day | Low |
| 3 | Mini binding, selection-driven sheet switching, `startPicking` targeting | 1 week | Low |
| 3b | DM-side auto hit/miss against target AC (GM clients only) | 2–3 days | Low |
| 4 | Hosted adapter + D&D Beyond URL import (public sheets only) | 3–5 days | **High** — ToS, undocumented endpoint, privacy settings |
| 5 | DM party view over `TS.sync` | 1–2 weeks | Low |
| 6 | Second system adapter (Pathbuilder PF2e or Demiplane) | 1–2 weeks each | Medium |
| 7 | *Optional* BepInEx plugin for HP/AC write-back to minis | 2–3 weeks + ongoing | **High** — C#, breaks on TaleSpire updates |

Phases 1–3 are a genuinely useful product on their own and carry no legal or fragility risk. That is the
argument for shipping them before touching D&D Beyond.

## 7. Go / no-go checks worth doing before writing code

1. ~~Confirm the endpoint returns full JSON for a Public character.~~ **Done** — 200, 410 KB, parsed and
   normalized correctly. Still worth confirming the same call works **from a hosted worker** rather than a
   home IP, since datacenter ranges are the usual first thing to get blocked.
2. **Check how willing your players are to flip a sheet to Public.** With per-player import this is a UX
   question rather than a blocker — but if the answer is "most won't," the browser-extension route becomes
   mandatory and the project gets meaningfully bigger. Ask two or three players before you build the adapter.
3. Email Demiplane about Character API access. It's the only sanctioned route in this space and it would
   change your source priority entirely.
4. Ask in the TaleSpire Discord whether mod.io submissions accept a remote-`entryPoint` Symbiote, and whether
   BouncyRock has an opinion on sheet-import mods.
5. Read `ddb-importer`'s license and mapping code before you rebuild DDB's modifier resolution from scratch —
   the prototype here covers a level-2 single-class cleric, and the gap between that and "every class, both
   rules editions, multiclassed" is most of the work.
6. Decide the refresh model now, because it shapes the backend: manual "re-import" button (cheap, honest) versus
   background polling (expensive, and the pattern that got the original BeyondLink retired).

## Sources

- [TaleSpire Symbiote docs](https://symbiote-docs.talespire.com/) ·
  [API v0.1](https://symbiote-docs.talespire.com/api_doc_v0_1.md.html) ·
  [Manifest v1](https://symbiote-docs.talespire.com/manifest_doc_v1.html)
- [Bouncyrock/symbiotes-examples](https://github.com/Bouncyrock/symbiotes-examples)
- [mod.io — TaleSpire](https://mod.io/g/talespire) ·
  [Thunderstore — TaleSpire](https://thunderstore.io/c/talespire/)
- [LordAshes/TaleSpire-BeyondLinkPlugin](https://github.com/LordAshes/TaleSpire-BeyondLinkPlugin) ·
  [BeyondLinkViaChrome](https://github.com/LordAshes/TaleSpire-BeyondLinkViaChrome) ·
  [SymbioteManagerPlugin](https://talespire.thunderstore.io/package/LordAshes/SymbioteManagerPlugin/)
- [MrPrimate/ddb-proxy](https://github.com/mrprimate/ddb-proxy) ·
  [ddb-importer](https://github.com/MrPrimate/ddb-importer)
- [Thahun/Talespire_Symbiote_D_D_Character](https://github.com/Thahun/Talespire_Symbiote_D_D_Character)
- [Demiplane × Roll20 integration / Character API](https://www.demiplane.com/blog/demiplane-x-roll20-integration)
- [Pathbuilder 2e export](https://pathbuilder2e.com/export.html)
