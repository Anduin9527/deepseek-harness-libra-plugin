import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const profile = profileIdx >= 0 ? args[profileIdx + 1] : "libra";

const stage = spawnSync("node", ["scripts/stage-bundle-for-profile.mjs"], {
  cwd: root,
  encoding: "utf8",
});
const stagingPath = stage.stdout.trim();
if (!stagingPath) {
  console.error("failed to stage bundle");
  process.exit(1);
}

const add = spawnSync(
  "npx",
  ["@deepseek-ai/dsh", "plugin", "--profile", profile, "add", `file:${stagingPath}`],
  { cwd: root, stdio: "inherit", shell: true },
);
if ((add.status ?? 1) !== 0) {
  process.exit(add.status ?? 1);
}

const dump = spawnSync(
  "npx",
  ["@deepseek-ai/dsh", "--profile", profile, "--dump-config"],
  { cwd: root, stdio: "inherit", shell: true },
);
process.exit(dump.status ?? 1);
