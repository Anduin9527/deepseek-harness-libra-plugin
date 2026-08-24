import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const args = process.argv.slice(2);
const requested = [];
const protocolIndex = args.indexOf("--protocol-version");
const protocolMajor = protocolIndex >= 0 ? args[protocolIndex + 1] : undefined;
const libraIndex = args.indexOf("--libra-release");
const libraRelease = libraIndex >= 0 ? args[libraIndex + 1] : undefined;

if (!existsSync(vitest)) {
  console.error("vitest executable is missing; run pnpm install --frozen-lockfile");
  process.exit(1);
}
if (protocolMajor && protocolMajor !== "1") {
  console.error(`unsupported protocol major ${protocolMajor}`);
  process.exit(1);
}
if (!protocolMajor && !libraRelease && !args.includes("--events") && !args.includes("--tools") && !args.includes("--workspace")) {
  console.error("test:contract requires --protocol-version <major> or a named contract gate");
  process.exit(1);
}

if (libraRelease) {
  const binary = process.env.LIBRA_BINARY;
  const repo = process.env.LIBRA_REPO;
  if (!binary || !repo) {
    console.error(`remote-pending: Libra release ${libraRelease} requires LIBRA_BINARY and LIBRA_REPO`);
    process.exit(2);
  }
  requested.push(["tests/bridge-client/libra-handshake.test.ts", "tests/bridge-client/libra-contract-flow.test.ts"]);
}
if (args.includes("--events")) {
  requested.push(["tests/session"]);
}
if (args.includes("--tools")) {
  requested.push(["tests/tools"]);
}
if (args.includes("--workspace")) {
  requested.push(["tests/workspace"]);
}
if (protocolMajor) {
  requested.push(["tests/protocol", "tests/bridge-client"]);
}

let exitCode = 0;
for (const testPaths of requested) {
  const result = spawnSync(process.execPath, [vitest, "run", ...testPaths], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if ((result.status ?? 1) !== 0) {
    exitCode = result.status ?? 1;
    break;
  }
}
process.exit(exitCode);
