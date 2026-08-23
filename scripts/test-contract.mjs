import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

if (args.includes("--libra-release")) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "tests/bridge-client/libra-contract-flow.test.ts"], {
    stdio: "inherit",
    shell: true,
  });
  process.exit(result.status ?? 1);
}

if (args.includes("--events")) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "tests/session"], {
    stdio: "inherit",
    shell: true,
  });
  process.exit(result.status ?? 1);
}

if (args.includes("--tools")) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "tests/tools"], {
    stdio: "inherit",
    shell: true,
  });
  process.exit(result.status ?? 1);
}

if (args.includes("--workspace")) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "tests/workspace"], {
    stdio: "inherit",
    shell: true,
  });
  process.exit(result.status ?? 1);
}

const idx = args.indexOf("--protocol-version");
const major = idx >= 0 ? args[idx + 1] : undefined;
if (!major) {
  console.error("test:contract requires --protocol-version <major>");
  process.exit(1);
}
if (major !== "1") {
  console.error(`unsupported protocol major ${major}`);
  process.exit(1);
}

const result = spawnSync("pnpm", ["exec", "vitest", "run", "tests/bridge-client"], {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
