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
        public const string Version = "0.1.2";
        public const int Port = 47817;

        internal static ManualLogSource Log;

        void Awake()
        {
            Log = Logger;
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

            // The symbiote panel is a web page on another origin, so it needs CORS.
            // Chromium's private network access rules also want the last header
            // before a page may call localhost.
            res.AddHeader("Access-Control-Allow-Origin", "*");
            res.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.AddHeader("Access-Control-Allow-Headers", "Content-Type");
            res.AddHeader("Access-Control-Allow-Private-Network", "true");

            if (req.HttpMethod == "OPTIONS") { Send(res, 204, ""); return; }

            string body = "";
            if (req.HasEntityBody)
                using (var r = new StreamReader(req.InputStream, Encoding.UTF8)) body = r.ReadToEnd();

            var path = req.Url.AbsolutePath.TrimEnd('/');
            BridgePlugin.Log.LogInfo($"{req.HttpMethod} {req.Url.PathAndQuery}");

            string reply;
            switch (path)
            {
                case "/ping":
                    reply = Json.Ok($"\"version\":\"{BridgePlugin.Version}\",\"unity\":\"{Application.unityVersion}\"");
                    break;
                default:
                    reply = Routes.Dispatch(path, req.QueryString, body, OnMainThread);
                    break;
            }
            Send(res, reply == null ? 404 : 200, reply ?? Json.Err("no such route"));
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
