// The bridge's routes: everything that reads or writes TaleSpire itself.
//
// These call the same CreatureManager methods TaleSpire's own radial menu
// uses, found by decompiling Bouncyrock.TaleSpire.Runtime.dll. Setting HP that
// way sends a board sync op, so the change should reach every client on the
// board, not just this one. That is the main thing the test is checking.

using System;
using System.Collections.Specialized;
using System.Globalization;
using Bounce.Unmanaged;

namespace Spirekeeper.Bridge
{
    internal static class Routes
    {
        // Returns null for an unknown route
        public static string Dispatch(string path, NameValueCollection q, string body, Func<Func<string>, string> onMain)
        {
            switch (path)
            {
                case "/whoami": return onMain(WhoAmI);
                case "/selected": return onMain(Selected);
                case "/creature": return onMain(() => Creature(q["id"]));
                case "/hp": return onMain(() => SetHp(q["id"], q["value"], q["max"]));
                case "/emote": return onMain(() => SetEmote(q["id"], q["emote"], q["on"]));
                default: return null;
            }
        }

        static string WhoAmI() =>
            Json.Ok($"\"canGm\":{(LocalPlayer.Rights.CanGm ? "true" : "false")}");

        static string Selected()
        {
            var id = LocalClient.SelectedCreatureId;
            if (id == default(CreatureGuid)) return Json.Err("no creature selected");
            return Creature(id.ToString());
        }

        static string Creature(string idStr)
        {
            if (!CreatureGuid.TryParse(idStr ?? "", out var id)) return Json.Err("bad creature id");
            if (!CreatureManager.TryGetCreatureData(id, out var data)) return Json.Err("creature not on this board");
            var emotes = new System.Text.StringBuilder("[");
            var ids = data.ActiveEmoteIds;
            for (int i = 0; i < ids.Length; i++)
                emotes.Append(i > 0 ? "," : "").Append(Json.Str(ids[i].ToString()));
            emotes.Append(']');
            return Json.Ok(
                $"\"id\":{Json.Str(id.ToString())}," +
                $"\"name\":{Json.Str(CreatureManager.AliasOrAssetName(in data))}," +
                $"\"hp\":{Num(data.Hp.Value)},\"hpMax\":{Num(data.Hp.Max)}," +
                $"\"emotes\":{emotes}");
        }

        static string SetHp(string idStr, string valueStr, string maxStr)
        {
            if (!CreatureGuid.TryParse(idStr ?? "", out var id)) return Json.Err("bad creature id");
            if (!CreatureManager.TryGetCreatureData(id, out var data)) return Json.Err("creature not on this board");
            if (!TryNum(valueStr, out var value)) return Json.Err("value must be a number");
            float max = data.Hp.Max;
            if (!string.IsNullOrEmpty(maxStr) && !TryNum(maxStr, out max)) return Json.Err("max must be a number");

            var before = data.Hp;
            CreatureManager.SetCreatureStatByIndex(id, new CreatureStat(value, max), -1);
            BridgePlugin.Log.LogInfo($"HP {id}: {before.Value}/{before.Max} -> {value}/{max}");
            return Json.Ok($"\"before\":{Num(before.Value)},\"value\":{Num(value)},\"max\":{Num(max)}");
        }

        // Persistent emotes are the closest thing a mini has to a condition marker.
        // Their ids are opaque, so the test reads one off a mini the GM marked by
        // hand (GET /creature) and toggles it here.
        static string SetEmote(string idStr, string emoteStr, string onStr)
        {
            if (!CreatureGuid.TryParse(idStr ?? "", out var id)) return Json.Err("bad creature id");
            if (!NGuid.TryParse(emoteStr ?? "", out var emote)) return Json.Err("bad emote id");
            if (onStr == "0") CreatureManager.RemovePersistentEmote(id, emote);
            else CreatureManager.AddPersistentEmote(id, emote);
            return Json.Ok();
        }

        static bool TryNum(string s, out float v) =>
            float.TryParse(s ?? "", NumberStyles.Float, CultureInfo.InvariantCulture, out v);

        static string Num(float v) => v.ToString("0.###", CultureInfo.InvariantCulture);
    }
}
