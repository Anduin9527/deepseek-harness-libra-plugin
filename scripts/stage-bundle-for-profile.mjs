import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/bundle/dist");
const patch = join(root, "packages/bundle/cordis.patch.yml");
const publishManifest = join(root, "packages/bundle/package.publish.json");
if (!existsSync(dist) || !existsSync(patch) || !existsSync(publishManifest)) {
  console.error("bundle dist/patch/publish manifest missing; run pnpm build first");
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), "libra-dsh-bundle-"));
cpSync(dist, join(staging, "dist"), { recursive: true });
cpSync(patch, join(staging, "cordis.patch.yml"));
const publish = JSON.parse(
  readFileSync(publishManifest, "utf8"),
);
writeFileSync(join(staging, "package.json"), JSON.stringify(publish, null, 2));
console.log(staging);
