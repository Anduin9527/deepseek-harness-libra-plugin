# Privacy and redaction

The session projection adapter never writes raw prompts, reasoning traces, environment
variables, or detected secrets to Libra. Payloads are size-checked and scanned for common
secret patterns before enqueue.

When redaction cannot be performed safely, the event is marked `rejected` in the plugin
outbox and is not sent to `event.append`. There is no fallback that writes the original
payload.

Outbox files live under the Harness profile storage seam and inherit that directory's
permissions. They are not written into `.libra/libra.db` or Libra object storage.

## Memory module

The Memory module sends the accepted query text and DSH session id to the Libra
bridge. It does not project the rest of the DSH transcript. Libra applies its own
Memory access, sensitivity, selector, and budget rules before returning a prompt
section, and persists the corresponding selection receipt before delivery.
