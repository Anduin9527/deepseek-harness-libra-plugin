# Libra profile setup

```bash
dsh plugin --profile libra add file:packages/bundle
dsh --profile libra --dump-config
```

The `libra` profile installs `@libra-tools/dsh-bundle`, which registers the Cordis layer `libra` and starts `libra agent bridge --stdio` against the repository cwd configured in bundle config.

Required: Libra repository initialized (`libra init`) and Libra binary on PATH or configured explicitly.
