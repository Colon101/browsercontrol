import { build } from "esbuild";

await build({
  entryPoints: ["apps/agent/src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "apps/agent/dist/index.js",
  target: "node20",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  external: []
});

