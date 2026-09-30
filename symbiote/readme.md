# Spirekeeper

Import a D&D Beyond character and play it from the TaleSpire side panel.

## Importing a character

Install the **Spirekeeper** browser extension, then:

1. Open your character on D&D Beyond.
2. Click the Spirekeeper toolbar button, then **Copy**.
3. Paste into the box above and press **Import character**.

Private characters work — the extension reads them with your own signed-in
session, so there is no need to make anything public.

Without the extension there is a manual route under **No extension? Import by
hand**, which does need the character set to Public. Both exist because D&D
Beyond serves no CORS headers: this panel cannot fetch a character itself, and
an extension can. Either way nothing about your character leaves your machine.

Characters are stored in TaleSpire's own storage and stay available across campaigns.

## Gear

The **Gear** tab lists everything you carry. Wear, remove, attune and unattune
items, and the sheet recalculates — equipment feeds armour class, ability scores
and saves, so taking a ring off can change all three. Attunement slots are
tracked, and an unattuned item grants nothing that needs attunement.

## Conditions

Add and remove conditions yourself; the import only seeds what D&D Beyond knew.
Each one shows what it does to you, with the full rules on hover, and exhaustion
works out the penalty for the level you're on. Conditions are never folded into
your rolls — shift-click a roll for advantage, ctrl-click for disadvantage.

## Session notes

The **Notes** tab is somewhere to write things down mid-session — a name, a
rumour, what the door was trapped with — without leaving TaleSpire. Type and
press Enter; notes list newest first with the time you took them. Click one to
edit it, `×` twice to delete it.

Notes belong to the character and stay on this machine. Nothing is posted to
chat, the party can't see them, and a rest doesn't clear them.

## Spells your subclass grants

D&D Beyond names a subclass's always-prepared spells in the feature's rules text
and nowhere else — its own website merges the real definitions in from a separate
service, and the character export doesn't carry them. A Twilight Domain cleric's
export mentions faerie fire, moonbeam, see invisibility and sleep only in prose.

The panel reads those names and fills in the details from the 2024 SRD it ships,
listing them under a heading that says where they came from. They cast, upcast
and post their save DC like any other spell. A spell outside the SRD is listed by
name with a note rather than silently dropped.

## Spells that bring their own uses

A spell from a feat — Magic Initiate's Goodberry, say — often comes with one free
cast per long rest, on top of any slots you could spend on it. Those are marked
**free use**, and the card offers the free cast next to the slots: `Cast using
Free 1/1 · L1 · L2`. The free one is picked for you, and once it's gone the card
drops back to a slot of the spell's own level. A long rest hands it back.

## Rolling

- Click any attack, skill, save, or ability to put dice in the tray, then throw them.
- Attack and damage are staged together, so one throw answers both.
- **Shift-click** rolls with advantage, **Ctrl-click** (or Cmd-click) with disadvantage.
  The buttons at the top set a mode for every roll if you prefer.

Advantage rolls two d20s and keeps one. TaleSpire has no keep-highest notation, so
the panel picks the surviving die and reports it — which is why those results carry
the "sent by a Symbiote" marker. GMs can click through to see both dice.

## Advantage and disadvantage

Use the **Normal / Advantage / Disadvantage** bar above the tabs. It stays on
your choice until you change it, so set it once for a fight and put it back
after. Shift-click and Ctrl-click do the same thing, but TaleSpire does not
always pass modifier keys through to a Symbiote, so the bar is the reliable path.

## Changing your mind about a roll

TaleSpire has no way for a Symbiote to take dice back out of the tray — once
they're staged, only you can clear them, in TaleSpire's own dice tray. What the
panel offers is the **Waiting on …** bar: press **Ignore** and it stops listening
for those dice, so a misclick won't be announced in chat or arm a damage button
when it eventually lands. It also gives up on its own after two minutes.

## Targeting

**Pick target** lets you click a mini, then reports hit or miss against its AC.

This only works when the campaign uses one of its eight stat slots for AC, the mini
has it filled in, and you are allowed to see that mini's stats. TaleSpire shows
players only the minis they own, so as a player you will usually see the target's
name but not a hit/miss verdict. GMs see both.

## Linking a mini

Link a sheet to a mini and rolls post to chat as that character. Selecting a linked
mini brings its sheet up automatically.

## For GMs

If your client can GM, a **Party** button appears in the header. It shows every
party mini's HP, AC and owner in one list, updating live as the board changes —
you see stats on all minis, where a player only sees their own. It is a view, not
a controller: Symbiotes can't write HP or conditions onto minis.

## Monsters

The **Monsters** view ships with the 322 SRD monsters — search, open, and roll
their attacks, saves and skills. Attacks throw to-hit and damage together.

Tick **Open5e** to search a further ~2,900 from Tome of Beasts, Creature Codex,
Monstrous Menagerie and others. That is the one feature here that talks to the
internet, so it stays off until you ask for it.

**Speak as…** picks a mini, and from then on monster rolls post as that creature
instead of as you.

## A monster's spells

A caster's statblock prints its spells as a paragraph of names. The panel reads
that paragraph and looks every spell up, so a Mage's fireball arrives as `8d6`
fire against DC 14 with a button that rolls it, rather than as the word
"fireball". Tap a spell's name to see what it does.

What each spell costs is tracked the way the statblock states it. A level's slots
are pips on its heading; a `3/day each` spell keeps its own count on its own row.
Click a pip to spend one, right-click to give it back — or press **Cast**, which
spends one and says so in chat.

## Changing a monster's spells

A statblock is a starting point as often as it is a rule, so `✎` on any spell
opens four fields: dice, damage type, save DC, to hit. Each shows what it would be
if you left it alone, so the cult that worships a frost god gets `cold` typed into
one box and throws cold fireballs. Clear a field to put it back, or press
**Reset**.

Changes belong to the fight, not the monster: reskin a cultist's fireball and
every cultist in *that* encounter throws it, while the same monster in another
fight is untouched. Spent slots belong to the individual, so one mage running dry
doesn't drain the others. A monster opened straight from the search isn't in a
fight, so its slots and changes last only until you close the panel — it says so
under the form.

## Fights

Build an encounter, name it, and it stays in the campaign until you delete it —
so next session's two fights can both sit ready.

Add a monster from the **Monsters** view and pick how many; three goblins become
three combatants, each with its own hit points. **Link mini** ties one to a mini
on the board. If that mini already has hit points set in TaleSpire, those are
shown and the board stays in charge; otherwise the panel tracks them, and you
edit the number on the row directly — type `12` to set it, or `-5` and `+3` to
change it.

When a player rolls damage, it shows up here: click a combatant to select it,
then press **Apply** and the hit points come off. Nothing lands automatically —
you decide whether the attack hit.

**Turn order** mirrors TaleSpire's initiative. Click any turn to open that
monster's statblock and roll its attacks.

Each turn has a dropdown saying which combatant is taking it. Spirekeeper guesses
from the linked mini and its name, but a mini's name need not match the statblock
you are running on it — a Goblin Boss may be standing on a Goblin Captain model —
so if the guess is wrong, pick the right one and it stays picked. Click a combatant's name to select it,
or **Stat** to open its statblock.

## What it does not do

Symbiotes cannot write to the board, so this panel never changes anyone's HP.
Results go to chat and a human applies them.
