/**
 * A static file server for the three clients, and nothing else.
 *
 * This is **not** the Quorum server. It exists so the clients can be opened
 * and driven against the in-page mock while the real server is being built,
 * and it maps the same four routes the real one will, so the absolute asset
 * paths in the HTML resolve identically:
 *
 *   /            → participant
 *   /j/:code     → participant, code prefilled
 *   /host        → host console
 *   /screen      → big screen
 *   /client/*    → dist/client/*
 *   /arcade/*, /engine/*, /protocol.js → dist/* (the rest of the graph)
 *
 *   app$ npm run client:dev
 *   open 'http://localhost:4173/?mock=1'
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "dist", "client");
/** The whole emitted tree: client files import siblings of `dist/client`. */
const dist = resolve(here, "..", "dist");
const port = Number(process.env["PORT"] ?? 4173);

if (!existsSync(root)) {
  console.error(`No build at ${root}. Run: npm run build:client`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function pageFor(pathname) {
  if (pathname === "/" || /^\/j\/[^/]*\/?$/.test(pathname)) {
    return join(root, "participant", "index.html");
  }
  if (pathname === "/host" || pathname === "/host/") {
    return join(root, "host", "index.html");
  }
  if (pathname === "/screen" || pathname === "/screen/") {
    return join(root, "screen", "index.html");
  }
  // Any emitted module by its own path, not just `/client/*`. A client file
  // importing something outside `src/client/` — the arcade content, an engine
  // helper, `protocol.ts` — is emitted beside `dist/client`, so the browser
  // asks for `/arcade/…` or `/engine/…`. Serving only `/client/*` 404'd those,
  // the module graph failed, and every surface rendered blank with nothing in
  // the server log to show for it. Mirrors the production route in
  // `server/main.ts`.
  if (/\.(js|css|map|svg|png|woff2|ico)$/.test(pathname)) {
    const rel = normalize(pathname.slice(1));
    if (rel.startsWith("..")) return null;
    return join(dist, rel);
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const file = pageFor(url.pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`clients on http://localhost:${port}`);
  console.log(`  participant  http://localhost:${port}/?mock=1`);
  console.log(`  via a link   http://localhost:${port}/j/RAFT?mock=1`);
  console.log(`  host         http://localhost:${port}/host?mock=manual#mock-token`);
  console.log(`  big screen   http://localhost:${port}/screen?mock=1#mock-token`);
});
