# Attic

Working code that is not part of the mod, kept because it is the tool for
re-opening a closed question rather than because it might be tidied up later.

## `linkprobe.js`

Measures whether a `talespire://symbiote/<id>/…` URL reaches a Symbiote, and how
much payload it carries. It established the finding that killed browser rolling:
such a URL arrives only when TaleSpire is **not already running**, while
`talespire://dice/` arrives either way. See the main README, "Link probe".

To use it again, drop it back into `symbiote/lib/`, add a script tag, add the
`urls` subscription to the manifest, and add a global:

```js
function onUrlMessage(event) { LinkProbe.received(event); }
```

then `LinkProbe.configure({ host: someElement })`. Its styles are in git
history alongside it.

Worth re-running after a TaleSpire update — the limitation may be a bug rather
than a policy, and if it lifts, rolling from a browser extension becomes
possible again with advantage, effects and chat attribution intact.
