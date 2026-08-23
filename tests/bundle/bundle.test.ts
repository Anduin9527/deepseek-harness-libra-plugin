import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createLibraBundleRuntime, bundlePluginName } from "@libra/dsh-bundle";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

describe("bundle runtime", () => {
  let runtime: Awaited<ReturnType<typeof createLibraBundleRuntime>> | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = undefined;
    }
  });

  it("loads all Libra integration packages", async () => {
    runtime = await createLibraBundleRuntime({
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
      outboxRoot: mkdtempSync(join(tmpdir(), "dsh-bundle-outbox-")),
    });
    expect(bundlePluginName).toBe("@libra/dsh-bundle");
    const tools = runtime.tools.listTools();
    expect(tools.map((tool) => tool.name)).toContain("libra_status");
  });
});
