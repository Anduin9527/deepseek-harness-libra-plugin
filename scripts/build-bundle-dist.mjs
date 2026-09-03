import { build } from "esbuild";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "packages/bundle/package.json"), "utf8"));
const protocolSource = join(root, "protocol");
const protocolTarget = join(root, "packages/bundle/dist/protocol");

await build({
  entryPoints: [join(root, "packages/bundle/src/index.ts")],
  outfile: join(root, "packages/bundle/dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-agent",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-session",
  ],
  sourcemap: true,
});

if (!existsSync(protocolSource)) {
  throw new Error("protocol fixture directory is missing; cannot build a self-contained bundle");
}
cpSync(protocolSource, protocolTarget, { recursive: true });

const publishable = {
  ...pkg,
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json",
  },
  files: ["dist", "cordis.patch.yml", "README.md", "LICENSE"],
  dependencies: {},
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: pkg.peerDependenciesMeta,
};

writeFileSync(
  join(root, "packages/bundle/package.publish.json"),
  JSON.stringify(publishable, null, 2),
);

console.log("bundle publish manifest written");
