# Agent Note: Bounded response prefixes survive unfinished requests

Status: implemented

English | [中文](2026-11-06-incremental-response-prefixes.zh.md)

## Problem

[Request progress records](2026-11-04-model-request-diagnostics.md) distinguish waiting from active consumption but cannot reveal repeated SSE events or missing terminal events. The Web trajectory captures response text at adapter finalization; headless has no trajectory persistence listener, and a hard process stop cannot execute that finalizer. An unfinished request therefore needs a separate response-prefix record before settlement.

## Decision

The [request diagnostics plugin](../../../../packages/llm/llm-request-diagnostics/README.md) owns private response files beside its per-invocation metadata. It appends consumed HTTP body bytes before delivering them to the provider parser, under one byte budget shared by the invocation's HTTP exchanges. No tee, second reader, or unbounded memory buffer is introduced. Metadata identifies each admitted file and records its retained-byte count, truncation, errors, and terminal observation; EOF and model completion remain separate facts.

Raw prefixes are diagnostic evidence, not Session history or replay authority. They may contain sensitive model output, so the configuration supports disabling body retention while preserving progress metadata. No request body, authentication header, URL, exception message, or cancellation reason is added to these files. Operators own retention and access to the diagnostic directory.

The existing progress and [embedded-stream](2026-09-01-v2-embedded-assistant-streams.md) decisions stay active. Response prefixes supplement their evidence without committing partial assistant messages to model context. The separate legacy response preview is also byte-bounded; its truncation flag is independent of transport EOF and remains visible in Web trajectory inspection.

## Alternatives considered

**Only flush at request completion.** An indefinitely active stream or SIGKILL can prevent completion. Incremental writes preserve the consumed prefix without depending on teardown.

**Persist every parsed chunk in Session history.** This changes replay semantics and multiplies Session events. Raw HTTP evidence is useful even when the provider parser cannot produce a complete tool call.

**Duplicate the response with a tee.** Independent reading changes backpressure and retains additional pending bytes. The existing consumer determines observation progress.

## Consequences

Synchronous writes add filesystem latency to consumed chunks. Byte limits and metadata reservations bound each invocation; a process stop can leave a partial final chunk or metadata line and no terminal record. Earlier OS writes survive process termination, but no fsync or power-loss guarantee is made. Storage failures are visible and contained without changing model bytes or retry policy.

Verification covers live prefix readback, shared limits across replies, byte-exact truncation, read-ahead prevention, write failure, cancellation and disposal. Shipped headless subprocess cases inspect prefixes before SIGKILL and after exit for both supported HTTP protocols; capped and disabled capture preserve model parsing progress without fabricating EOF or completion.
