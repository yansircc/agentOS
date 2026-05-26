# Reactive Interview

This cookbook records the Insight Helper dogfood shape after the runnable
example was retired. It is pseudocode, not a maintained app.

## Invariant

The interview session ledger is the only session truth. HTTP writes facts into
the ledger with `emitEvent`; `on()` handlers derive context from prior ledger
rows and call `submit`; delivered turns are ledger facts again.

## Flow

```text
POST /start { sessionId, topic, businessContext? }
  -> InterviewDO(scope=sessionId).emitEvent("interview.start", data)
  -> on("interview.start")
  -> project prior turns from events()
  -> submit({ system, intent, context, tools, route, budget, deliver })
  -> tool.executed(name="interview", args={ questions })
  -> interview.turn.delivered

POST /answer { sessionId, answers }
  -> emitEvent("interview.answer", { answers })
  -> on("interview.answer")
  -> project prior turns from events()
  -> submit(...) for the next question batch
  -> interview.turn.delivered

GET /events/:sessionId
  -> events()
```

## DO Sketch

```ts
class InterviewDO extends AgentDOBase<Env> {
  protected provideRefResolver() {
    return {
      endpoint: (ref: string) =>
        ref === "openrouter" ? "https://openrouter.ai/api/v1" : null,
      credential: (ref: string) =>
        ref === "OPENROUTER_KEY" ? this.env.OPENROUTER_KEY : null,
    };
  }

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.on("interview.start", (event) => this.ask(event));
    this.on("interview.answer", (event) => this.ask(event));
  }

  private async ask(event: LedgerEventRpc) {
    const priorTurns = projectPriorTurns(await this.events());
    await this.submit({
      system: SYSTEM_PROMPT,
      intent: "Continue the interview according to the protocol.",
      context: { event, priorTurns },
      route: {
        kind: "openai-chat-compatible",
        endpointRef: "openrouter",
        credentialRef: "OPENROUTER_KEY",
        modelId: "openai/gpt-4.1",
      },
      tools: { interview },
      budget: { tokens: 10_000, maxTurns: 4, toolRetries: 1 },
      deliver: { event: "interview.turn.delivered" },
    });
  }
}
```

## Validated Findings

| Finding | Substrate consequence |
|---|---|
| `emitEvent` + `on` + `submit` carries a multi-turn interview without substrate changes | The reactive triad is sufficient for app-side conversational state machines. |
| `SubmitSpec.system` is a distinct behavior-program axis | Do not duplicate system prompt into `intent`; `system`, `intent`, and `context` stay separate. |
| `openai-chat-compatible` route via explicit `RefResolver` works for BYOK routes | INV-8 means no ambient credentials; credentials are explicit route dependencies via `credentialRef`. |
| Full Chinese prompt succeeded on a stronger route after gpt-oss flake | Model choice is a route concern, not app control-flow logic. |

## Boundary

The frontend, auth, prompt text, and view projections remain app concerns.
The substrate owns only ledger write/read, reactive delivery, LLM dispatch, and
tool loop logging.
