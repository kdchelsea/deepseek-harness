---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-response-preview-truncation

English | [中文](2026-11-06-response-preview-truncation.zh.md)

## Summary

Adds an optional truncation marker to persisted trajectory response metadata.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-response-preview-truncation
baseline: false
changes:
  - root: "event:trajectory/response"
    previous: "2026-10-28-trajectory-provider-bodies"
    after: "e52de9dd97436f3de9ba0d43d2c86f7379644e3a88c5e40e0b672b1cb2b86f40"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing trajectory/response records remain valid because truncated is optional. New readers preserve absence and display a warning only when it is true. The complete field still denotes transport EOF, including when a retained preview is truncated. Older readers may ignore the new display annotation; trajectory response data does not enter model history or drive tool execution. No historical generation is rewritten and the Session writer version is unchanged.

<a id="verification"></a>
## Verification

Focused response capture, adapter/config and trajectory host/client suites passed 250 tests. Coverage includes byte limits, complete/truncated independence, old records without the field, optional-field transport validation, and separate UI notices. Source and built headless process checks passed 8 scenarios each, including SIGKILL prefix preservation.

<a id="dev-note"></a>
## Dev Note

None.
