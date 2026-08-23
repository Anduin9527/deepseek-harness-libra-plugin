#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const frame = JSON.parse(trimmed);
  if (frame.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        result: {
          protocol: { major: 1, minor: 0 },
          limits: { max_frame_bytes: 262144, max_inflight: 64 },
          methods: ["initialize", "status.get"],
          source: "deepseek-harness",
        },
        id: frame.id,
      })}\n`,
    );
    return;
  }
  process.exit(2);
});
