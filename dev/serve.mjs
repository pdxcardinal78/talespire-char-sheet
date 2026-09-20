#!/usr/bin/env node
/**
 * Serve the Symbiote for development in a normal browser.
 *
 * `python3 -m http.server` works, but it sends caching headers a browser takes
 * seriously — which means editing a file and reloading can quietly run the old
 * one. That failure is invisible and expensive: the panel boots against a stale
 * script and throws somewhere unrelated. So this sends `no-store` on everything.
 *
 *   node dev/serve.mjs                                    # http://localhost:8777/sheet.html
 *   node dev/serve.mjs --port 9000
 *   node dev/serve.mjs --open                             # and launch a browser at it
 *   node dev/serve.mjs --root spirekeeper_v2/symbiote --port 8778
 *
 * Two builds can be served at once on different ports, which is the point of
 * --root: compare v1 and v2 side by side without reinstalling either.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(REPO, args.includes("--root") ? args[args.indexOf("--root") + 1] : "symbiote");
const port = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 8777);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const wanted = url.pathname === "/" ? "/sheet.html" : url.pathname;

  // Keep the served tree inside the chosen root, whatever the request says.
  const path = join(ROOT, normalize(wanted).replace(/^(\.\.[/\\])+/, ""));
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end("Outside the Symbiote directory.");
    return;
  }

  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(path)] || "application/octet-stream",
      // The whole point: never let the browser reuse a file you just edited.
      "Cache-Control": "no-store, must-revalidate",
      Pragma: "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(`Not found: ${wanted}`);
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Try: node dev/serve.mjs --port ${port + 1}`);
    process.exit(1);
  }
  throw e;
});

const url = `http://localhost:${port}/sheet.html`;

server.listen(port, () => {
  const G = "\x1b[32m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";
  console.log(`${G}Spirekeeper dev server${X}  ${B}${url}${X}`);
  console.log(`${D}  serving ${ROOT}${X}`);
  console.log(`${D}  no-store, so a reload always gets the file you just saved${X}`);
  console.log(`${D}  the TS API is stubbed: dice resolve ~400ms after staging, and you are a GM${X}`);
  console.log(`${D}  ctrl-c to stop${X}`);
  if (args.includes("--open")) spawn("open", [url], { stdio: "ignore", detached: true }).unref();
});
