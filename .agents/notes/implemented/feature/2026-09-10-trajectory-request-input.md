# Agent Note: Provider API requests in Trajectory

Status: implemented

English | [中文](2026-09-10-trajectory-request-input.zh.md)

## Problem

Session messages and request headers reconstruct provider-neutral input, but not the final API body after adapter defaults, extension fields, image uploads, and provider-specific conversion.

## Decision

Adapters publish serialized JSON through `llm/request-body` immediately before dispatch. The Trajectory Host plugin associates ordinary requests with the active assistant attempt and saves bodies as attachments and persists `trajectory/request` file references outside the model surface. The Input tab reads the latest body for the selected step through existing Session paging. HTTP headers are excluded. DeepSeek captures the serialized fetch body; pi-ai forwards its provider payload callback without replacing the payload.

## Alternatives considered

**Serialize historical messages again.** Current adapter configuration, extension state, and uploaded image identifiers may differ from the original request. The result would not establish what was dispatched.

**Keep bodies only in memory.** Reloading or reopening a Session would lose the requested inspection data.

## Consequences

Complete request bodies increase attachment storage, including any inline images and provider extensions. Logs retain file references so provider Session-log extensions cannot recursively nest earlier bodies. Old requests without capture and auxiliary requests remain unavailable. Each dispatch is retained, while the step inspector shows the latest body. The [reconstructable-request decision](../architecture/2026-07-05-reconstructable-requests.md) still governs model input; diagnostic bodies never enter derived messages. Capture is installed with the Web trajectory plugin and stops on plugin disposal. Both adapter tests compare captured JSON with a local HTTP server’s received body; the historical browser fixture verifies the unavailable state.

The request inspector also exposes the associated model result through the existing trajectory projection. Reusing recorded content blocks preserves reasoning, tool calls, and live updates without introducing a second response log; provider HTTP envelopes are not reconstructed. Results outside the loaded window remain explicitly unavailable.

Raw response inspection persists the received HTTP body as a separate `trajectory/response` attachment reference, including failed responses and interrupted prefixes. The adapter owns capture before parsing and awaits publication before ending the attempt, so cancellation does not discard already received text. The client displays every response in step order rather than presenting assembled content as original provider JSON. HTTP-only capture avoids global fetch interception and leaves unsupported transports unchanged.

Structured inspection parses a saved body only for display. The maintained SSE parser supplies complete events; comments and unfinished frames remain available in the exact text view. Collapsed event rows mount no JSON tree, so long token streams do not install hidden field-tree listeners. The attachment remains the authority for original provider text.
