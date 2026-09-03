import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const DSH_COMMIT = "cd5ef8148158c3a752a658978873241fdf8e2bbc";
const BUNDLE_NAME = "@libra-tools/dsh-bundle";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function valueFor(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function run(command, commandArgs, options, label) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
    ...options,
  });
  if ((result.status ?? 1) !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${label} failed`);
  }
  return result;
}

const dshInput = valueFor("--dsh-checkout", process.env.DSH_CHECKOUT);
const libraInput = valueFor("--libra-binary", process.env.LIBRA_BINARY);
const repositoryInput = valueFor("--libra-repo", process.env.LIBRA_REPO);
const query = valueFor("--query", process.env.LIBRA_GATE_QUERY);
const expected = valueFor("--expected", process.env.LIBRA_GATE_EXPECTED_SUBSTRING);
const live = args.includes("--live");
const deepseekApiKey = process.env.DEEPSEEK_API_KEY
  ?? (process.env.DEEPSEEK_API_KEY_FILE
    ? readFileSync(resolve(process.env.DEEPSEEK_API_KEY_FILE), "utf8").trim()
    : undefined);

if (!dshInput || !libraInput || !repositoryInput || !query || !expected) {
  fail("DSH_CHECKOUT, LIBRA_BINARY, LIBRA_REPO, LIBRA_GATE_QUERY, and LIBRA_GATE_EXPECTED_SUBSTRING are required");
}
if (live && !deepseekApiKey) {
  fail("--live requires DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE");
}

const dshCheckout = resolve(dshInput);
const libraBinary = resolve(libraInput);
const libraRepo = resolve(repositoryInput);
for (const path of [dshCheckout, libraBinary, libraRepo, join(libraRepo, ".libra")]) {
  if (!existsSync(path)) fail(`required integration path does not exist: ${path}`);
}

const revision = run(
  "git",
  ["-C", dshCheckout, "rev-parse", "HEAD"],
  {},
  "DSH revision check",
);
if (revision.stdout.trim() !== DSH_COMMIT) {
  fail(`DSH checkout must be exactly ${DSH_COMMIT}`);
}

const dshHome = mkdtempSync(join(tmpdir(), "libra-dsh-home-"));
const packDir = mkdtempSync(join(tmpdir(), "libra-dsh-pack-"));
const loaderSmoke = join(dshCheckout, "packages/test-support/loader-smoke");
const bundleTarget = join(loaderSmoke, "node_modules/@libra-tools/dsh-bundle");
const gateSource = join(root, "tests/dsh-alpha1/runtime-gate.spec.ts");
const gateFileName = `libra-runtime-gate-${process.pid}.spec.ts`;
const gateTarget = join(loaderSmoke, "tests", gateFileName);
const receiptFile = join(packDir, "receipt.json");
let createdBundleTarget = false;
let createdGateTarget = false;
let exitCode = 1;

try {
  const packed = run(
    process.execPath,
    [join(root, "scripts/pack-bundle.mjs"), "--destination", packDir],
    { cwd: root },
    "bundle pack",
  );
  const archivePath = packed.stdout.trim().split(/\r?\n/).at(-1);
  if (!archivePath || !existsSync(archivePath)) {
    throw new Error("bundle pack did not produce a tarball");
  }

  const profileEnv = { ...process.env, DSH_HOME: dshHome };
  delete profileEnv.DEEPSEEK_API_KEY;
  delete profileEnv.DEEPSEEK_API_KEY_FILE;
  delete profileEnv.LIBRA_GATE_EXPECTED_SUBSTRING;
  const install = run(
    "corepack",
    ["pnpm", "dsh", "plugin", "--profile", "headless", "add", archivePath],
    { cwd: dshCheckout, env: profileEnv },
    "dsh plugin add",
  );
  process.stdout.write(install.stdout);

  const profileManifestPath = join(dshHome, "profiles/headless/package.json");
  const profileManifest = JSON.parse(readFileSync(profileManifestPath, "utf8"));
  if (
    !profileManifest.dependencies?.[BUNDLE_NAME]
    || !profileManifest.dsh?.profile?.bundles?.includes(BUNDLE_NAME)
  ) {
    throw new Error("dsh plugin add did not activate the Libra bundle in the profile");
  }

  const dump = run(
    "corepack",
    ["pnpm", "dsh", "--profile", "headless", "--dump-config"],
    { cwd: dshCheckout, env: profileEnv },
    "profile composition",
  );
  if (!dump.stdout.includes(`name: '${BUNDLE_NAME}'`)) {
    throw new Error("composed headless profile is missing the Libra plugin row");
  }

  const installedBundle = realpathSync(
    join(dshHome, "profiles/headless/node_modules/@libra-tools/dsh-bundle"),
  );
  const requiredBundleFiles = [
    "package.json",
    "README.md",
    "LICENSE",
    "cordis.patch.yml",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/protocol/agent-bridge.v1.schema.json",
    "dist/protocol/agent-bridge.v1.receipt.json",
  ];
  for (const relativePath of requiredBundleFiles) {
    if (!existsSync(join(installedBundle, relativePath))) {
      throw new Error(`installed bundle is missing ${relativePath}`);
    }
  }
  if (existsSync(bundleTarget) || existsSync(gateTarget)) {
    throw new Error("DSH checkout contains a reserved Libra integration path; use a clean pinned checkout");
  }
  mkdirSync(dirname(bundleTarget), { recursive: true });
  mkdirSync(dirname(gateTarget), { recursive: true });
  createdBundleTarget = true;
  cpSync(installedBundle, bundleTarget, { recursive: true });
  createdGateTarget = true;
  copyFileSync(gateSource, gateTarget);

  const runtime = run(
    "corepack",
    [
      "pnpm",
      "exec",
      "vitest",
      "run",
      `packages/test-support/loader-smoke/tests/${gateFileName}`,
      "-t",
      "loads the bundle through the real Loader",
    ],
    {
      cwd: dshCheckout,
      env: {
        ...profileEnv,
        LIBRA_BINARY: libraBinary,
        LIBRA_REPO: libraRepo,
        LIBRA_GATE_QUERY: query,
        LIBRA_GATE_EXPECTED_SUBSTRING: expected,
        LIBRA_GATE_SESSION_ID: `libra-dsh-alpha1-${process.pid}`,
        LIBRA_GATE_RECEIPT_FILE: receiptFile,
      },
    },
    "packed Loader/AgentLoop runtime gate",
  );
  process.stdout.write(runtime.stdout);
  process.stderr.write(runtime.stderr);

  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  if (
    !/^[0-9a-f-]+$/.test(receipt.receiptId)
    || !/^sha256:[0-9a-f]{64}$/.test(receipt.bundleHash)
    || receipt.selectedCount !== 1
    || receipt.tokenBudget !== 1600
  ) {
    throw new Error("runtime gate returned invalid receipt metadata");
  }
  const receiptSql = [
    "SELECT EXISTS(",
    "  SELECT 1 FROM context_selection_receipt",
    `  WHERE receipt_id = '${receipt.receiptId}'`,
    "    AND source_kind = 'memory'",
    "    AND selector_version = 'episode-fts-bm25-v1+context-budget-v1'",
    `    AND token_budget = ${receipt.tokenBudget}`,
    `    AND bundle_hash = '${receipt.bundleHash}'`,
    `    AND json_array_length(selected_json) = ${receipt.selectedCount}`,
    "    AND reproducibility_state = 'reproducible'",
    "    AND frame_id IS NULL",
    ");",
  ].join("\n");
  const receiptCheck = run(
    "sqlite3",
    ["-readonly", join(libraRepo, ".libra/libra.db"), receiptSql],
    {},
    "receipt persistence check",
  );
  if (receiptCheck.stdout.trim() !== "1") {
    throw new Error("runtime receipt was not durably persisted");
  }

  if (live) {
    const task = [
      "Use the retrieved Libra project memory.",
      `What verified fact is associated with ${query}?`,
      "Reply with only the fact value.",
    ].join(" ");
    const headless = run(
      "corepack",
      ["pnpm", "dsh", "--profile", "headless", task],
      {
        cwd: dshCheckout,
        env: {
          ...profileEnv,
          DEEPSEEK_API_KEY: deepseekApiKey,
          LIBRA_BINARY: libraBinary,
          LIBRA_REPO: libraRepo,
        },
        timeout: 120_000,
      },
      "live headless profile",
    );
    if (headless.stdout.trim().toLowerCase() !== expected.trim().toLowerCase()) {
      throw new Error("live headless final assistant text did not equal the expected Memory fact");
    }
    console.info(JSON.stringify({
      kind: "libra-live-profile-acceptance",
      model: "deepseek-v4-flash",
      installedThrough: "dsh plugin add",
      answerMatched: true,
    }));
  }

  console.info(JSON.stringify({
    kind: "libra-packaged-profile-gate",
    dshCommit: DSH_COMMIT,
    bundle: BUNDLE_NAME,
    profileInstalled: true,
    profileComposed: true,
    runtimeInjected: true,
    receiptPersisted: true,
  }));
  exitCode = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  if (createdBundleTarget) rmSync(bundleTarget, { recursive: true, force: true });
  if (createdGateTarget) rmSync(gateTarget, { force: true });
  rmSync(dshHome, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
}

process.exit(exitCode);
