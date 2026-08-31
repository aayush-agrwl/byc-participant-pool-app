// Local stand-in for Vercel: serves public/ and routes /api to the function.
// Vercel itself does this in production; nothing here ships.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "./_env.mjs";

const root   = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const port   = Number(process.env.PORT || 3400);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const { default: handler } = await import("../api/index.js");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname.startsWith("/api/")) {
    try {
      await handler(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unhandled error in the API." }));
      }
    }
    return;
  }

  // cleanUrls: /admin serves admin.html, as it does on Vercel.
  let path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  if (path === "/") path = "/index.html";
  let file = join(publicDir, path);
  if (!extname(file)) {
    try {
      await stat(`${file}.html`);
      file = `${file}.html`;
    } catch { /* fall through to the 404 below */ }
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(port, () => console.log(`Local server on http://localhost:${port}`));
