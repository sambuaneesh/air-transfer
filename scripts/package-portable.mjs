import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const outputRoot = path.resolve(projectRoot, "portable", "air-t2-portable");
const webDist = path.resolve(projectRoot, "apps", "web", "dist");
const portableWebRoot = path.resolve(outputRoot, "web");
const serverSource = path.resolve(projectRoot, "scripts", "serve-portable.mjs");

const readme = `Air T2 portable runtime

This bundle does not require npm install.

Requirements
- Node.js must already be installed on the target laptop.
- Open the app through the included local server so camera access works.

How to run
1. Open a terminal in this folder.
2. Run:
   node server.mjs
3. Open:
   http://127.0.0.1:4173

Optional
- Use a different port:
   set PORT=8080 && node server.mjs   (Windows cmd)
   PORT=8080 node server.mjs          (macOS/Linux)

Notes
- This is a prebuilt runtime bundle. You do not need node_modules here.
- If you want to modify source code on another laptop, copy the full project including node_modules only when both laptops use the same OS and CPU architecture.
`;

const startSh = `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
node server.mjs
`;

const startBat = `@echo off
cd /d %~dp0
node server.mjs
`;

async function main() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(webDist, portableWebRoot, { recursive: true });
  await cp(serverSource, path.resolve(outputRoot, "server.mjs"));
  await writeFile(path.resolve(outputRoot, "README.txt"), readme, "utf8");
  await writeFile(path.resolve(outputRoot, "start.sh"), startSh, { encoding: "utf8", mode: 0o755 });
  await writeFile(path.resolve(outputRoot, "start.bat"), startBat, "utf8");

  console.log(`Portable bundle created at ${outputRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
