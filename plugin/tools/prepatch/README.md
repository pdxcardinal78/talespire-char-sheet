# prepatch

Empties `HarmonyInteropFix.Apply` in BepInEx 5's `BepInEx.Preloader.dll`.

On Apple Silicon that method's MonoMod detour throws (`DetourHelper.GetIdentifiable`
returns null on arm64), which kills the preloader before it can hook the
chainloader, so no plugin ever loads. Nothing Spirekeeper loads needs the
Harmony interop shim, so a no-op is safe.

```bash
dotnet run --project plugin/tools/prepatch -- \
  plugin/.tools/bepinex/BepInEx/core/BepInEx.Preloader.dll \
  plugin/.tools/BepInEx.Preloader.patched.dll \
  plugin/refs
```

Rebuild it whenever the BepInEx version in `build.sh` changes.
