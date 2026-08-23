import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, ".profile-bundle-staging");
mkdirSync(staging, { recursive: true });
cpSync(join(root, "packages/bundle/dist"), join(staging, "dist"), { recursive: true });
cpSync(join(root, "packages/bundle/cordis.patch.yml"), join(staging, "cordis.patch.yml"));
const publish = JSON.parse(
  readFileSync(join(root, "packages/bundle/package.publish.json"), "utf8"),
);
writeFileSync(join(staging, "package.json"), JSON.stringify(publish, null, 2));
console.log(staging);
