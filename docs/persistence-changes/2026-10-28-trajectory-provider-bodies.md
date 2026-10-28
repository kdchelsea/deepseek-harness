---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-28-trajectory-provider-bodies

English | [中文](2026-10-28-trajectory-provider-bodies.zh.md)

## Summary

Records provider request and response attachments for the Trajectory inspector.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-trajectory-provider-bodies
baseline: false
changes:
  - root: "event:trajectory/request"
    previous: null
    after: "cb54846a57eace88b7a9d14b3a6eec16f4bcbf3ff3ecaeac4417126c1b08313a"
    decision: same-version
  - root: "event:trajectory/response"
    previous: null
    after: "73e821b64bb19088ea5edca918508606c8ed541d11a7b50b4387c7e3d6ee227d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds log-only trajectory/request and trajectory/response event types without changing existing payloads or model history. New readers continue to accept existing released sessions. Older readers reject these unknown required event types before reconstructing or mutating a session; they cannot silently omit model-visible data. Historical generations remain unchanged.

<a id="verification"></a>
## Verification

Focused Vitest runs passed the Trajectory capture and reader tests, response-capture tests, and both provider adapter suites against local HTTP fixtures.

<a id="dev-note"></a>
## Dev Note

None.
