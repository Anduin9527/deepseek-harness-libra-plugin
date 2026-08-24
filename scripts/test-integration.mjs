import { accessSync, constants, existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueFor = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const profile = valueFor("--profile", "libra");
const revision = valueFor("--revision", process.env.DSH_REVISION);
const expectedRevision = "dsh-v0.1.0-rc.7";
const dshCli = process.env.DSH_CLI;
const libraBinary = valueFor("--libra-binary", process.env.LIBRA_BINARY);
const libraRepo = valueFor("--libra-repo", process.env.LIBRA_REPO);
const context = args.includes("--context");
const ui = args.includes("--ui");

if (!revision) {
  console.error(`remote-pending: pinned DSH revision is required (--revision ${expectedRevision})`);
  process.exit(2);
}
if (revision !== expectedRevision) {
  console.error(`unsupported DSH revision ${revision}; expected ${expectedRevision}`);
  process.exit(1);
}
if (!dshCli || !existsSync(dshCli)) {
  console.error("remote-pending: DSH_CLI must point to the pinned DSH executable");
  process.exit(2);
}
try {
  accessSync(dshCli, constants.X_OK);
} catch {
  console.error("DSH_CLI is not executable");
  process.exit(1);
}
if (!libraBinary || !libraRepo || !existsSync(libraBinary) || !existsSync(join(libraRepo, ".libra"))) {
  console.error("remote-pending: --libra-binary/--libra-repo must identify a built, initialized Libra checkout");
  process.exit(2);
}

const stage = spawnSync(process.execPath, [join(root, "scripts/stage-bundle-for-profile.mjs")], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
if ((stage.status ?? 1) !== 0 || !stage.stdout.trim()) {
  process.stderr.write(stage.stderr ?? "");
  console.error("failed to stage bundle");
  process.exit(stage.status ?? 1);
}

const stagingPath = stage.stdout.trim();
const stagedPackagePath = join(stagingPath, "package.json");
const stagedPackage = JSON.parse(readFileSync(stagedPackagePath, "utf8"));
if (stagedPackage.name !== "@libra-tools/dsh-bundle") {
  rmSync(stagingPath, { recursive: true, force: true });
  console.error("staged package name does not match the Libra bundle");
  process.exit(1);
}

const childEnv = {
  ...process.env,
  DSH_REVISION: revision,
  LIBRA_BINARY: libraBinary,
  LIBRA_REPO: libraRepo,
  DSH_EXPECTED_CAPABILITIES: ["session", "agent", "subagent", ...(context ? ["context"] : []), ...(ui ? ["ui"] : [])].join(","),
};
const featureFlags = [
  ...(context ? ["--context"] : []),
  ...(ui ? ["--ui"] : []),
];
let exitCode = 0;
let attemptedInstall = false;
try {
  attemptedInstall = true;
  const add = spawnSync(
    dshCli,
    ["plugin", "--profile", profile, "add", `file:${stagingPath}`],
    { cwd: root, env: childEnv, stdio: "inherit", shell: false },
  );
  if ((add.status ?? 1) !== 0) {
    exitCode = add.status ?? 1;
  } else {
    const dump = spawnSync(
      dshCli,
      ["--profile", profile, "--dump-config", ...featureFlags],
      { cwd: root, env: childEnv, encoding: "utf8", shell: false },
    );
    process.stdout.write(dump.stdout ?? "");
    process.stderr.write(dump.stderr ?? "");
    exitCode = dump.status ?? 1;
    if (exitCode === 0 && !(dump.stdout ?? "").includes("@libra-tools/dsh-bundle")) {
      console.error("DSH dump-config did not prove that the Libra bundle is installed");
      exitCode = 1;
    }
  }
} finally {
  if (attemptedInstall) {
    const remove = spawnSync(
      dshCli,
      ["plugin", "--profile", profile, "remove", "@libra-tools/dsh-bundle"],
      { cwd: root, env: childEnv, stdio: "inherit", shell: false },
    );
    if (exitCode === 0 && (remove.status ?? 1) !== 0) {
      exitCode = remove.status ?? 1;
    }
  }
  rmSync(stagingPath, { recursive: true, force: true });
}
process.exit(exitCode);
