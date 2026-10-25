// Fetch a character from D&D Beyond's character service.
//
// The symbiote panel can't: D&D Beyond sends no CORS headers, so a web page
// from another origin can't read the reply. The plugin isn't a web page. It
// fetches the same URL a browser would open and hands the JSON back.
//
// Only public characters: no D&D Beyond login is stored or sent. The id must be
// all digits and the host is fixed, so this can't be pointed anywhere else.
//
// UnityWebRequest uses the platform's own TLS, which is the dependable route
// inside the game. It has to be created and read on the main thread, so the
// listener thread starts it there and then checks back every 100 ms.

using System;
using System.Threading;
using UnityEngine.Networking;

namespace Spirekeeper.Bridge
{
    internal static class DdbFetch
    {
        const string Base = "https://character-service.dndbeyond.com/character/v5/character/";
        const int TimeoutSeconds = 20;

        public static string Character(string id, Func<Func<string>, string> onMain, out int status)
        {
            status = 200;
            if (string.IsNullOrEmpty(id) || id.Length > 12)
            {
                status = 400;
                return Json.Err("bad character id");
            }
            foreach (var c in id)
            {
                if (c < '0' || c > '9')
                {
                    status = 400;
                    return Json.Err("bad character id");
                }
            }

            UnityWebRequest req = null;
            var started = onMain(() =>
            {
                req = UnityWebRequest.Get(Base + id);
                req.timeout = TimeoutSeconds;
                req.SetRequestHeader("Accept", "application/json");
                req.SendWebRequest();
                return null;
            });
            if (req == null)
            {
                status = 502;
                return started ?? Json.Err("could not start the request");
            }

            var deadline = DateTime.UtcNow.AddSeconds(TimeoutSeconds + 5);
            int code = 200;
            while (DateTime.UtcNow < deadline)
            {
                Thread.Sleep(100);
                var reply = onMain(() =>
                {
                    if (!req.isDone) return null;
                    try
                    {
                        long http = req.responseCode;
                        string text = req.downloadHandler?.text;
                        if (http == 0 || (text == null && !string.IsNullOrEmpty(req.error)))
                        {
                            code = 502;
                            return Json.Err("couldn't reach D&D Beyond: " + (req.error ?? "no reply"));
                        }
                        var t = (text ?? "").Trim();
                        bool isJson = t.Length >= 2 && t[0] == '{' && t[t.Length - 1] == '}';
                        // A private or missing character comes back as an error
                        // status, sometimes without JSON: pass the status on
                        if (!isJson && http >= 400)
                            return Json.Ok($"\"status\":{http},\"character\":null");
                        if (!isJson)
                        {
                            code = 502;
                            return Json.Err($"D&D Beyond answered {http} without character data");
                        }
                        // The reply is passed through as-is; the panel reads
                        // success/message itself (a private character says so there)
                        return Json.Ok($"\"status\":{http},\"character\":{t}");
                    }
                    finally
                    {
                        req.Dispose();
                    }
                });
                if (reply != null)
                {
                    status = code;
                    BridgePlugin.Log.LogInfo($"D&D Beyond character {id}: {code}, {reply.Length} bytes");
                    return reply;
                }
            }
            onMain(() => { req.Abort(); req.Dispose(); return ""; });
            status = 504;
            return Json.Err("D&D Beyond took too long to answer");
        }
    }
}
