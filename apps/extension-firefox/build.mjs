import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync, strToU8 } from "fflate";
const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const buildDir = join(root, "build");

await rm(dist, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(buildDir, { recursive: true });

await build({
  entryPoints: {
    background: join(root, "src/background-entry.ts"),
    content: join(root, "src/content-entry.ts")
  },
  bundle: true,
  outdir: dist,
  entryNames: "[name]",
  platform: "browser",
  format: "iife",
  target: ["firefox128"],
  sourcemap: true,
  tsconfig: join(root, "..", "..", "tsconfig.json")
});

for (const file of [
  "manifest.json",
  "assets/overlay.css",
  "assets/icon-48.png",
  "assets/icon-96.png",
  "assets/icon-128.png",
  "assets/robot.svg",
  "assets/robot-toolbar-light.svg",
  "assets/robot-toolbar-dark.svg"
]) {
  await cp(join(root, file), join(dist, file.split("/").at(-1)));
}

const zipPath = join(buildDir, "browsercontrol-firefox.zip");
const zipEntries = {};
for (const file of [
  "background.js",
  "background.js.map",
  "content.js",
  "content.js.map",
  "manifest.json",
  "overlay.css",
  "icon-48.png",
  "icon-96.png",
  "icon-128.png",
  "robot.svg",
  "robot-toolbar-light.svg",
  "robot-toolbar-dark.svg"
]) {
  const buffer = await readFile(join(dist, file));
  zipEntries[file] = file.endsWith(".json") || file.endsWith(".css") || file.endsWith(".svg") || file.endsWith(".js") || file.endsWith(".map")
    ? strToU8(buffer.toString("utf8"))
    : new Uint8Array(buffer);
}
await writeFile(zipPath, zipSync(zipEntries, { level: 9 }));
