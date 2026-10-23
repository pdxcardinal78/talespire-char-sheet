# Spirekeeper bridge (proof of concept)

A BepInEx plugin that lets the Spirekeeper panel do what Symbiotes can't:
write to the board. It runs a small HTTP server on `127.0.0.1:47817` inside
TaleSpire, and the panel calls it.

```
plugin/
  src/Bridge.cs           plugin entry, localhost server, main-thread pump
  src/Routes.cs           the routes that read or write TaleSpire
  probe-symbiote/         a throwaway test panel, installed beside Spirekeeper
  tools/prepatch/         builds the Apple Silicon BepInEx preloader
  build.sh                compile the plugin and the patched preloader
  install-mac.sh          install BepInEx, the plugin and the probe panel
  diag-mac.sh             launch with logging on and collect diagnostics
  refs/                   TaleSpire's own DLLs (gitignored, never commit)
  .tools/                 BepInEx download, patched preloader (gitignored)
  dist/                   build output (gitignored)
```

## Status

Tested on an M5 Pro MacBook Pro, TaleSpire on Unity 2021.3.45f2, BepInEx
5.4.23.5. Board writes verified on plugin 0.1.2; 0.2.0 adds the security below.

| Check | Result |
|---|---|
| BepInEx loads in the native Apple Silicon build | Passes, with the workarounds below |
| Plugin loads and its server stays up | Passes |
| Symbiote panel can call `127.0.0.1` | Passes |
| Plugin sets a mini's HP, and Spirekeeper sees it via `onCreatureStateChange` | Passes |
| Plugin toggles persistent emotes on a mini | Passes |
| A client **without** the plugin sees the GM's changes (HP and emotes) | Passes, verified on a second account |

Because changes sync to clients without the plugin, only the GM needs to install it.

## Apple Silicon workarounds

Stock BepInEx 5 doesn't run in the native arm64 build of TaleSpire. Three
problems surfaced, in order; `install-mac.sh` handles all of them, and the
first two only on Apple Silicon (it checks `sysctl hw.optional.arm64`, which
reports the real CPU even from a shell running under Rosetta).

### 1. The preloader crashes on its first Harmony patch

BepInEx's patching library, MonoMod.RuntimeDetour, predates arm64 support.
The first thing the preloader does is apply `HarmonyInteropFix`, a runtime
detour on `Assembly.LoadFile`, and on arm64 that throws:

```
HarmonyException: Patching exception in method Assembly::LoadFile
  at MonoMod.RuntimeDetour.DetourHelper.GetIdentifiable (...)
  at BepInEx.Preloader.RuntimeFixes.HarmonyInteropFix.Apply ()
  at BepInEx.Preloader.Preloader.Run ()
```

The preloader dies before it can hook Unity, so no plugin ever loads and no
`LogOutput.log` is written; the only trace is a `preloader_*.log` in the game
folder. The `ApplyRuntimePatches` setting doesn't help, because this one patch
runs regardless of it.

**Fix:** `tools/prepatch` rewrites `BepInEx.Preloader.dll` with that one method
emptied, using Mono.Cecil. `HarmonyInteropFix` only shims plugins built
against old Harmony versions, which nothing here uses. `build.sh` produces the
patched copy in `.tools/`, and the installer copies it over the stock one.

### 2. The optional runtime patches use the same broken detours

**Fix:** the installer sets `ApplyRuntimePatches = false` in
`BepInEx/config/BepInEx.cfg`. This skips BepInEx's console and Unity log
patches. On Intel Macs it's set back to `true`.

What this rules out on Apple Silicon: **any plugin that uses Harmony** will
fail, since every Harmony patch goes through the same detour code. The bridge
calls TaleSpire's own methods directly and never patches anything, so it isn't
affected. Moving to BepInEx 6, whose newer MonoMod supports arm64, would lift
that restriction if a future feature needs Harmony.

### 3. TaleSpire destroys BepInEx's manager object during startup

Not Apple Silicon specific. BepInEx attaches plugins to a manager GameObject,
and TaleSpire destroys it while loading scenes. Version 0.1.0 stopped its
server in `OnDestroy`, so it logged "Listening" and then refused every
connection moments later.

**Fix (in the plugin):** the server and its work queue are static, and the
main-thread pump lives on its own `DontDestroyOnLoad`, `HideAndDontSave`
GameObject. Both log a warning if destroyed. The log line
`BepInEx manager object destroyed; bridge keeps running` is expected.

### Not a problem, despite looking like one

The stock `run_bepinex.sh` relaunches through `arch -e` on Apple Silicon and
passes the doorstop library by bare name. That loads fine; no launcher change
is needed beyond naming the app.

## What the decompile found

TaleSpire's game code is `Bouncyrock.TaleSpire.Runtime.dll`, not the usual
`Assembly-CSharp.dll`. The useful entry points, all on `CreatureManager`:

| Call | Does |
|---|---|
| `SetCreatureStatByIndex(id, stat, -1)` | Sets HP. Index `-1` is HP, `0` to `7` are the campaign's named stats. This is what the radial menu's HP field calls. |
| `AddPersistentEmote` / `RemovePersistentEmote` | Toggles the persistent emotes shown on a mini, the nearest thing to a condition marker. |
| `SetCreatureName`, `SetCreatureFlyingState`, `SetCreatureExplicitHideState` | Name, flying, hidden. |

Each of these sends a board sync op (`SetCreatureHpOp` and friends), and the
handler that applies it has no rights check of its own. So a change made on the
GM's machine lands on every client, as the status table confirms.

Initiative is writable too: `InitiativeManager.SyncQueueList` and
`SetCurrentElement` send `SetLineupOp` and `SetCurrentTurnElementOp`. Not wired
up yet.

TaleSpire serves symbiote panels from its own `HttpListener` on
`http://localhost:<random port>/symbiotes/`, which is why a panel can call the
bridge on `127.0.0.1` without browser security getting in the way.

Unrelated to the plugin, but useful: the symbiote API's `creatureInfo` already
includes each mini's `position` and `rotation`, so an area-of-effect helper
(who is inside this circle or cone) can be built in Spirekeeper itself.

## Routes

| Route | Does |
|---|---|
| `GET /ping` | Version check; no game access, open to anyone |
| `GET /whoami` | Whether this client has GM rights |
| `GET /selected` | The selected mini: id, name, HP, persistent emote ids |
| `GET /creature?id=` | The same for any mini on the board |
| `GET /creatures` | Every mini on the board: `[{ id, name, x, y, z, scale, hidden }]`, positions in tiles. Read by reflection from `CreatureManager._creaturesData`; the symbiote API has no "all minis" call. Added in 0.4.1 |
| `GET /statuses` | TaleSpire's statuses (persistent emotes) by name: `[{ id, name, icon }]`, from `EmoteManager.GetCollection()`. Added in 0.4.0 |
| `POST /hp?id=&value=&max=` | Set HP; `max` optional. GM only |
| `POST /stat?id=&index=&value=&max=` | Set one of the campaign's 8 named stats (index 0 to 7), e.g. a Temp HP stat; `max` optional. GM only. Added in 0.3.0 |
| `POST /emote?id=&emote=&on=0\|1` | Remove or add a persistent emote. GM only |
| `POST /zone?ruler=&name=` | Keep a placed ruler on the board as one of TaleSpire's area markers (`AoeManager.AddAoe`), returning its `id`. Works on a player's ruler too, since rulers are shared. GM only. Added in 0.4.0 |
| `POST /zone-remove?id=` | Remove an area marker made by `/zone`. GM only. Added in 0.4.0 |

## Security (0.2.0)

- **Only TaleSpire's own panels.** Every route but `/ping` requires an `Origin`
  header equal to TaleSpire's symbiote server (`http://localhost:<port>`, read
  from `WebViewEnvironment` at runtime since the port changes each launch).
  Browsers always send `Origin` on a cross-origin request and pages can't forge
  it, so a website open in Chrome can't drive the bridge. CORS headers echo
  that origin only.
- **Writes are POST and GM only.** TaleSpire applies these ops on every client
  without checking rights, so the plugin checks `LocalPlayer.Rights.CanGm`.
  Refusals are logged as warnings in `LogOutput.log`.
- **Not covered:** a native program on the same Mac can forge an `Origin`
  header. Anything able to do that can already do far worse, so this is out of
  scope.

### Testing with curl

`curl` sends no `Origin`, so from 0.2.0 it's refused. To test from Terminal,
set this in `BepInEx/config/net.spirekeeper.bridge.cfg` (created on first
launch) and restart TaleSpire:

```
[Security]
AllowRequestsWithoutOrigin = true
```

Turn it back off afterwards. Writes then look like:

```bash
curl -s -X POST -G http://127.0.0.1:47817/hp --data-urlencode "id=$MINI" -d value=12
curl -s -X POST -G http://127.0.0.1:47817/emote --data-urlencode "id=$MINI" --data-urlencode "emote=$EMOTE" -d on=0
```

## Build

Needs the .NET SDK 8 or newer (`brew install dotnet`) and TaleSpire's DLLs:

```bash
mkdir -p plugin/refs
cp ~/Library/Application\ Support/Steam/steamapps/common/TaleSpire/TaleSpire.app/Contents/Resources/Data/Managed/*.dll plugin/refs/
./plugin/build.sh
```

That writes `dist/SpirekeeperBridge.dll` and `.tools/BepInEx.Preloader.patched.dll`,
downloading BepInEx into `.tools/` on first run. The compile targets
TaleSpire's own `mscorlib` (`-nostdlib`), so no NuGet packages are involved.

## Install and launch

```bash
./plugin/install-mac.sh
cd ~/Library/Application\ Support/Steam/steamapps/common/TaleSpire && ./run_bepinex.sh
```

Steam must be running. Launching TaleSpire normally (Steam's Play button, the
Dock) is always plain, unmodded TaleSpire; BepInEx only loads through
`run_bepinex.sh`. To make Steam's Play button use it, set Launch Options to:

```
"/Users/ryanj/Library/Application Support/Steam/steamapps/common/TaleSpire/run_bepinex.sh" %command%
```

Remove everything with `./plugin/install-mac.sh --uninstall`.

## Test checklist

| # | Do this | Confirms |
|---|---|---|
| 1 | Launch with `./run_bepinex.sh` | BepInEx can start the game |
| 2 | `BepInEx/LogOutput.log` shows `Spirekeeper Bridge 0.2.0 loaded` and `Accept loop running` | the plugin loads |
| 3 | `curl -s http://127.0.0.1:47817/ping` | the server is up |
| 4 | Open a board and the **Spirekeeper Bridge Probe** panel; Bridge says *connected* | a panel can reach the plugin |
| 5 | Select a mini, **Use selected mini**, **−5**: HP drops on the board and the log shows an `event` line | HP write, seen by Spirekeeper |
| 6 | Repeat 5 and 7 with a second client on the board running plain TaleSpire | changes reach clients without the plugin |
| 7 | Give a mini a persistent emote, then with curl allowed (see Security) `GET /selected` and `POST /emote` with `on=0` | conditions can be toggled on minis |

## Troubleshooting

`./plugin/diag-mac.sh` (with TaleSpire quit) turns on BepInEx logging, launches
the game, waits 45 seconds, and collects `LogOutput.log`, any
`preloader_*.log`, Unity's `Player.log` and the BepInEx config into
`.tools/diag/`.

| Symptom | Meaning |
|---|---|
| No `LogOutput.log` and a `preloader_*.log` in the game folder | Preloader crashed; check the patched preloader was installed (Apple Silicon) |
| No `LogOutput.log` and no `preloader_*.log` | Doorstop never injected; TaleSpire wasn't started through `run_bepinex.sh` |
| `curl` says connection refused, log says listening | Server was stopped; check you are on 0.1.2 or later |
| `curl` gets 403 "requests without an Origin are refused" | Expected from 0.2.0; see Testing with curl |
| Panel gets 403, log says "origin is not TaleSpire's symbiote server" | The panel isn't being served by TaleSpire, or TaleSpire changed how it hosts panels |
| `curl` works, panel says "Failed to fetch" | Webview is blocking the call; turn on symbiote dev mode for remote debugging |

## Still to do

- **Windows.** Only the macOS installer exists. Windows uses the stock Windows
  BepInEx build and needs none of the arm64 workarounds.
