# Agent Note: Model request progress outside Session history

Status: implemented

English | [中文](2026-11-04-model-request-diagnostics.zh.md)

## Problem

A model call can remain unfinished after HTTP headers or partial output arrive. The [embedded-stream decision](2026-09-01-v2-embedded-assistant-streams.md) commits content at attempt settlement, so a hard process loss can leave only a step-start event. Operators cannot distinguish undispatched work, pending headers, consumed response data, and normalized output from that evidence. Capturing full wire bodies also retains prompts and generated content that a liveness investigation does not need.

## Decision

The [request diagnostics plugin](../../../../packages/llm/llm-request-diagnostics/README.md) owns a separate, bounded NDJSON file per model invocation. Provider adapters obtain an observer through the LLM extension point; the loop, Session format, model context, and retry policy remain independent. Files contain attribution, HTTP exchange ordinals, status, byte/chunk counters and timestamps, progress checkpoints, and terminal states. No URL, headers, body, error message, or abort reason enters these records.

A synchronous append at each phase and periodic checkpoint makes earlier records readable before the model attempt ends and after process termination. It does not promise power-loss durability. Body observation follows the provider consumer without teeing or reading ahead: counters measure consumed, fetch-decompressed bytes, not physical network arrival. An unobserved HTTP exchange remains unknown because some provider transports do not use the injected fetch.

The existing embedded-stream and [Trajectory request/response inspection](../feature/2026-09-10-trajectory-request-input.md) decisions remain active. Their complete content and replay guarantees are not replaced by diagnostic counters. Metadata alone cannot reconstruct a lost response or become evidence that a tool ran; [bounded response prefixes](2026-11-06-incremental-response-prefixes.md) provide separate content evidence without changing this record's authority.

## Alternatives considered

**Persist every token as a Session event.** This restores per-token event and storage costs, changes the Session representation, and mixes operational metadata with replay authority. The independent record keeps only progress evidence and cannot alter model history.

**Wait for response capture to flush.** A hung call or hard process stop may never reach that finalizer. Independent checkpoints retain useful evidence before completion.

**Read a cloned response in parallel.** A tee can consume ahead of the provider, buffer additional data, and change the observed timing or cancellation behavior. Observation belongs on the existing consumer-driven reader.

**Log all headers, URLs and exception text.** These can contain credentials, user content or private endpoint data. Bounded counters and controlled machine codes provide the needed stage information without retaining those values.

## Consequences

Small synchronous writes add filesystem latency at phase boundaries and configured intervals. File-size bounds stop ordinary checkpoints with an explicit truncation record while reserving room for terminal metadata; completed files are retained until the operator removes them. Logging failure is visible on stderr and disables that observer without converting a model result into an error. Plugin disposal closes its files and timers without cancelling the model call.

The headless profile tests terminate real subprocesses while headers are pending and while an incomplete body has produced normalized output. Both retain readable diagnostic prefixes without a fabricated finish. Observer tests cover no read-ahead, unchanged bytes and Response metadata, cancellation, size bounds, private-content exclusion and lifecycle disposal. Adapter tests retain existing request, output, error and retry behavior.
