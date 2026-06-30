import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundledWebRoot = path.resolve(__dirname, "web");
const repoWebRoot = path.resolve(__dirname, "../apps/web/dist");
const rootDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : existsSync(bundledWebRoot)
    ? bundledWebRoot
    : repoWebRoot;
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const host = process.env.HOST ?? "127.0.0.1";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"]
]);

function sendNotFound(response) {
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function sendError(response, error) {
  response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(`Server error: ${error instanceof Error ? error.message : "unknown error"}`);
}

async function resolvePath(urlPath) {
  const safePath = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const requested = safePath === "" ? "index.html" : safePath;
  const fullPath = path.resolve(rootDir, requested);

  if (!fullPath.startsWith(rootDir)) {
    return null;
  }

  if (!existsSync(fullPath)) {
    return path.resolve(rootDir, "index.html");
  }

  const stats = await stat(fullPath);
  if (stats.isDirectory()) {
    return path.resolve(fullPath, "index.html");
  }

  return fullPath;
}

const server = http.createServer(async (request, response) => {
  try {
    const resolvedPath = await resolvePath(request.url ?? "/");
    if (!resolvedPath || !existsSync(resolvedPath)) {
      sendNotFound(response);
      return;
    }

    const extension = path.extname(resolvedPath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes.get(extension) ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    createReadStream(resolvedPath).pipe(response);
  } catch (error) {
    sendError(response, error);
  }
});

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const network of Object.values(interfaces)) {
    for (const details of network ?? []) {
      if (details.family === "IPv4" && !details.internal) {
        addresses.push(details.address);
      }
    }
  }

  return addresses;
}

server.listen(port, host, () => {
  console.log(`Air T2 portable server running at http://${host}:${port}`);
  if (host === "0.0.0.0") {
    for (const address of getLanAddresses()) {
      console.log(`LAN: http://${address}:${port}`);
    }
  }
  console.log(`Serving: ${rootDir}`);
});
