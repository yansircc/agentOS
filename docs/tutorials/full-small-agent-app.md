# Full Small Agent App

## Goal

Combine tools, material binding, durable facts, attached streams, ops, and
deployment into one small app shape.

## What You Build

A reference architecture for a weather chatbot that can answer synchronously,
stream long answers, cancel background work, expose ops views, and deploy as a
Cloudflare Worker.

## Prerequisites

- [Cloudflare DO minimal app](cloudflare-do-minimal-app.md)
- [Streaming chatbot](streaming-chatbot.md)
- [Ops view](ops-view.md)
- [Deploy minimal worker](deploy-minimal-worker.md)

## Steps

1. Keep the app graph small:

   ```text
   Worker fetch
     -> generated typed client
        -> authored agent tree
        -> manifest/backend mount
        -> tools: lookup_weather
        -> llms.default: bindingRef llm.default
        -> materials: symbolic endpoint/credential refs
        -> streams: tutorial.streaming_chatbot
        -> triggers: tutorial.cancelable
   ```

2. Keep each data kind on its own substrate:

   ```text
   ledger event       durable truth
   projection         derived read model
   attached frame     live transport
   material ref       symbolic provider handle
   ops response       read-only projection
   deploy ref         symbolic deploy proof
   ```

3. Wire HTTP routes:

   ```text
   POST /turn         -> generatedClient.submit
   GET  /events       -> generatedClient.streamEvents
   WS   /chat         -> generatedClient.attachStream(mode: bidi)
   GET  /__ops/api/*  -> mountOpsApi
   ```

4. Run local proof gates before any live provider smoke:

   ```sh
   bunx tsc -p tsconfig.json
   bun test
   bun build src/worker.ts --target=browser --outdir dist --external cloudflare:workers
   ```

5. Add one live smoke at a time. First prove provider material is set, then LLM,
   then deploy. Never print secret values.

## Checkpoint

The app has no source workspace dependency and no hidden state table:

```text
@yansirplus/core, @yansirplus/runtime, @yansirplus/client, and @yansirplus/cli imports are package entrypoints
provider material appears only as refs in ledger-visible payloads
stream frames are not ledger facts
ops views are read-only
deployment facts are symbolic
```

## Next

Review the whole ladder with [tutorial IA / consistency reviewer](tutorial-ia-consistency-reviewer.md).
