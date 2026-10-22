// Spirekeeper bridge: a small localhost HTTP server inside TaleSpire.
//
// The symbiote panel cannot write to the board. This plugin can, so the panel
// asks it to over http://127.0.0.1:<port>. Requests arrive on a listener
// thread; anything that touches the game is queued and run on Unity's main
// thread, because Unity objects are not thread safe.
//
// Lifetime: the server and its queue are static, and the main-thread pump lives
// on its own hidden, DontDestroyOnLoad GameObject. BepInEx's own manager object
// can be destroyed when the game changes scene; v0.1.0 stopped the server in
// OnDestroy, which is the likely reason it answered "connection refused" after
// logging that it was listening.

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using BepInEx;
using BepInEx.Logging;
using UnityEngine;

namespace Spirekeeper.Bridge
{
    [BepInPlugin(Guid, Name, Version)]
    public sealed class BridgePlugin : BaseUnityPlugin
    {
        public const string Guid = "net.spirekeeper.bridge";
        public const string Name = "Spirekeeper Bridge";
        public const string Version = "0.4.0";
        public const int Port = 47817;

        internal static ManualLogSource Log;
        internal static BepInEx.Configuration.ConfigEntry<bool> AllowWithoutOrigin;

        void Awake()
        {
            Log = Logger;
            AllowWithoutOrigin = Config.Bind("Security", "AllowRequestsWithoutOrigin", false,
                "Accept requests that carry no Origin header, such as curl from Terminal. " +
                "Only for testing: with this on, any program on this computer can drive the bridge.");
            Log.LogInfo($"{Name} {Version} loaded (Unity {Application.unityVersion}, {Application.platform})");
            Pump.Ensure();
            Server.Start();
        }

        void OnDestroy()
        {
            // Deliberately does not stop the server; see the note at the top
            Log.LogWarning("BepInEx manager object destroyed; bridge keeps running");
        }
    }

    // Drains queued work on Unity's main thread
    internal sealed class Pump : MonoBehaviour
    {
        static Pump _instance;
        static readonly Queue<Action> Work = new Queue<Action>();

        public static void Ensure()
        {
            if (_instance != null) return;
            var go = new GameObject("SpirekeeperBridgePump") { hideFlags = HideFlags.HideAndDontSave };
            DontDestroyOnLoad(go);
            _instance = go.AddComponent<Pump>();
            BridgePlugin.Log.LogInfo("Main-thread pump created");
        }

        public static void Enqueue(Action a)
        {
            lock (Work) Work.Enqueue(a);
        }

        void Update()
        {
            while (true)
            {
                Action next;
                lock (Work)
                {
                    if (Work.Count == 0) break;
                    next = Work.Dequeue();
                }
                try { next(); }
                catch (Exception e) { BridgePlugin.Log.LogError(e); }
            }
        }

        void OnDestroy()
        {
            BridgePlugin.Log.LogWarning("Main-thread pump destroyed; game calls will time out");
            _instance = null;
        }
    }

    internal static class Server
    {
        static HttpListener _listener;
        static Thread _thread;

        public static void Start()
        {
            if (_listener != null) return;
            try
            {
                _listener = new HttpListener();
                // Both names, matching how TaleSpire's own symbiote server
                // registers "localhost"; Mono matches prefixes on the Host header
                _listener.Prefixes.Add($"http://127.0.0.1:{BridgePlugin.Port}/");
                _listener.Prefixes.Add($"http://localhost:{BridgePlugin.Port}/");
                _listener.Start();
            }
            catch (Exception e)
            {
                BridgePlugin.Log.LogError($"Could not listen on port {BridgePlugin.Port}: {e}");
                _listener = null;
                return;
            }
            _thread = new Thread(Serve) { IsBackground = true, Name = "spirekeeper-bridge" };
            _thread.Start();
            BridgePlugin.Log.LogInfo($"Listening on http://127.0.0.1:{BridgePlugin.Port}/");
        }

        // Run fn on the main thread and wait for its result, with a timeout
        // so a stuck frame cannot hang the listener forever
        static string OnMainThread(Func<string> fn)
        {
            string result = null;
            Exception error = null;
            var done = new ManualResetEvent(false);
            Pump.Enqueue(() =>
            {
                try { result = fn(); }
                catch (Exception e) { error = e; }
                finally { done.Set(); }
            });
            if (!done.WaitOne(5000)) return Json.Err("timed out waiting for the game thread");
            return error != null ? Json.Err(error.GetType().Name + ": " + error.Message) : result;
        }

        static void Serve()
        {
            BridgePlugin.Log.LogInfo("Accept loop running");
            while (_listener != null && _listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = _listener.GetContext(); }
                catch (Exception e)
                {
                    if (_listener == null || !_listener.IsListening) break;
                    BridgePlugin.Log.LogError($"GetContext failed: {e}");
                    Thread.Sleep(100);
                    continue;
                }
                try { Handle(ctx); }
                catch (Exception e) { BridgePlugin.Log.LogError(e); }
            }
            BridgePlugin.Log.LogWarning("Accept loop ended");
        }

        static void Handle(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            var path = req.Url.AbsolutePath.TrimEnd('/');
            var origin = req.Headers["Origin"];

            // /ping touches nothing in the game, so anyone may ask
            if (path == "/ping")
            {
                if (origin != null) res.AddHeader("Access-Control-Allow-Origin", origin);
                Send(res, 200, Json.Ok($"\"version\":\"{BridgePlugin.Version}\",\"unity\":\"{Application.unityVersion}\""));
                return;
            }

            // Everything else must come from a TaleSpire symbiote panel. Browsers
            // always send Origin on a cross-origin fetch and a web page cannot
            // forge it, so a site open in Chrome can't drive the bridge. A
            // request with no Origin (curl, a native app) is refused unless the
            // config allows it for testing.
            if (!Allowed(origin, out var why))
            {
                BridgePlugin.Log.LogWarning($"Refused {req.HttpMethod} {req.Url.PathAndQuery} from {origin ?? "no origin"}: {why}");
                Send(res, 403, Json.Err(why));
                return;
            }
            if (origin != null)
            {
                res.AddHeader("Access-Control-Allow-Origin", origin);
                res.AddHeader("Vary", "Origin");
                res.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                res.AddHeader("Access-Control-Allow-Headers", "Content-Type");
                res.AddHeader("Access-Control-Allow-Private-Network", "true");
            }
            if (req.HttpMethod == "OPTIONS") { Send(res, 204, ""); return; }

            string body = "";
            if (req.HasEntityBody)
                using (var r = new StreamReader(req.InputStream, Encoding.UTF8)) body = r.ReadToEnd();

            BridgePlugin.Log.LogInfo($"{req.HttpMethod} {req.Url.PathAndQuery}");
            var reply = Routes.Dispatch(req.HttpMethod, path, req.QueryString, body, OnMainThread, out var status);
            Send(res, status, reply);
        }

        static string _symbioteOrigin;

        static bool Allowed(string origin, out string why)
        {
            why = null;
            if (origin == null)
            {
                if (BridgePlugin.AllowWithoutOrigin.Value) return true;
                why = "requests without an Origin are refused (see AllowRequestsWithoutOrigin)";
                return false;
            }
            var expected = SymbioteOrigin();
            if (expected == null) { why = "TaleSpire's symbiote server isn't running yet"; return false; }
            if (string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase)) return true;
            why = "origin is not TaleSpire's symbiote server";
            return false;
        }

        // TaleSpire serves every symbiote panel from its own HttpListener on
        // http://localhost:<random port>/symbiotes/. The port changes each
        // launch, so read it from WebViewEnvironment once it exists.
        //
        // TaleSpire switches that environment's GameObject inactive, and
        // FindObjectOfType skips inactive objects (0.3.0 found nothing and
        // refused every panel). FindObjectsOfTypeAll includes them, and also
        // prefab assets, whose prefix is never set, so take the first that has one.
        static string SymbioteOrigin()
        {
            if (_symbioteOrigin != null) return _symbioteOrigin;
            var found = OnMainThread(() =>
            {
                var field = typeof(Symbiotes.WebView.WebViewEnvironment).GetField("_localSymbioteAddressPrefix",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
                if (field == null) return "!no _localSymbioteAddressPrefix field; TaleSpire changed";
                var all = Resources.FindObjectsOfTypeAll<Symbiotes.WebView.WebViewEnvironment>();
                foreach (var env in all)
                {
                    var prefix = field.GetValue(env) as string;
                    if (string.IsNullOrEmpty(prefix)) continue;
                    var uri = new Uri(prefix);
                    return $"{uri.Scheme}://{uri.Authority}";
                }
                return $"!{all.Length} WebViewEnvironment object(s), none with a server address yet";
            });
            if (found != null && found.StartsWith("!"))
            {
                BridgePlugin.Log.LogWarning("Symbiote origin not found: " + found.Substring(1));
                return null;
            }
            if (found != null && !found.StartsWith("{"))
            {
                _symbioteOrigin = found;
                BridgePlugin.Log.LogInfo($"Accepting requests from {found}");
            }
            return _symbioteOrigin;
        }

        static void Send(HttpListenerResponse res, int status, string json)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            res.StatusCode = status;
            res.ContentType = "application/json";
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
            res.OutputStream.Close();
        }
    }

    // Tiny JSON helpers; Unity's Mono profile has no built-in JSON writer
    internal static class Json
    {
        public static string Ok(string fields = "") =>
            "{\"ok\":true" + (fields.Length > 0 ? "," + fields : "") + "}";

        public static string Err(string message) =>
            "{\"ok\":false,\"error\":" + Str(message) + "}";

        public static string Str(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }
    }
}
