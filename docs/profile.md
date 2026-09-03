# Libra profile setup

Build and pack the bundle in the Libra development container:

```bash
pnpm build
pnpm pack:bundle -- --destination /tmp/libra-dsh-bundle
```

Install the resulting tarball into a DSH profile:

```bash
corepack pnpm dsh plugin --profile headless add \
  /tmp/libra-dsh-bundle/libra-tools-dsh-bundle-0.1.0.tgz
corepack pnpm dsh --profile headless --dump-config
```

`dsh plugin add` records `@libra-tools/dsh-bundle` in both the profile's
`dependencies` and `dsh.profile.bundles`. The bundle starts one
`libra agent bridge --stdio` child and registers the Cordis Memory lifecycle
adapter. Missing host services, bridge methods, or invalid recall responses stop
the current model turn; they do not silently degrade to stale Memory.

Configuration resolution is:

- `libraExecutable`, then `LIBRA_BINARY`;
- `repositoryRoot`, then `LIBRA_REPO`, then the canonical current directory.

The target repository must already be initialized by Libra. Direct installation
from the GitHub monorepo root is not supported in this MVP because the installable
bundle lives under `packages/bundle`; use the packed tarball until a root facade or
npm release is prepared.
