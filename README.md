# Spirekeeper

A TaleSpire Symbiote that imports a D&D Beyond character and lets you play it from
the side panel — attacks, spells, skills, saves, advantage, and results posted to chat.

Feasibility research that led here: [`docs/feasibility.md`](docs/feasibility.md).

```
symbiote/           the Symbiote itself — this folder is what TaleSpire loads
  manifest.json     entry point, API version, interop id, event subscriptions
  sheet.html        one page; TaleSpire re-runs API injection on every navigation
  sheet.css         styled with the CSS vars TaleSpire injects ("colorStyles")
  app.js            UI, TaleSpire glue, and the global subscription handlers
  lib/ddb.js        D&D Beyond JSON -> normalized sheet (the real work)
  lib/store.js      5 MB global + campaign blobs: sheet library and mini bindings
  lib/rolls.js      dice staging, advantage, chat output
  lib/party.js      passing effects between players over TS.sync
prototype/
  normalize-cli.js  run the normalizer from the terminal against a saved payload
  sample-character.json   # a real D&D Beyond export, identities scrubbed
dev/install.sh      symlink the Symbiote into TaleSpire's folder for hot reload
docs/               feasibility research
```

## Try it without TaleSpire

`app.js` stubs the `TS` API when it isn't there, so the panel runs in a normal browser:

Run it **from the repo root**, not from `symbiote/` — the path is relative:

```bash
cd /path/to/talespire-char-sheet     # the repo root
node dev/serve.mjs                   # http://localhost:8777/sheet.html
node dev/serve.mjs --open            # and launch a browser at it
node dev/serve.mjs --port 9000
```

(`Cannot find module .../symbiote/dev/serve.mjs` means you are still inside
`symbiote/` from an older instruction — `cd ..` and try again.)

Narrow the window to roughly panel width to see the real layout.

It has to be served, not opened as a file: the bestiary fetches
`data/monsters.json`, and a `file://` origin refuses that. The server sends
`no-store` on everything, which matters more than it sounds — a plain
`python3 -m http.server` caches hard enough that editing a script and reloading
can silently run the old one, and the panel then throws somewhere unrelated.

What the stub gives you:

- **Dice** resolve with real random results about 400 ms after staging, so the
  whole attack → hit → damage loop works.
- **You are a GM**, so the Party, Monsters and Fights views are all reachable.
- **Storage persists** in the browser's own localStorage, so imported characters
  and built encounters survive a reload. `localStorage.clear()` resets it.
- **Picking** is simulated: set `window.devPick` to `owned`, `foreign`, `missing`,
  `tile`, `prop` or `cancel` before pressing a pick button to choose the outcome.
- **Chat and clipboard** calls log to the console rather than going anywhere.
- A **fixture party** of five minis backs the Party view, spanning healthy,
  bloodied, critical, down and stats-hidden.

## Install into TaleSpire

```bash
./dev/install.sh          # symlink, so edits hot-reload in game
./dev/install.sh --copy   # if your setup won't follow symlinks
```

The script probes the known Symbiote directories. If it can't find yours, open
TaleSpire → Settings → Modding → **Open Symbiotes Directory** and pass the path:

```bash
./dev/install.sh --path "/that/path"
```

Then enable Symbiotes in TaleSpire's settings and open the Symbiote panel. A warning
marker next to the entry means manifest validation failed — check `.debug/log.txt`
inside the Symbiote folder.

## First run in TaleSpire

Validate before every load — TaleSpire reports a bad manifest as a small warning
marker with the detail buried in a log file:

```bash
node dev/preflight.mjs
```

It checks that the entry point and every referenced script exist, that each
subscription names a real namespace/event source *and* a handler some script
actually defines as a global, and that an interop id is present if sync is used.

Then work through this in order, so a failure tells you which subsystem broke:

| # | Do this | Confirms |
|---|---|---|
| 1 | Open the Symbiote panel — "Spirekeeper" listed with no warning marker | manifest validates |
| 2 | Open it; colours match TaleSpire's UI | API injection, `colorStyles` extra |
| 3 | Paste a character's JSON and import | 5 MB storage write |
| 4 | Close and reopen the panel — the sheet is still there | storage read |
| 5 | Click a skill, throw the dice | `putDiceInTray`, `onRollResults`, chat |
| 6 | Shift-click a skill — two d20s land, one result shown | advantage, quiet override, `sendDiceResult` |
| 7 | Click an attack, then **Damage** on the bar that appears | the split attack/damage flow |
| 8 | Select your mini, **Link selected mini**, roll again | `getSelectedCreatures`, `sendAsCreature` |
| 9 | Click a different linked mini | `onCreatureSelectionChange` |
| 10 | **Pick target**, click a mini | `startPicking`, `onPickingEvent` |
| 10b | Start initiative in TaleSpire — the bar tracks whose turn it is | `getQueue`, `onInitiativeEvent` |
| 11 | Cast a spell, long rest, check slots came back | play state persistence |
| 12 | Add Bless, **Grant…** to another player | `TS.sync` — needs a second client |

Step 12 is the only one you cannot test alone: sync only reaches *other* clients
running the Symbiote, so it needs a second person or a second machine. Everything
else works solo.

If the Symbiote doesn't appear at all, the likely cause is the symlink — TaleSpire
scans for directories containing a `manifest.json`, and whether its scanner follows
symlinks isn't documented. Re-run with `./dev/install.sh --copy` and see if it shows
up. If it appears with a warning marker, read `symbiote/.debug/log.txt`.

## Check the normalizer from the terminal

```bash
node prototype/normalize-cli.js prototype/sample-character.json
node prototype/normalize-cli.js prototype/sample-character.json --json
```

The CLI and the Symbiote share one copy of the logic in `symbiote/lib/ddb.js`.

## How importing works today

D&D Beyond sends no CORS headers, so the panel cannot fetch a character itself.
Paste the link, open the JSON URL it gives you, and paste the JSON back. Nothing
leaves your machine. A hosted adapter would remove the copy-paste step — and add a
server, a ToS exposure, and a maintenance burden. See §03 of the feasibility doc.

## Play state

A sheet has two halves. Everything from the import is a frozen snapshot of what
D&D Beyond said; everything under `sheet.play` is what has happened since —
current HP, temp HP, spent slots, used resources, spent hit dice. It persists to
TaleSpire's campaign storage as you play.

- **HP** — *Damage* and *Heal* apply an amount to yourself. Damage eats temporary
  hit points first.
- **Temp HP** — *Temp HP* grants a pool. Temporary hit points don't stack, so
  granting less than you already have is refused with a note rather than applied.
- **Spell slots** — click a slot pip to spend one, right-click to give it back.
  A multiclass caster gets a line showing how the caster level was reached, e.g.
  *"Caster level 10: Rogue (Arcane Trickster) 8 → 2, Sorcerer 8 → 8. Warlock levels
  feed pact magic separately."* Slots are the most-derived number on the sheet and
  the easiest to get quietly wrong, so the panel shows its working.
  Casting a spell from its card spends the slot for you.
- **Limited-use resources** — Channel Divinity and friends track uses, with an undo.
  Where a resource has choices, they appear as a dropdown: D&D Beyond models them as
  sibling actions named `Channel Divinity` and `Channel Divinity: Divine Spark`, so
  children are matched to their parent by that prefix. Picking one shows its save DC,
  dice and rules text; **Use** spends a charge, announces which option you chose, and
  rolls its dice. Choices that cost nothing (Circle Spell options) get the same menu
  without a counter.
  Rules text is template-resolved on import — `DC {{savedc:wis}}` becomes `DC 13`, and
  `{{1+(classlevel/7)@rounddown}}d8{{modifier:wis}}` becomes `1d8+3`. Tokens the panel
  can't evaluate are left visible rather than blanked or guessed at.
- **Short rest** — restores pact slots and anything that resets on a short rest.
  Hit dice stay spent; spend them individually to heal.
- **Long rest** — HP to full, all slots and resources back, and half your *total*
  hit dice (minimum one). For a multiclass character that is deliberately not half of
  each pool: a Fighter 5 / Wizard 5 has ten dice and gets five back, where halving
  each pool would return four. The rules let you choose which dice come back, so this
  restores the most-spent pools first and leaves `↺` on each pool to redistribute.
- **Hit dice** — one pool per die type, not per class: a Fighter 3 / Paladin 2 has a
  single 5d10 pool, since both classes roll d10. *Spend* rolls the die plus your
  Constitution modifier through the real dice tray and applies the healing; `↺` puts
  one back.

## Gear

The **Gear** tab lists the inventory and lets you wear, remove, attune and
unattune anything. This is not bookkeeping — equipment feeds the numbers, so a
change re-derives the sheet rather than editing the display:

- Taking off the Bracers of the Shadow Archer drops AC by 1 and every saving
  throw by 1.
- Taking off a Ruby Ring drops Charisma, which drops a Draconic Sorcerer's
  unarmoured AC with it, and their Charisma saves.
- An item that requires attunement grants nothing until it is attuned, so a Gem
  of Seeing sitting equipped-but-unattuned hands out no Truesight.

The header shows attunement slots used and warns past three. Nothing is patched
in place: armour class depends on ability scores, which depend on what's worn,
so the only reliable answer is to run the normalizer again. Play state — hit
points, spent slots, conditions, active effects — is keyed by name and survives
the recalculation untouched.

To make that possible the sheet keeps a trimmed copy of the D&D Beyond payload
alongside the derived sheet. `dev/compaction-test.mjs` proves the trimming is
lossless by normalizing both and comparing:

```sh
node dev/compaction-test.mjs path/to/character.json
```

Characters imported before this existed have no stored payload; the tab says so
and asks for a re-import.

## Storage

TaleSpire gives a Symbiote two 5 MB string blobs **per machine**: one global
(follows you between campaigns — the sheet library lives here) and one per
campaign (mini-to-sheet bindings). It is local storage, not shared, so the size
question only ever bites whoever holds the most characters:

- A **player** keeping their own character uses a fraction of a percent. There is
  no scenario in which they run out.
- A **GM** holding the party is the only one who can approach the limit, and only
  because each sheet carries its payload so gear changes can be recalculated.

The library is gzipped before it is stored, which is worth about six to one on
data this repetitive:

| Library | Stored |
| --- | --- |
| 1 level-20 with a full pack | 0.22 MB — 4% |
| 4 level-20s | 0.87 MB — 17% |
| 6 level-20s | 1.30 MB — 26% |
| 10 level-20s | 2.17 MB — 43% |

The import screen shows current usage. Two safeguards sit behind it: writing a
library that would exceed the cap fails with a message naming the size rather
than truncating, and a blob that exists but cannot be read is never written over
— the panel refuses the write instead of replacing someone's library with an
empty one. Blobs written by the previous uncompressed build still load, and are
rewritten compressed on the next save.

## Initiative and conditions

**Roll initiative** rolls `d20` + your initiative modifier and posts it to chat.
It cannot write into TaleSpire's turn tracker — `TS.initiative` exposes `getQueue()`
and nothing else — so someone still types the number in. The panel *reads* the queue,
so it shows whose turn it is and highlights **Your turn** when the mini linked to this
sheet is up.

**Conditions are editable.** The import seeds them from D&D Beyond, and after that the
table owns them: add from the dropdown, `×` to remove, and Exhaustion gets `−`/`+`
level steppers. Adding or removing one announces it in chat so the DM sees it. The
picker hides conditions already applied.

Conditions live in the panel because TaleSpire minis have no condition concept.
`creatureInfo` exposes hp, stats, flying, hidden, and `idsOfActivePersistentEmotes` —
and nothing writable, since Symbiotes can't modify the board. The emote ids are
readable but opaque: nothing in the API maps an id to "Poisoned", so reading them back
off a mini would need a lookup table built by hand per content pack.

### What a condition does

Conditions arrive from D&D Beyond as bare ids — no rules text — so the mod
carries its own, following the 2024 Player's Handbook. Each condition shows a
one-line summary of what it does *to you* under the chips, and the full entry on
hover. Exhaustion does the arithmetic for the level you're on: at level 3 it
reads `-6 to every D20 Test · Speed -15 ft.` rather than making you multiply.

The picker previews a condition before you add it, and the three table states
that aren't PHB conditions — Concentrating, Dodging, Hidden — carry the same
help.

None of it is applied to rolls. A panel that silently rolls at Disadvantage is
harder to trust than one that reminds you to hold Ctrl, so the reminder is
visible and the choice stays yours: shift-click a roll for advantage, ctrl-click
for disadvantage.

## Active effects

Buffs handed to you by other people — Bless, Bardic Inspiration, Shield of Faith —
appear nowhere in your imported sheet, because they come from someone else's turn.
Add them from the preset row (or *Custom…* for anything else) and they fold into the
right rolls automatically:

| Effect | Bonus | Applies to |
|---|---|---|
| Bless / Bane | ±1d4 | attack rolls, saving throws |
| Guidance | +1d4 | ability and skill checks, once |
| Resistance | +1d4 | saving throws, once |
| Bardic Inspiration | +1d6 | attacks, saves, checks, once |
| Shield of Faith / Haste | +2 | AC |
| Shield | +5 | AC |

**Weapon effects replace part of an attack rather than adding to it.** Shillelagh
swaps both the ability used for attack and damage *and* the damage die, which a flat
bonus can't express — so those presets ask which weapon they apply to, then rebuild
that attack from its parts. On a Wisdom caster, a Club goes from `1d4+2 / +4` (Strength,
bludgeoning) to `1d8+3 / +5` (Wisdom, force). Affected weapons are marked `✦` and name
the effect. Magic Weapon +1 works the same way with a flat bonus.

A custom effect takes a name, a bonus like `+2` or `1d4`, and which rolls it touches.
Click an effect to suspend it, `×` to remove it. Anything marked *once* suspends
itself after the roll that used it. AC effects change the displayed AC, which shows
an asterisk and explains itself on hover. A long rest clears every effect.

## Passing effects to other players

A caster can push an effect straight into other people's panels rather than telling
them to add it by hand. **Grant…** on any effect you own lists everyone on the board,
marked by whether their panel is actually open — `sync.getClientsConnected()`
excludes clients that have the mod installed but closed, so anyone unreachable gets a
chat message naming them instead.

Recipients are asked, not told: an inbox card offers **Accept** / **Decline**, and the
answer comes back as a receipt on the granter's effect row — `→ Kree ✓, Gronk chat`.

Effects target **players**, not minis, so the recipient list is a checklist of people
rather than a board interaction. (TaleSpire's picking tool returns one creature at a
time anyway; multi-select via lasso goes up to 50, but mapping minis to owners is a
detour when what you want is a list of players.)

### Concentration

Concentration is what makes granting safe: it's the mechanism that takes effects back.

- Granting a concentration effect (Bless, Bane, Guidance, Resistance, Shield of Faith,
  Haste) marks you as concentrating, shown in a bar above the effects list.
- Casting a second concentration effect ends the first **and revokes it from everyone
  holding it** — their panels drop it with a note saying you stopped concentrating.
- **Drop** ends it manually. A long rest ends it too.

Wire format is JSON under TaleSpire's 500-character sync cap, broadcast to `"board"`
so each panel decides whether a message is addressed to it — that avoids per-client
addressing and the 20-target `multiSend` limit. Unknown protocol versions are ignored
rather than guessed at.

### What this does not survive

If a recipient is offline when you drop concentration, the revoke never reaches them
and their copy of the effect persists in their own storage. Effects show their source
(`from Tor`) and can be removed by hand, which is the cheap mitigation. Pinging the
source client on load to confirm it's still live would be the thorough one.

**Buff dice are staged as their own roll group, not appended to the d20 string.**
With advantage that distinction is the difference between right and wrong: Bless is
one d4 added to whichever d20 survives, not a d4 rolled twice and compared along
with it.

## Spells a feature grants

D&D Beyond's character export has one specific hole: spells a subclass grants
through its feature table are never exported as spell objects. The fixture character, a level 3
Twilight Domain cleric, should have faerie fire, moonbeam, see invisibility and
sleep always prepared. His payload contains nine class spells and none of those
four. Walking every string in the export, "Faerie Fire" appears three times:

    data.classes.0.subclassDefinition.classFeatures.0.description   <- prose table
    data.classes.0.classFeatures.0.definition.description           <- same table again
    data.choices.choiceDefinitions.6.options.63.label               <- an unrelated picker

`spellListIds` is empty on the feature, and a fresh uncached fetch
(`providedFrom: "storage"`) returns the same. The website shows them because it
merges the subclass's spell list in from a separate service the panel can't call.

So the names are parsed out of the feature's table, at compaction time because
compaction strips the prose they live in, and the definitions come from the 2024
SRD bundled in `symbiote/data/spells.js`:

    node dev/fetch-spells.mjs

The 2024 SRD specifically, not 2014 — the editions genuinely differ on some of
these. 2014 sleep drops creatures by hit point total; 2024 sleep is a Wisdom save
against Incapacitated. Shipping the wrong one would be quietly wrong on exactly
the spell someone is about to cast.

Two Open5e quirks are worth knowing. `attack_roll` is unreliable — Faerie Fire
carries it despite being a Dexterity save with no attack — so a spell that names
a saving throw is treated as a save spell. And healing spells put their dice in
`damage_roll` with no `damage_types`, which is how Cure Wounds is recognised as
healing rather than damage.

## Attacks, damage, and upcasting

**Attack and damage are separate rolls.** Clicking an attack rolls the d20 only and
parks the damage. When the DM calls the hit, one click rolls it — and a natural 20
offers a *Crit* button that doubles the dice but not the modifier. This is deliberate:
hit and miss is the DM's call (a player's client can't read an enemy's AC), so rolling
damage up front rolls dice you often don't need and front-runs the table.

**Leveled spells show the slots they can be cast with.** Pick a level and the dice
update — Guiding Bolt reads 4d6 at level 1 and 6d6 at level 3. *Cast* spends the
chosen slot; warlocks get a separate pact chip.

Upcast scaling is not shipped as data by D&D Beyond — `atHigherLevels` is empty even
for spells that plainly scale — so it is parsed from the rules text, which is reliably
boilerplate: "The damage increases by 1d6 for each spell slot level above 1." A spell
whose scaling doesn't parse still upcasts, it just doesn't change dice, which is
correct for spells that scale in targets or duration instead.

**Conditional damage is offered, never assumed.** Toll the Dead's "1d12 if the target
is missing any of its Hit Points" is pulled from the same text and shown as an
alternate button labelled with its condition. The panel cannot see whether the target
is hurt, so the player chooses.

## Advantage, disadvantage, and misclicks

The mode bar is the primary control and stays on your choice until you change it.
Shift-click and Ctrl-click still work, but they cannot be relied on: TaleSpire's
webview delivers a click without modifier flags, so `ev.shiftKey` is false in game
even while the key is held. The panel therefore also tracks Shift and Ctrl from
`keydown`/`keyup` and uses that when the mouse event carries nothing — verified in
a browser by dispatching a flag-less click with the key held. If the host swallows
the key events too, the bar still works.

Dice cannot be retracted. `putDiceInTray` is one-way; the API has no remove, and
the only removal signal is the `rollRemoved` event TaleSpire fires when a player
dismisses them in the tray. So the panel shows what it is waiting on and offers
**Ignore**, which drops its own tracking — the dice themselves are yours to clear
in game. `rollRemoved` also clears tracking, so dismissing in the tray is enough.

Tracking also expires on its own after two minutes (`Rolls.STALE_AFTER_MS`),
swept every ten seconds. This is not a board cleanup and cannot be: no Symbiote
can remove dice. It stops the panel staying armed on a roll that was never
thrown, which would otherwise narrate a misclick and arm a damage button off it,
possibly an hour later in a different fight. The bar shows the wait once it
passes twenty seconds.

## Targeting

`TS.picking.startPicking()` hands control to a board tool that reports back what
was clicked. Three things about it shape the code:

- **It returns scenery too.** `kindOfPicked` can be `tile`, `prop` or `unknown`
  as easily as `creature`. Ignoring those silently left the "click a mini" prompt
  on screen, which read as the panel having hung.
- **It can be cancelled.** `pickingCanceled` arrives when the player backs out;
  the prompt has to come down then too.
- **The tool stays active.** There is no `stopPicking` in the API — TaleSpire
  keeps the picker until the player dismisses it with Esc or right-click, so the
  prompt says so.

Stats are subject to TaleSpire's own visibility rules: a player sees the name of
a mini they do not own and nothing else, so `stats` comes back empty and the
panel reports the target without an AC rather than treating it as a failure. GMs
see everything. Every one of these outcomes is reproducible outside the game —
set `window.devPick` to `owned`, `foreign`, `missing`, `tile`, `prop` or `cancel`
before pressing **Pick target** in browser dev mode.

## GM: the party view

A GM's client is given full stats on every mini, where a player sees only their
own. The **Party** button in the header — hidden unless `players.getMoreInfo`
reports `canGm` — opens a live read-only view built on that: name, owner, HP with
a bar, AC, and flying/hidden markers, with the left edge coloured as a character
passes half and quarter health.

It stays current through `creatures.onCreatureStateChange`, which fires per
changed property. A single hit can produce several events, so they're coalesced
into one refetch 150 ms later rather than a call per event. Structural events
(`creatureAdded`, `creatureRemoved`) force a full re-read; the rest are ignored
unless they name a mini already on the list.

Who counts as the party: `parties.getParties()` when the GM has set parties up,
otherwise every mini owned by a player, which needs no configuration and is the
same set in practice. Both of those calls are GM-gated — a player's client gets
`insufficientRights` — which is the other reason the button stays hidden for them.

It is read-only because the API is: a Symbiote cannot write hit points, move a
mini, or set a condition. The board stays the source of truth and this reflects it.

## GM: monsters

The **Monsters** view searches a bundled copy of the 322 SRD monsters and opens
any of them as a rollable sheet: attacks stage to-hit and damage in one throw,
abilities roll saves, skills roll checks. **Speak as…** picks a mini and routes
every roll through `chat.sendAsCreature`, so the chat reads as the monster
rather than as you — a GM-only call.

Open5e is the second source, behind a checkbox. Its catalogue is 3,207 monsters
across Tome of Beasts 1/2/3/2023, Creature Codex, Monstrous Menagerie, Tal'Dorei
and Black Flag, all OGL/CC/ORC. Unlike D&D Beyond it sends
`access-control-allow-origin: *`, so the panel queries it directly — no paste, no
server. It is opt-in because it is the only request this mod makes off your
machine, and the search term travels with it.

`node dev/fetch-monsters.mjs` rebuilds the bundled file; `--source tob` bundles a
different document instead. The licence of each source travels with the data and
is shown on the sheet.

### Reading a statblock

Open5e's data is structured, which is why this needed no statblock parsing — but
three things in it are not trustworthy and the normalizer works around each:

- **`attack_bonus` is not the to-hit.** It disagrees with the printed text on ten
  of the SRD's 507 attacks, most memorably a Vampire Spawn whose field says 61
  and whose text says +6. The text is the published statblock, so it wins.
- **A breath weapon carries `attack_bonus: 0`.** Treating a number as proof of an
  attack turns a DC 21 Dexterity save into a +0 attack roll. The signal is the
  phrase "Melee/Ranged Weapon Attack:", which 5e statblocks always print.
- **`damage_dice` is sometimes missing** when the text plainly states the dice, so
  the parenthesised groups are the fallback: a Vampire Spawn's bite reads
  "6 (1d6 + 3) piercing plus 7 (2d6) necrotic" and rolls 1d6+3+2d6. Where there
  are no dice at all ("Hit: 1 piercing damage") the flat number is shown rather
  than rolled — the leading figure on a dice attack is the average, and rolling
  it would be wrong.

## GM: encounters and initiative

**Fights** holds prepared encounters, saved by name in campaign storage, so both
of the evening's fights can sit ready and be called up when the party walks into
them. Adding a monster three times makes three combatants rather than one with a
count, because three goblins take damage and die separately.

**Linking a mini** to a combatant is what ties the panel to the board, and it
decides who owns the hit points. There are two possible truths and they are
ranked deliberately:

- If the linked mini has hit points set in TaleSpire, **the board wins**. The
  panel reports them live and hides its own controls — a Symbiote cannot write
  HP, and showing an editable number that changes nothing would be a lie.
- If it doesn't — and plenty of GMs never fill them in — **the panel keeps the
  count**, and the hit points themselves are the control: the number on each row
  is an input. Typing `12` sets it, `-5` and `+3` change it. The relative form is
  the one that matters in play, because a player calls out their damage and the
  GM types it with no arithmetic and nothing to aim at but the row in front of
  them. A shared amount box above the list did the same job at first and was
  wrong: it sat nowhere near the rows it acted on.

Either way there is one number, and hovering it says where it came from.

**Turn order** is TaleSpire's. `initiative.getQueue()` is read-only and there is
no writer, so the tracker reflects the queue rather than keeping an order of its
own. It is fetched when the view opens and then polled every three seconds while
it stays open, because `initiativeUpdated` fires when the turn moves or the queue
is edited — not dependably when initiative first starts. It reads `items[]` and
`activeItemIndex`, and clicking a turn opens that monster's statblock with its
attacks ready to roll.

Matching a turn to a combatant is not as simple as it looks. The obvious key is
the creature id, but the API describes a turn item's `id` as identifying *the
turn entry*, and it does not match the creature. So the id is tried first and the
mini's **name** second — which means the name has to be known, and links made
before it was stored get backfilled from the board the next time the encounter is
opened, rather than asking a GM to re-link a fight they already set up.

Matching runs in three passes, strongest key first, each claiming from one pool
so no combatant is ever handed to two turns:

1. **`turnId`** — the GM bound this turn to this combatant by hand. Nothing
   overrides it.
2. **`creatureId`** — the mini the combatant is linked to, when the queue keys on
   creatures.
3. **name** — a guess, resolved last, from whatever is left, paired in queue order.

Names come last because they are deliberately decoupled. A GM may run a Goblin
Boss statblock on a mini called Goblin Captain simply because they liked the
model; the statblock's name and the mini's name are different facts about the
same combatant and neither is an identifier. Storing the mini's name at link time
covers that case, but it breaks the moment a mini is renamed — so every turn
carries a dropdown naming which combatant is taking it. Choosing one writes
`turnId` and the guessing stops. Rows say how they were matched: `assigned`,
nothing (by id), or `by name`.

The link itself was never ambiguous: it stores the mini's creature id, unique per
mini. Only the fallback deals with names at all.

A turn matching nothing gets no label at all. Most of those are the party, and
calling a player's character an outsider to the fight reads worse than silence.

TaleSpire keeps the queue after you leave turn-based mode, reporting it with no
active index. The tracker still shows the order, marks nothing as current, and
says why.

**Applying the party's damage.** A Symbiote is told about every roll on the
board, not only its own — the docs are explicit that the `clientId` on a result
exists so you can filter out your own rolls if you want to. That makes the
useful direction possible: when a player rolls damage, it appears in the GM's
encounter as an offer. Select a combatant, press the button, done.

Which number to take is a guess made carefully. A roll staged by this mod names
its damage group "<something> damage", so when such a group exists only those are
summed and the attack roll beside them is ignored; anything else is taken whole.
Nothing is ever applied automatically — a roll is not a hit, and only the GM
knows whether it landed. Offers older than the last three are dropped.

A combatant whose hit points belong to the board refuses the damage and says so,
rather than quietly changing a number that isn't the one on screen.

Monsters from Open5e travel with the encounter that uses them; bundled SRD ones
are stored by slug and re-read from the shipped file.

## Link probe: could a browser extension drive this?

Scaffolding, not a feature. `symbiote/lib/linkprobe.js` plus the `urls`
subscription and the `onUrlMessage` global exist to settle one question before
any extension work starts.

TaleSpire registers a `talespire://` protocol handler. Two verbs matter:

    talespire://dice/Guiding%20Bolt:d20+5/4d6      no mod needed; dice land in the tray
    talespire://symbiote/<interopId>/<payload>     delivered to us via urls.onUrlMessage

The second is the interesting one, because the message arrives as *our code* —
so advantage still keeps the higher d20, chat still posts as the linked
creature, damage still reaches the GM's inbox. The API docs also say a Symbiote
that isn't running "will be loaded and then receives the message", which would
mean an extension could wake the panel.

The probe's log persists across panel restarts, because the case that matters
most is the coldest one — game shut, URL opened from a browser, panel launched
to receive the message. An in-memory log is empty by the time anyone can read
it, which makes a delivered message look identical to a dropped one. TaleSpire
writes no `.debug/log.txt` for console output, so this log is the only evidence
channel.

Open the library (☰) and expand **Link probe**. It reads the prefix, walks a
ladder of payload sizes through `TS.urls.submit()`, and stops at the first
size that fails — counting a *truncated* arrival as a failure, since a silently
shortened message is worse than a dropped one. **Copy 512-char URL** puts a probe
URL on the clipboard for the other test: paste it into a browser address bar,
which is the path an extension actually takes (Chrome → OS handler → TaleSpire).
That hop has its own, usually lower, ceiling.

**Result — measured in the game, 0.10.6.** The mechanism works.

| Question | Answer |
|---|---|
| Does a browser-opened URL reach the panel? | Yes, via `onUrlMessage` |
| Does TaleSpire launch to receive one? | Yes, from fully closed |
| Payload limit | **1984 chars** (URL 2046 — a 2048 cap) |
| Over the limit | `urlRejected`, an explicit error, not a silent drop |
| Latency, in-game `submit` | ~7 ms |
| Latency, browser paste | ~7 s, mostly app focus switching |

Three rounds of false negatives came from the probe rather than the mechanism,
and each is worth remembering:

1. The handler guessed which event field held the payload, and guessed wrong —
   it now takes the whole event and digs the payload out.
2. **TaleSpire delivers the raw URL segment still percent-encoded.** `p1:512:abc…`
   arrives as `p1%3A512%3Aabc…`, four characters longer and unrecognisable to a
   parser expecting colons. The dev stub now encodes the same way.
3. The doubling ladder reported the last rung that passed, not the limit — off
   by up to 2x. It now binary-searches the gap.

Design consequences:

- **Rolling over a Symbiote URL is comfortable.** A roll is ~130 characters
  against a 1984 budget, and it arrives as our own code, so advantage, chat
  attribution and the GM's damage inbox keep working.
- **Use base64url, never plain base64.** `+` and `/` are escaped or, worse,
  split the path. base64url travels unescaped, which is where the 1488 bytes per
  message comes from.
- **Don't chunk a character across 14 URLs.** An extension can read the
  character directly with the user's own session — no CORS problem, and no
  "set privacy to Public" — then hand it over via the clipboard in one step.
  That is fewer moving parts than chunking and removes a real privacy concession.

What the numbers decide:

| Payload | gzip + base64 | Messages needed |
|---|---|---|
| One roll | ~130 chars | 1 |
| Normalized sheet | 12 KB | 7 |
| Compacted source (what we store) | 26 KB | 15 |

Rolling is viable at almost any ceiling. Carrying a whole character is the part
that depends on the answer — and the reason to measure before building.

Delete the file, its script tag, the subscription and the global when the
question is settled.

## What a file origin forbids

A Symbiote installed locally is loaded from a file origin, not served over http.
Three consequences, each of which works fine in `dev/serve.mjs` and fails only in
the game — the worst way for a bug to behave:

- **No ES modules.** Every script is a plain classic script; `preflight` fails the
  build if a `type="module"` appears.
- **No same-origin `fetch`.** Fetching a relative path is blocked, so the bundled
  monsters arrive through an injected `<script>` that assigns
  `window.SPIREKEEPER_MONSTERS`, and the panel's own version is a constant in
  `app.js` rather than read from the manifest. `preflight` fails on any relative
  `fetch()` and on the version drifting from the manifest.
- **Cross-origin `fetch` is fine** where the server allows it. Open5e sends
  `access-control-allow-origin: *`, which covers the `null` origin a file page
  presents, so the opt-in online search still works.

The monster data is ~540 KB, so it loads on first use of the Monsters view rather
than at startup: a character sheet should not wait on a bestiary.

## Where TaleSpire keeps the data

Not in the browser. TaleSpire writes a Symbiote's storage into the Symbiote's own
folder:

```
symbiote/.localStorage/global      <- the sheet library, follows you between campaigns
symbiote/.localStorage/<campaignId> <- bindings and encounters for one campaign
```

Two things follow. The data travels with the folder, so renaming the folder in
`Symbiotes/` moves it too and loses nothing. And the folder must never be
packaged or committed as-is — `.gitignore` excludes it, because it holds real
characters.

It is also the proof that compression works in the game and not only in a dev
browser: those files open with `{"format":"sheetbridge/gzip-base64"...}`.

## An API quirk worth knowing

`TS.creatures.getMoreInfo` is documented as taking `Array[fragmentOrId]` — either
`{ id }` objects or bare id strings. Bare strings come back empty. The symptom was
a GM being told that a mini they had just placed themselves was not visible to
them, which is the least helpful thing the panel could possibly have said.

Every call in this mod that worked happened to pass fragments (`players.getMoreInfo([me])`);
every one that failed passed strings. `lib/board.js` now wraps the call, asking
with fragments and falling back to ids, so it survives whichever form a future
build prefers — and the dev stub reproduces the quirk so a regression shows up
outside the game.

Linking never depended on the answer anyway: it needs an id, which the picker
already gave us. A failed lookup now costs the mini's name, not the link.

## Two declarations, one name

Twice now a function has been declared twice in the same scope — `renderBindBar`
early on, and `refreshInitiative` later, where one copy fed the character sheet
and one fed the GM's encounter tracker. JavaScript takes the later declaration
and silently discards the earlier, so every existing call site starts running the
other body. Nothing throws. The symptom was an initiative tracker that sat on
"Not in initiative" no matter what the game was doing.

`dev/preflight.mjs` now fails the build on any function declared twice at the same
nesting level within a file. It found a third case on its first run — a duplicated
`cantripMultiplier` in `lib/ddb.js`, harmless because the bodies were identical,
but dead code that had been shipping for a while.

## Known gaps

These are deliberate omissions, not bugs to trip over later:

- **No HP write-back to minis.** Symbiotes cannot modify the board. The panel tracks
  its own character's HP; it never changes anyone else's. Changing that means a
  BepInEx plugin in C#.
- **No stopPicking.** Once the picker is on, only the player can dismiss it
  (Esc or right-click). The panel says so but cannot do it for you.
- **Hit/miss needs a visible AC.** A player's client can only read stats on minis
  they own, so targeting usually reports the name without a verdict. GMs see both.
- **Monster HP can't be written to minis.** The encounter tracker keeps its own
  count, or defers to the board when the mini already has hit points. It can
  never push a number onto a mini.
- **Initiative is roll-and-tell.** The rolled number can't be pushed into TaleSpire's
  turn tracker; the API has no writer for it.
- **Conditions don't reach the mini.** They're panel-side only, for the same reason —
  and TaleSpire has no condition concept on creatures to write to even if it did.
- **One character sheet, 5e only.** Pathbuilder and Demiplane would each be a new
  adapter feeding the same normalized shape.
- **Feature-granted spells are filled from the SRD, not from D&D Beyond.** The
  character export names a subclass's always-prepared spells only inside the
  feature's prose — `spellListIds` is empty and they never appear in `classSpells`
  — so the panel parses the names out and looks them up in the bundled 2024 SRD.
  A granted spell that isn't in the SRD is listed by name with a note. See
  §Spells a feature grants.
- **Modifier-key rolling depends on the host.** Shift and Ctrl reach the panel in a
  browser but not always inside TaleSpire; the mode bar is the control that always
  works.
- **A staged roll can't be recalled.** The panel can stop listening, but the dice
  stay in TaleSpire's tray until you dismiss them there. No API exists for it.
- **Conditional modifiers are shown, never applied.** A restriction like "advantage
  to avoid the Poisoned condition" is displayed as a caveat rather than folded into
  a number, because folding it in would be silently wrong.
- **Concentration has no saving throws.** Taking damage should force a CON save to
  keep it; the panel can't see incoming damage, so it doesn't ask. Drop it manually.
- **Only granted effects are concentration-aware.** An effect you add for yourself and
  never grant is tracked, but a spell cast purely from the Spells tab doesn't start
  concentration — the two systems aren't linked yet.
- **Weapon effects cover ability, die, damage type and flat bonuses.** Anything odder
  than that (extra attacks, reach changes, conditional riders) isn't modelled.
- **Effects are a tracker, not a rules engine.** Nothing stops you stacking two
  copies of Shield of Faith or applying a buff that shouldn't apply — the panel
  records what you tell it.
- **Resource options are matched by name.** A feature whose options aren't named
  `Parent: Child` won't group — they surface under their own prefix instead of
  vanishing, but the pairing is textual, not structural.
- **Storage is finite, but generous.** See §Storage. A GM would need well past ten
  level-20 characters to run out; a player never will.
- **Ability score caps assume the modifiers are honest.** The 20 cap is applied and
  raised by `ability-score-maximum` bonuses, which is how Epic Boons legally reach
  26. A homebrew item that raises a score without also raising the maximum will be
  clamped — matching D&D Beyond, which does the same.
- **Rest rules are the common ones.** Hit dice regain half on a long rest; class
  features that break that rule (Warlock's Pact of the Tome variants, Durable, and
  similar) aren't special-cased.

## Verified

Against the bundled fixture (Dwarf Cleric 2 — a real export with its identities
replaced, see `dev/scrub-sample.mjs`), the normalizer computes
AC 18, HP 23, Init +0, passive perception 13, spell DC 13 / attack +5, three level-1
slots, Channel Divinity 2/2, Club `d20+4` / `1d4+2`, Shortbow `d20+2` / `1d6`.

Spell slot progressions were checked against eleven class combinations, including
the single-class versus multiclass half-caster difference: a lone Paladin 5 gets
4/2, while Paladin 5 / Cleric 1 contributes `floor(5/2)` and also gets 4/2, and a
Champion Fighter 7 gets nothing while an Eldritch Knight 7 gets 4/2.

Rolling was exercised end to end in browser dev mode, which simulates the dice tray:
an attack rolls the d20 alone and parks its damage, a natural 20 offers crit damage
at doubled dice, advantage stages two d20 groups quietly and keeps the higher, and
hit dice, rests, slot spending and upcasting all round-trip through stored play state.

Effect routing was checked per roll type: with Bless and Guidance both active, an
attack stages `d20+4` plus a `Bless 1d4` group, a skill check stages `Guidance 1d4`
instead, a saving throw gets Bless again, and Guidance suspends itself after use.
Temp HP refuses a smaller pool, and 9 damage against 6 temp HP leaves 20/23.

A Rogue 8 / Sorcerer 8 / Warlock 4 resolves as: 12d8 (Rogue and Warlock merged) plus
8d6, twenty dice returning ten on a long rest; shared slots of 4/3/3/3/2 if the Rogue
is an Arcane Trickster or 4/3/3/2 if not; and two level-2 pact slots on a short rest,
correctly excluded from the shared pool. Arcane Trickster and Eldritch Knight are
detected from the subclass's casting ability, its `canCastSpells` flag, or its name,
because missing it costs a whole slot tier.

Multiclass hit dice were checked across five splits: pools merge by die type
(Fighter 3 / Paladin 2 is one 5d10 pool, not two), spending from one pool leaves the
others untouched, and long-rest recovery returns half the total — 5 of 10 for a
Fighter 5 / Wizard 5, 3 of 6 for a Fighter 3 / Wizard 2 / Rogue 1, and a minimum of
one for a level-1 character.

Weapon effects were checked both ways: Shillelagh on a Club rebuilds it as
`1d8+3 / +5` from Wisdom while leaving the Shortbow untouched, and a sheet saved by an
earlier version — carrying only `damageRoll: "1d4+2"` with no breakdown — recovers the
same result instead of producing `NaN`.

Effect passing was exercised through a sync loopback in dev mode: granting Bless to two
players records `Kree …, Gronk chat`, an inbound acknowledgement flips it to `Kree ✓`,
an inbound grant raises an Accept/Decline card, and granting a second concentration
effect drops Bless from the list and broadcasts a revoke.
