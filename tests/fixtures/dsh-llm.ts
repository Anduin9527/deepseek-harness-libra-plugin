let nextId = 1;

export function createUserMessage(input: Record<string, unknown>): Record<string, unknown> {
  return Object.freeze({
    ...structuredClone(input),
    id: `test-message-${nextId++}`,
    role: "user",
  });
}
