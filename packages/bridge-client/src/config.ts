import type { BridgeClientConfig } from "./types.js";

export const BRIDGE_FIXED_ARGS = ["agent", "bridge", "--stdio"] as const;

const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LIBRA_SKIP_WEB_BUILD",
] as const;

export class BridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConfigError";
  }
}

export function normalizeBridgeConfig(config: BridgeClientConfig): BridgeClientConfig {
  if (!config.executable || config.executable.trim().length === 0) {
    throw new BridgeConfigError("bridge executable must be configured explicitly");
  }
  if (!config.cwd || config.cwd.trim().length === 0) {
    throw new BridgeConfigError("bridge cwd must be configured explicitly");
  }

  const args = config.args ?? BRIDGE_FIXED_ARGS;
  if (args.length !== BRIDGE_FIXED_ARGS.length) {
    throw new BridgeConfigError("bridge argv must be exactly agent bridge --stdio");
  }
  for (let i = 0; i < BRIDGE_FIXED_ARGS.length; i++) {
    if (args[i] !== BRIDGE_FIXED_ARGS[i]) {
      throw new BridgeConfigError("bridge argv must be exactly agent bridge --stdio");
    }
  }

  const env: Record<string, string> = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      if (!DEFAULT_ENV_ALLOWLIST.includes(key as typeof DEFAULT_ENV_ALLOWLIST[number])) {
        throw new BridgeConfigError(`environment key ${key} is not in the bridge allowlist`);
      }
      env[key] = value;
    }
  }

  return {
    ...config,
    args: BRIDGE_FIXED_ARGS,
    env,
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
  };
}
