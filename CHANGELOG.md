# Changelog

## 0.1.0 — 2026-08-24

- Initial `@libra/dsh-bundle` release for DeepSeek Harness `dsh-v0.1.0-rc.7`.
- Protocol receiver for Libra agent bridge v1 (`DEP-LB-01` fixture from libra `0.21.0`).
- Bridge client, session projection/outbox, tools facade, workspace binding, context injection, and UI cards.
- Profile install via staged bundle: `node scripts/stage-bundle-for-profile.mjs` then `dsh plugin --profile libra add file:.profile-bundle-staging`.
