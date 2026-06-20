#!/usr/bin/env node
// demo-server.mjs — static `web/` + thin proxy to storefront + log tail.
// Pure Node (no deps). Run via `node scripts/demo-server.mjs`.
//
// Env:
//   DEMO_PORT         (default 5500)         port this server listens on
//   STOREFRONT_URL    (default http://127.0.0.1:3000)
//   ENGINE_URL        (default http://127.0.0.1:8000)
//   SUPPLIER_URL      (default http://127.0.0.1:4000)
//   LOG_DIR           (default ./logs)       directory tailed by /api/logs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "web");

const PORT = Number(process.env.DEMO_PORT ?? 5500);
const STOREFRONT = process.env.STOREFRONT_URL ?? "http://127.0.0.1:3000";
const ENGINE = process.env.ENGINE_URL ?? "http://127.0.0.1:8000";
const SUPPLIER = process.env.SUPPLIER_URL ?? "http://127.0.0.1:4000";
const LOG_DIR = process.env.LOG_DIR ?? path.join(ROOT, "logs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "access-control-allow-origin": "*", ...headers });
  res.end(body);
}

async function proxy(req, res, target) {
  const url = new URL(target);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: body.length ? body : undefined,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    send(res, upstream.status, buf, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: "upstream unreachable", target, detail: String(err) }), {
      "content-type": "application/json",
    });
  }
}

function tailFile(filePath, lines = 200) {
  try {
    const data = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    return data.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function listLogs() {
  try {
    return fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".log")).sort();
  } catch {
    return [];
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/demo.html" : pathname;
  const filePath = path.join(WEB, rel);
  if (!filePath.startsWith(WEB)) return send(res, 403, "forbidden");
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "not found");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "access-control-allow-origin": "*",
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    return send(res, 204, "", {
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
  }

  // /api/config — what the page needs to know
  if (u.pathname === "/api/config") {
    return send(
      res,
      200,
      JSON.stringify({ storefront: STOREFRONT, engine: ENGINE, supplier: SUPPLIER }),
      { "content-type": "application/json" },
    );
  }

  // /api/logs?file=storefront.log&lines=200 — tail a file under LOG_DIR
  if (u.pathname === "/api/logs") {
    if (u.searchParams.get("list") !== null) {
      return send(res, 200, JSON.stringify({ files: listLogs(), dir: LOG_DIR }), {
        "content-type": "application/json",
      });
    }
    const file = u.searchParams.get("file") ?? "";
    if (!file || file.includes("/") || file.includes("..")) {
      return send(res, 400, JSON.stringify({ error: "bad file" }), {
        "content-type": "application/json",
      });
    }
    const lines = Number(u.searchParams.get("lines") ?? 200);
    return send(res, 200, tailFile(path.join(LOG_DIR, file), lines), {
      "content-type": "text/plain; charset=utf-8",
    });
  }

  // /api/storefront/* → STOREFRONT/*
  if (u.pathname.startsWith("/api/storefront")) {
    const rest = u.pathname.replace(/^\/api\/storefront/, "") + u.search;
    return proxy(req, res, STOREFRONT + (rest || "/"));
  }
  if (u.pathname.startsWith("/api/engine")) {
    const rest = u.pathname.replace(/^\/api\/engine/, "") + u.search;
    return proxy(req, res, ENGINE + (rest || "/"));
  }
  if (u.pathname.startsWith("/api/supplier")) {
    const rest = u.pathname.replace(/^\/api\/supplier/, "") + u.search;
    return proxy(req, res, SUPPLIER + (rest || "/"));
  }

  return serveStatic(req, res, u.pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[demo-server] http://127.0.0.1:${PORT}`);
  console.log(`[demo-server]   storefront → ${STOREFRONT}`);
  console.log(`[demo-server]   engine     → ${ENGINE}`);
  console.log(`[demo-server]   supplier   → ${SUPPLIER}`);
  console.log(`[demo-server]   logs dir   = ${LOG_DIR}`);
});
