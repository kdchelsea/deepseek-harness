---
kind: upgrade-guide
description: "Response inspection retains bounded prefixes, and base profiles store private raw response diagnostics before request completion."
---

# Response capture limits and diagnostic files

English | [中文](guide.zh.md)

## Change

Raw response previews used by Web trajectory inspection have a 16 MiB default byte budget per model generation, shared across HTTP replies. Larger responses remain fully available to the model adapter, but the preview is truncated and explicitly marked. `complete` still reports transport EOF; the optional `truncated` field reports preview omission independently.

Base profiles also save consumed response prefixes incrementally in the request diagnostic directory, including headless runs. These private files can contain sensitive generated content. Their default 16 MiB budget is independent of the Web preview budget. Progress metadata remains available when body retention is disabled.

## Migration

1. Review access and retention for the diagnostic directory. Set `llm-request-diagnostics.maxResponseBodyBytes` to `0` when response content must not be retained, or choose an appropriate per-invocation budget. The [diagnostics configuration](../../../../packages/llm/llm-request-diagnostics/README.md) defines the directory, limits and incomplete-file handling.
2. Consumers requiring a larger Web preview can set `responseCaptureMaxBytes` on their DeepSeek provider configuration or under `llm-pi-ai.providers.<provider>`. Zero disables that preview. This setting does not disable independent disk diagnostics; [pi-ai](../../../../packages/llm/llm-pi-ai/README.md) and [DeepSeek](../../../../packages/llm/llm-deepseek/README.md) own their configuration details.
3. Check response metadata before treating a saved prefix as complete. In Web, review the truncation and incomplete-read notices separately. In diagnostic files, a missing body-end record after process termination is unfinished evidence, not a successful response or tool execution.
