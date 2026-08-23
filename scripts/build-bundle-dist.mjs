import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "packages/bundle/package.json"), "utf8"));

await build({
  entryPoints: [join(root, "packages/bundle/src/index.ts")],
  outfile: join(root, "packages/bundle/dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@deepseek-ai/cordis"],
  sourcemap: true,
});

const publishable = {
  ...pkg,
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
    "./package.json": "./package.json",
  },
  files: ["dist", "cordis.patch.yml"],
  dependencies: {},
  peerDependencies: {
    "@deepseek-ai/cordis": ">=0.1.0",
  },
};

writeFileSync(
  join(root, "packages/bundle/package.publish.json"),
  JSON.stringify(publishable, null, 2),
);

console.log("bundle publish manifest written");
