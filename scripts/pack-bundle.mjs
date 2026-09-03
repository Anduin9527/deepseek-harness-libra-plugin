import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const destinationIndex = args.indexOf("--destination");
const destination = resolve(
  destinationIndex >= 0 && args[destinationIndex + 1]
    ? args[destinationIndex + 1]
    : root,
);

mkdirSync(destination, { recursive: true });

const stage = spawnSync(process.execPath, [join(root, "scripts/stage-bundle-for-profile.mjs")], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
if ((stage.status ?? 1) !== 0 || !stage.stdout.trim()) {
  process.stderr.write(stage.stderr ?? "");
  throw new Error("failed to stage @libra-tools/dsh-bundle; run pnpm build first");
}

const stagingPath = stage.stdout.trim();
try {
  const manifest = JSON.parse(readFileSync(join(stagingPath, "package.json"), "utf8"));
  const archiveName = `${String(manifest.name).replace(/^@/, "").replaceAll("/", "-")}-${String(manifest.version)}.tgz`;
  const archivePath = join(destination, archiveName);
  const packed = spawnSync("corepack", ["pnpm", "pack", "--pack-destination", destination], {
    cwd: stagingPath,
    encoding: "utf8",
    shell: false,
  });
  if ((packed.status ?? 1) !== 0 || !existsSync(archivePath)) {
    process.stderr.write(packed.stdout ?? "");
    process.stderr.write(packed.stderr ?? "");
    throw new Error("failed to pack @libra-tools/dsh-bundle");
  }
  console.log(archivePath);
} finally {
  rmSync(stagingPath, { recursive: true, force: true });
}
