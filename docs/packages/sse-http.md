# @agent-os/sse-http

## Purpose

Web Fetch Server-Sent Events response construction for agentOS stream codecs.

## Invariant

Composers own frame algebra and pure frame-to-bytes codecs. This package owns SSE-over-HTTP `Response` and stream lifecycle construction, and backends select it when their host exposes Web Fetch APIs.

## Minimal Usage

Backends pass already-encoded stream chunks or composer frame sources to `createSseHttpResponse`, `createBatchedSubmitRunStreamResponse`, or `createAttachedStreamSseResponse`.

## Verification

Run the package and graph gates:

```sh
cd packages/transports/sse-http && bun run test
bun run typecheck
```
