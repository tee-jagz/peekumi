#!/usr/bin/env node
import http from "node:http";
import { gzip } from "node:zlib";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryClient } from "./repository-client.mjs";
import { promisify } from "node:util";
const compress = promisify(gzip);

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const assets = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/canvas.js": ["canvas.js", "text/javascript"],
  "/model.js": ["model.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const equal = (a, b) =>
  typeof a === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createServer(
  repo,
  { token, base = "HEAD~1", head = "HEAD", secureCookie = false } = {},
) {
  if (!token) throw new Error("An access token is required");
  const sessions = new Map();
  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const sendBody = async (code, type, value) => {
      let body = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const acceptsGzip = (request.headers["accept-encoding"] || "")
        .split(",")
        .some((entry) => {
          const [encoding, ...parameters] = entry
            .trim()
            .toLowerCase()
            .split(";");
          const quality = parameters
            .map((p) => p.trim())
            .find((p) => p.startsWith("q="));
          return (
            encoding === "gzip" && (!quality || Number(quality.slice(2)) > 0)
          );
        });
      response.setHeader("Vary", "Accept-Encoding");
      if (body.length >= 1024 && acceptsGzip) {
        body = await compress(body);
        response.setHeader("Content-Encoding", "gzip");
      }
      response.writeHead(code, {
        "Content-Type": type,
        "Content-Length": body.length,
      });
      response.end(body);
    };
    const send = (code, value) =>
      sendBody(code, "application/json", JSON.stringify(value));
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        await sendBody(200, type, await readFile(path.join(publicDir, file)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/session") {
        if (
          request.headers.origin &&
          new URL(request.headers.origin).host !== request.headers.host
        )
          return await send(403, { error: "Origin rejected" });
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 2048)
            return await send(413, { error: "Request too large" });
        }
        const provided = JSON.parse(body).token;
        if (!equal(provided, token))
          return await send(401, { error: "Access token not recognised" });
        for (const [key, expires] of sessions)
          if (expires < Date.now()) sessions.delete(key);
        const session = randomBytes(32).toString("hex");
        sessions.set(session, Date.now() + 7 * 86400000);
        response.setHeader(
          "Set-Cookie",
          `strata_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie ? "; Secure" : ""}`,
        );
        return await send(200, { ok: true });
      }
      const session = request.headers.cookie
        ?.split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("strata_session="))
        ?.slice(15);
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      if (!(sessions.get(session) > Date.now()) && !equal(bearer, token))
        return await send(401, {
          error: "Connect with the access link printed by Strata",
        });
      if (request.method !== "GET")
        return await send(405, { error: "Read-only API" });
      if (url.pathname === "/api/repo") {
        const metadata = await repo.metadata();
        let initialBase;
        try {
          initialBase = await repo.resolve(base);
        } catch {
          initialBase = metadata.commits.at(-1).sha;
        }
        return await send(200, {
          ...metadata,
          initialBase,
          initialHead: await repo.resolve(head),
        });
      }
      const baseRef = url.searchParams.get("base") || base,
        headRef = url.searchParams.get("head") || head;
      if (url.pathname === "/api/compare")
        return await send(
          200,
          await repo.compare(baseRef, headRef, {
            view:
              url.searchParams.get("view") === "overview" ? "overview" : "full",
          }),
        );
      if (url.pathname === "/api/source")
        return await send(
          200,
          await repo.source(baseRef, headRef, url.searchParams.get("path")),
        );
      return await send(404, { error: "Not found" });
    } catch (error) {
      send(400, { error: error.message });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) {
    console.log(
      "Usage: npm start -- /path/to/repo [--host 127.0.0.1] [--port 4317] [--base HEAD~1] [--head HEAD] [--secure-cookie]\nSTRATA_PYTHON selects the Python interpreter. Access is token protected. Bind a private interface for phone access.",
    );
    return;
  }
  const directory = args.shift();
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (key === "--secure-cookie") options.secureCookie = true;
    else if (
      ["--host", "--port", "--base", "--head"].includes(key) &&
      args.length
    )
      options[key.slice(2)] = args.shift();
    else throw new Error(`Unknown or missing argument: ${key}`);
  }
  const repo = new RepositoryClient(directory, {
    cacheDirectory: path.join(process.cwd(), ".strata", "index"),
  });
  try {
    await repo.resolve("HEAD");
  } catch (error) {
    await repo.close();
    throw error;
  }
  const state = path.join(process.cwd(), ".strata");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(state, "access-token");
  let token;
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    token = randomBytes(32).toString("hex");
    await writeFile(tokenFile, token, { mode: 0o600 });
  }
  const host = options.host || "127.0.0.1",
    port = Number(options.port || 4317);
  const server = createServer(repo, { ...options, token });
  server.on("close", () => repo.close());
  server.on("error", (error) => {
    repo.close();
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(
      `Repo Strata · ${repo.directory}\nOpen: http://${host.includes(":") ? `[${host}]` : host}:${port}/#token=${token}\nRead-only Git inspection. Ctrl+C to stop.`,
    );
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
