---
description: "Inspect unfinished model calls through bounded request metadata and raw response body prefixes."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-request-diagnostics

English | [中文](README.zh.md)

## Summary

Inspect unfinished model requests before their streams settle. Each request gets a private NDJSON metadata file and separate raw response body files, available while the consumer reads. Response bodies can contain sensitive text, including echoed prompts or credentials. Recording is bounded and synchronous; observation failures are reported to stderr and do not fail the model call. Files remain outside Session history and model context.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Base-backed profiles enable this plugin under the `llm-request-diagnostics` row and write to the Harness home's `logs/llm-requests` directory. Configure a separate composition with a plugin row:

```yaml
- name: '@deepseek-ai/dsh-llm-request-diagnostics'
  config:
    directory: /absolute/path/to/request-diagnostics
    progressIntervalMs: 5000
    maxFileBytes: 1048576
    maxResponseBodyBytes: 16777216
```

| Field | Default | Meaning |
|---|---|---|
| `directory` | required | Parent directory for UUID-named metadata and response body files |
| `progressIntervalMs` | `5000` | Positive integer interval between progress snapshots |
| `maxFileBytes` | `1048576` | Metadata byte ceiling, at least 8192; reserves body-end, truncation, abort and terminal records |
| `maxResponseBodyBytes` | `16777216` | Total raw body bytes across all HTTP replies in one adapter invocation; `0` disables body files |

Each record has `schemaVersion: 1`, a request UUID, and an epoch-millisecond `timeMs`. `request-start` additionally records the start time, optional Session id and purpose, provider, and model; each identifier is limited to 128 UTF-16 code units. HTTP exchanges have request-local numeric ids. `http-dispatch`, `http-headers`, the first consumed body bytes, body EOF/error/cancel, the first normalized chunk, signal abort, and finish are written synchronously. `lastNormalizedChunkType` records only the chunk's type. A `model-finish` event immediately records the provider's terminal kind and filtered error code, before iterator cleanup; the later `finish` records the settled request outcome. Later bytes and nonterminal chunks update counters without one write per token; periodic progress and terminal records carry the latest totals and first/last timestamps.

`consumedBodyBytes` counts decoded body bytes delivered to a consumer through the wrapped fetch response. It does not measure wire bytes or prove when data reached the network socket. `httpObserved: false` means no wrapped fetch was observed, not that the provider sent no request. A stalled consumer can leave byte counters unchanged while transport buffers contain data.

Each HTTP reply gets `<requestId>.<httpId>.response.bin` beside `<requestId>.ndjson`. Consumed raw `Uint8Array` chunks are written before delivery, without text decoding, teeing, prefetching or full-body buffering. The shared invocation budget preserves a prefix of each reply in consumption order; retries do not reset it. `body-open` references the file and a `contentType` limited to 128 UTF-16 code units. `body-end` records consumed and written bytes, truncation, capture or stream errors, and whether the stream was incomplete. EOF means the HTTP body ended, independently of inference completion. Finishing or disposing a tracker closes unfinished files with `reason: unfinished`; later consumption remains available without further capture. A killed process leaves the written prefix and no synthetic end record.

Metadata excludes URLs, queries, request headers, prompts, tool definitions or arguments, normalized response text, error messages and abort reasons; the bounded response content type is the only recorded header value. Raw response files are not redacted and can contain any sensitive data returned by a provider. Finish codes must match `[A-Z][A-Z0-9_]{0,63}`; all other supplied codes become `UNCLASSIFIED`. Files open exclusively with mode 0600, and new directories request mode 0700; existing directory permissions are unchanged, and Windows access follows its ACLs. Writes reach the operating system before delivery; there is no fsync or power-loss durability guarantee.

At the metadata limit, one `log-truncated` event marks suppressed intermediate records; admitted body references and end records, model-finish, abort and finish remain recordable. A new body file requires reserved metadata space for its reference and end; otherwise capture is skipped and `bodyCaptureSkipped` reports the count. `observer-disposed` means the plugin unloaded before model settlement and does not claim a model outcome. An open body without an end record is incomplete. Body-file failures emit a fixed stderr diagnostic and preserve the saved prefix; metadata-file failures disable the tracker. Neither failure changes model execution. Duplicate observer providers are reported and this plugin retains the downstream observer without creating another file.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The synchronous `llm/request-diagnostics` waterfall allocates one tracker per adapter invocation. Its UUID links metadata and body files without guessing agent step numbers. The plugin owns its active set, file descriptors, timer cleanup and abort-listener cleanup through its Cordis lifecycle. Each wrapped body pulls one original chunk only when its consumer asks; it neither tees nor reads ahead. Response metadata and standard body readers remain available. Disposing the plugin closes files and stops timers without cancelling model requests.

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Configuration, waterfall registration and plugin lifetime |
| [src/tracker.ts](src/tracker.ts) | File limits, synchronous records, counters and demand-driven fetch observation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM service](../llm/README.md) — per-call observer interface and adapter dispatch.
- [LLM retry](../llm-retry/README.md) — request recovery policy and retry events.
- [Base bundle](../../bundle/base/README.md) — default profile composition.

-----

<a id="model-experience"></a>
## Model Experience

None, as records remain outside Session history and no model-visible prompt, tool, or message is added.

#### KV Cache effect

None; diagnostic metadata does not enter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits constrain diagnosis and retention:

- HTTP stages require the adapter to use the observer's fetch. Other transports may provide only normalized-chunk observations; missing HTTP observations are not evidence of a network stall.
- Metadata and body-byte budgets are bounded per invocation; file count and retention across invocations are not automatically managed. Operators own access controls, archival and removal of potentially sensitive captures.
- Synchronous writes can delay the request on a slow filesystem. A host crash may leave a partial last line; read only complete NDJSON records.
- Consumer read timing cannot distinguish an upstream pause from buffered data that the consumer has not requested. Gateway logs or transport instrumentation are needed for that distinction.

<a id="dev-note"></a>
### Dev Note

None.
