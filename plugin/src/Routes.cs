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
        // Reads are GET. Writes must be POST, which a browser won't send
        // cross-origin without a CORS preflight, and only a GM may make them:
        // TaleSpire applies these ops on every client without checking rights,
        // so this is the only place that check can happen.
        public static string Dispatch(string method, string path, NameValueCollection q, string body,
            Func<Func<string>, string> onMain, out int status)
        {
            status = 200;
            bool isWrite = path == "/hp" || path == "/stat" || path == "/emote" || path == "/zone" || path == "/zone-remove";
            switch (path)
            {
                case "/whoami": case "/selected": case "/creature": case "/statuses": case "/creatures":
                case "/hp": case "/stat": case "/emote": case "/zone": case "/zone-remove":
                    break;
                default:
                    status = 404;
                    return Json.Err("no such route");
            }
            if (isWrite && method != "POST")
            {
                status = 405;
                return Json.Err(path + " must be POST");
            }
            if (!isWrite && method != "GET")
            {
                status = 405;
                return Json.Err(path + " must be GET");
            }

            int code = 200;
            var reply = onMain(() =>
            {
                if (isWrite && !LocalPlayer.Rights.CanGm)
                {
                    code = 403;
                    return Json.Err("only a GM can change the board");
                }
                switch (path)
                {
                    case "/whoami": return WhoAmI();
                    case "/selected": return Selected();
                    case "/creature": return Creature(q["id"]);
                    case "/statuses": return StatusCatalog();
                    case "/creatures": return AllCreatures();
                    case "/hp": return SetHp(q["id"], q["value"], q["max"]);
                    case "/stat": return SetStat(q["id"], q["index"], q["value"], q["max"]);
                    case "/zone": return KeepZone(q["ruler"], q["name"], q["tint"]);
                    case "/zone-remove": return RemoveZone(q["id"]);
                    default: return SetEmote(q["id"], q["emote"], q["on"]);
                }
            });
            status = code;
            return reply;
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

        // Every mini on the board with what a spell zone needs: position (world
        // units, one tile each), size (the active morph's scale) and whether it's
        // hidden. The symbiote API has no "all minis" call, and CreatureManager
        // keeps the list in a private static, hence the reflection.
        static string AllCreatures()
        {
            var field = typeof(CreatureManager).GetField("_creaturesData",
                System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
            var list = field?.GetValue(null);
            var getBuffer = list?.GetType().GetMethod("GetBufferUnsafe");
            if (getBuffer == null) return Json.Err("TaleSpire's creature list changed; plugin needs updating");
            var args = new object[] { 0 };
            var buffer = (CreatureDataV4[])getBuffer.Invoke(list, args);
            int count = (int)args[0];

            var sb = new System.Text.StringBuilder("[");
            for (int i = 0; i < count; i++)
            {
                var d = buffer[i];
                if (i > 0) sb.Append(',');
                float scale = 1f;
                try { scale = d.PackedScales[d.ActiveMorphIndex]; } catch { }
                sb.Append("{\"id\":").Append(Json.Str(d.CreatureId.ToString()))
                  .Append(",\"name\":").Append(Json.Str(CreatureManager.AliasOrAssetName(in d)))
                  .Append(",\"x\":").Append(Num(d.Position.x))
                  .Append(",\"y\":").Append(Num(d.Position.y))
                  .Append(",\"z\":").Append(Num(d.Position.z))
                  .Append(",\"scale\":").Append(Num(scale > 0 ? scale : 1f))
                  .Append(",\"hidden\":").Append(d.ExplicitlyHidden ? "true" : "false")
                  .Append('}');
            }
            sb.Append(']');
            return Json.Ok("\"creatures\":" + sb);
        }

        // TaleSpire's statuses: the persistent emotes in its emote catalog, with
        // the names shown in the radial menu. Their ids come from the game's own
        // content, so they're the same ids minis report, in every campaign.
        static string StatusCatalog()
        {
            var collection = EmoteManager.GetCollection();
            if (collection == null) return Json.Err("emote catalog not loaded yet");
            var sb = new System.Text.StringBuilder("[");
            bool first = true;
            foreach (var item in collection.Emotes)
            {
                var e = item?.Emote;
                if (e == null || !e.IsPersistant) continue;
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"id\":").Append(Json.Str(e.ActionTimelineId.ToString()))
                  .Append(",\"name\":").Append(Json.Str(string.IsNullOrEmpty(e.DisplayName) ? e.name : e.DisplayName))
                  .Append(",\"icon\":").Append(Json.Str(e.IconName))
                  .Append('}');
            }
            sb.Append(']');
            return Json.Ok("\"statuses\":" + sb);
        }

        // Turn a placed ruler into one of TaleSpire's own area markers, which stay
        // on the board for everyone. This is the same call TaleSpire's ruler menu
        // makes, so the shape and handles are exactly what the ruler showed.
        // Rulers are shared across clients, so a GM can keep a player's ruler.
        static string KeepZone(string rulerStr, string name, string tintStr)
        {
            if (!RulerId.TryParse(rulerStr ?? "", out var rulerId)) return Json.Err("bad ruler id");
            // RulerManager is internal to TaleSpire, so reach TryGetRuler by reflection
            var mgr = typeof(Ruler).Assembly.GetType("RulerManager");
            var tryGet = mgr?.GetMethod("TryGetRuler",
                System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
            if (tryGet == null) return Json.Err("TaleSpire's ruler lookup changed; plugin needs updating");
            var args = new object[] { rulerId, null };
            var found = (bool)tryGet.Invoke(null, args);
            var ruler = args[1] as Ruler;
            if (!found || ruler == null) return Json.Err("ruler not found; it may have been put away");
            if (!AoeGuid.TryGenerateNew(out var aoeId)) return Json.Err("could not make a zone id");
            ushort tint = 0;
            if (!string.IsNullOrEmpty(tintStr)) ushort.TryParse(tintStr, out tint);
            AoeManager.AddAoe(ruler, string.IsNullOrEmpty(name) ? null : name, new AoeTintIndex(tint), aoeId);
            BridgePlugin.Log.LogInfo($"Zone {aoeId.Value} '{name}' from ruler {rulerId}");
            return Json.Ok($"\"id\":{Json.Str(aoeId.Value.ToString())}");
        }

        static string RemoveZone(string idStr)
        {
            if (!NGuid.TryParse(idStr ?? "", out var guid)) return Json.Err("bad zone id");
            AoeManager.RemoveAoe(new AoeGuid(guid));
            return Json.Ok();
        }

        // One of the campaign's eight named stats, by index 0 to 7. Spirekeeper
        // finds the slot by name (for example a "Temp HP" stat) and never renames
        // stats itself, so the index always comes from the panel.
        static string SetStat(string idStr, string indexStr, string valueStr, string maxStr)
        {
            if (!CreatureGuid.TryParse(idStr ?? "", out var id)) return Json.Err("bad creature id");
            if (!int.TryParse(indexStr ?? "", out var index) || index < 0 || index > 7)
                return Json.Err("index must be 0 to 7");
            if (!CreatureManager.TryGetCreatureData(id, out var data)) return Json.Err("creature not on this board");
            if (!TryNum(valueStr, out var value)) return Json.Err("value must be a number");
            var current = data.StatByIndex(index);
            float max = current.Max;
            if (!string.IsNullOrEmpty(maxStr) && !TryNum(maxStr, out max)) return Json.Err("max must be a number");

            CreatureManager.SetCreatureStatByIndex(id, new CreatureStat(value, max), index);
            BridgePlugin.Log.LogInfo($"Stat {index} {id}: {current.Value}/{current.Max} -> {value}/{max}");
            return Json.Ok($"\"before\":{Num(current.Value)},\"value\":{Num(value)},\"max\":{Num(max)}");
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
