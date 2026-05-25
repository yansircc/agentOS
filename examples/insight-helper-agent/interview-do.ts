/**
 * InterviewDO — Insight Helper backend, one DO instance per session.
 *
 * Scope = ctx.id.name = the sessionId addressed by the worker.
 *
 * Reactive flow (full triad: emitEvent → on → submit):
 *
 *   POST /start  → stub.emitEvent("interview.start", {topic, businessContext})
 *                  → on("interview.start") handler fires
 *                  → submit({intent, context, tools:{interview}, deliver: "interview.turn.delivered"})
 *                  → LLM calls interview tool with questions
 *                  → tool.executed event written (carries questions in payload.args)
 *                  → loop terminates; interview.turn.delivered fires
 *
 *   POST /answer → stub.emitEvent("interview.answer", {answers})
 *                  → on("interview.answer") handler reconstructs prior turns from
 *                    the ledger and calls submit again
 *                  → LLM EITHER calls interview tool again (next turn)
 *                    OR outputs final markdown "### Insight for Writer ..."
 *                    (in which case payload.final on the deliver event carries it)
 *
 * v0 dogfood findings (see ./README.md "Status & limitations"):
 *
 * 1. **Substrate carries the pattern.** Wire-level validation passed in
 *    iteration: emitEvent → on() → submit → tool dispatch → tool.executed
 *    ledger event → deliver. Multi-turn shape is correct.
 *
 * 2. **submit-agent.ts has no `system` field on SubmitSpec.** `intent` is
 *    used as BOTH the system message ("You are an agent. Goal: …") AND
 *    the user message. For directive intents this is harmless; for long
 *    behavior protocols (the original ~4000-char Chinese SYSTEM_PROMPT)
 *    the duplication adds noise. Not currently a substrate gap because
 *    workaround via directive `intent` works; would become a substrate
 *    gap if an app needs the full prompt fidelity AND can't afford
 *    duplication.
 *
 * 3. **Model capability is the real bottleneck for full fidelity.** The
 *    full Chinese SYSTEM_PROMPT (preserved in `./system-prompt.ts`) does
 *    not reliably produce tool calls on Workers AI `gpt-oss-120b`
 *    (reasons in reasoning_content, empty `choices[0].message.content`,
 *    zero `tool_calls`). A stronger model (claude / gpt-4 class via
 *    `@cf/anthropic` once shipped, or AI Gateway BYOK) is the production
 *    path. The current intent below is directive enough that
 *    gpt-oss-120b WILL emit tool calls when the topic is concrete; the
 *    output is a degraded-fidelity v0 dogfood, not the production shape.
 */

import {
  AgentDOBase,
  type AgentDOEnv,
  type LedgerEventRpc,
} from "@agent-os/core";

import { INTERVIEW_TOOL_NAME, interviewTool } from "./interview-tool";
import { makeSystemPrompt } from "./system-prompt";

interface StartPayload {
  readonly topic: string;
  readonly businessContext?: string;
}

interface AnswerPayload {
  readonly answers: Record<string, string | ReadonlyArray<string>>;
}

interface PriorTurn {
  readonly questions: unknown;
  readonly answers: AnswerPayload["answers"];
}

/** v0 dogfood model selection: gpt-oss-120b is the only Workers AI model
 *  validated to return OpenAI Chat Completions response shape AND support
 *  tool calling. llama-3.3 returns Workers AI native shape (`{response:
 *  ...}`) which our LlmResponseSchema currently rejects (a known substrate
 *  limitation; see notes/structured-output-exploration.md).
 *
 *  Empirical finding from this v0 dogfood: gpt-oss-120b is a reasoning
 *  model and produces empty `content` + zero `tool_calls` when the prompt
 *  is large or heavily Chinese — 256 completion tokens went to
 *  reasoning_content with nothing surfacing in `choices[0].message`. We
 *  trimmed SYSTEM_PROMPT to a short English+Chinese hybrid focused on the
 *  tool call to make the wire work. Full prompt fidelity (the original
 *  ~4000-char Chinese SYSTEM_PROMPT) is a model-capability concern, not a
 *  substrate concern — apps wanting full fidelity need a stronger model
 *  (claude / gpt-4 class via @cf/anthropic or AI Gateway). */
const MODEL = { provider: "@cf/openai", model: "gpt-oss-120b" } as const;

/** Per-turn budget. maxTurns=2 keeps the loop tight: turn 1 = LLM calls
 *  interview (or emits final markdown), turn 2 = LLM acknowledges the tool
 *  result with empty/short text → deliver fires. */
const BUDGET = { tokens: 16_000, maxTurns: 2, toolRetries: 0 } as const;

export class InterviewDO extends AgentDOBase<AgentDOEnv> {
  constructor(ctx: DurableObjectState, env: AgentDOEnv) {
    super(ctx, env);

    this.on("interview.start", async () => {
      await this.runOneTurn();
    });

    this.on("interview.answer", async () => {
      await this.runOneTurn();
    });
  }

  /** Read the ledger to reconstruct topic/businessContext/priorTurns,
   *  then call submit once. Same shape on both start and answer paths —
   *  the only difference is whether priorTurns is empty. */
  private async runOneTurn(): Promise<void> {
    const events = await this.events();
    const start = findStart(events);
    if (start === null) {
      return;
    }
    const priorTurns = buildPriorTurns(events);

    // The full interview protocol goes into `intent` (which submit-agent
    // puts BOTH into the system message and the user message). The model
    // needs to see this as authoritative instruction, not as a JSON field
    // buried in context. v0 dogfood note: first attempt embedded the
    // protocol in context.interviewProtocol and the LLM returned empty
    // text + no tool call — the prompt-as-data framing was hostile.
    // v0.2.11+: use SubmitSpec.system for the behavior program (the full
    // Chinese SYSTEM_PROMPT). intent stays short and per-turn directive.
    // context carries only the runtime facts.
    const intent =
      priorTurns.length === 0
        ? "Start the interview now. Call the `interview` tool with the first batch of 1-3 Chinese multi-choice questions following the protocol above."
        : "Continue the interview. Read context.priorTurns to see what the user answered. EITHER call the `interview` tool again with the next questions, OR if the protocol's stop condition is met, output the final brief starting with '### Insight for Writer'.";

    await this.submit({
      system: makeSystemPrompt(start.businessContext),
      intent,
      context: {
        topic: start.topic,
        priorTurns,
      },
      agent: MODEL,
      tools: { [INTERVIEW_TOOL_NAME]: interviewTool },
      budget: BUDGET,
      deliver: { event: "interview.turn.delivered" },
    });
  }
}

function findStart(events: ReadonlyArray<LedgerEventRpc>): StartPayload | null {
  for (const e of events) {
    if (e.kind === "interview.start") {
      const p = e.payload as Partial<StartPayload> | null;
      if (p !== null && typeof p === "object" && typeof p.topic === "string") {
        return {
          topic: p.topic,
          businessContext:
            typeof p.businessContext === "string" ? p.businessContext : undefined,
        };
      }
    }
  }
  return null;
}

/** Walk the ledger in order; pair each tool.executed(interview, args) with
 *  the next interview.answer event. Returns the resulting turn pairs.
 *
 *  Imperfect pairing model — assumes turns are sequential and that the user
 *  can't answer ahead of receiving questions. The same assumption the
 *  Next.js frontend currently relies on. */
function buildPriorTurns(
  events: ReadonlyArray<LedgerEventRpc>,
): ReadonlyArray<PriorTurn> {
  const turns: PriorTurn[] = [];
  let pendingQuestions: unknown = null;

  for (const e of events) {
    if (e.kind === "tool.executed") {
      const p = e.payload as { name?: unknown; args?: unknown };
      if (p.name === INTERVIEW_TOOL_NAME && typeof p.args === "string") {
        try {
          pendingQuestions = JSON.parse(p.args);
        } catch {
          pendingQuestions = p.args;
        }
      }
    } else if (e.kind === "interview.answer" && pendingQuestions !== null) {
      const ap = e.payload as Partial<AnswerPayload> | null;
      if (ap !== null && typeof ap === "object" && ap.answers !== undefined) {
        turns.push({ questions: pendingQuestions, answers: ap.answers });
      }
      pendingQuestions = null;
    }
  }

  return turns;
}
