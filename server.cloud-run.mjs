// Cloud Run entry point — the equivalent of api/server.js, but for a plain
// container instead of a Vercel serverless function.
//
// Vercel's platform does two things this app relies on that a bare container
// doesn't get for free:
//   1. Serves dist/client/* as static files directly (outputDirectory in
//      vercel.json), before falling through to the rewrite -> api/server.
//   2. Wraps api/server.js's handler in its own HTTP listener.
// This file does both explicitly: serve a static file if the request path
// resolves to one under dist/client, otherwise hand off to the same
// dist/server/server.js fetch handler api/server.js already uses.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import server from "./dist/server/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, "dist", "client");
const PORT = Number(process.env.PORT) || 8080;

const MIME_BY_EXT = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Serves `req.url` from dist/client if a matching file exists there.
 *  Returns true if it handled the request, false if the caller should fall
 *  through to the SSR handler instead. */
async function tryServeStatic(req, res) {
  const urlPath = req.url.split("?")[0];
  if (urlPath.includes("..")) return false; // no path traversal
  const filePath = path.join(CLIENT_DIR, decodeURIComponent(urlPath));
  if (!filePath.startsWith(CLIENT_DIR)) return false;

  let st;
  try {
    st = await stat(filePath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("content-type", MIME_BY_EXT[ext] ?? "application/octet-stream");
  // Vite fingerprints filenames under /assets/, so those are safe to cache
  // hard; everything else (e.g. favicon at the client root) is not.
  res.setHeader(
    "cache-control",
    urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  );
  res.statusCode = 200;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
  return true;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (await tryServeStatic(req, res)) return;

    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
    const url = `${proto}://${host}${req.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else if (value !== undefined) headers.set(key, String(value));
    }

    let body;
    if (req.method && req.method !== "GET" && req.method !== "HEAD") {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    }

    const request = new Request(url, { method: req.method, headers, body, duplex: "half" });
    const response = await server.fetch(request, process.env, {});

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (err) {
    console.error("[server.cloud-run] handler crashed:", err);
    // Headers may already be flushed once the first res.write() lands, so a
    // failure mid-stream (client disconnect) would throw ERR_HTTP_HEADERS_SENT
    // *inside* this catch — an unhandled rejection that hangs the socket.
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`Internal Server Error: ${err?.message ?? String(err)}`);
    } else {
      res.end();
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`[server.cloud-run] listening on :${PORT}`);
});
