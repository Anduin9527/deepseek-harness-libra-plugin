# Libra profile setup

```bash
DSH_CLI="/absolute/path/to/pinned/dsh-v0.1.0-rc.7"
"$DSH_CLI" plugin --profile libra add file:/tmp/libra-dsh-bundle-<run>
"$DSH_CLI" --profile libra --dump-config
```

The `libra` profile installs `@libra-tools/dsh-bundle`, which registers the Cordis layer `libra`. The bundle starts `libra agent bridge --stdio` after a pinned DSH host supplies the lifecycle adapter; without that host capability it reports `degraded-no-host`.

Required: Libra repository initialized (`libra init`) and Libra binary on PATH or configured explicitly.
