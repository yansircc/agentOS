/**
 * Test worker entry.
 *
 * Test DOs are factory-configured. The Cloudflare backend no longer exposes a
 * subclass hook surface; tests exercise the same config path apps use.
 */

import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import {
  binding,
  credential,
  defineAgentDO,
  durableObjectTarget,
  endpoint,
  openAIChat,
  type AgentEventHandlerContext,
  type AgentFacadeRuntimeClient,
  type CloudflareAgentEnv,
  type DispatchTargetNamespace,
} from "../src";
import { CapabilityRejected } from "@agent-os/kernel/errors";
import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { eventNamespace, type ExtensionCapability } from "@agent-os/kernel/extensions";
import { makePreClaim, settleLivedClaim } from "@agent-os/kernel/effect-claim";
import { defineTool } from "@agent-os/kernel/tools";
import type { EventHandler } from "@agent-os/runtime";

export class TestAgentDO extends DurableObject {}

export const EmitTestDO = defineAgentDO<CloudflareAgentEnv>({
  eventHandlers: ({ runtime }) => [
    {
      kind: "interview.answer",
      handler: (event) =>
        runtime
          .emit("interview.followup", { sourceId: event.id, sourcePayload: event.payload })
          .then(() => undefined),
    },
  ],
});
export type EmitTestDO = InstanceType<typeof EmitTestDO>;

interface DispatchEnv extends CloudflareAgentEnv {
  readonly DISPATCH_DO: DurableObjectNamespace;
}

const DEAD_TARGET: DispatchTargetNamespace = {
  idFromName: (_name) => ({}) as DurableObjectId,
  get: (_id) => ({
    __agentosReceiveDispatch: () => Promise.reject("dead dispatch target"),
  }),
};

let dispatchTargetMaterializations = 0;

const dispatchTarget = (env: DispatchEnv): DispatchTargetNamespace => {
  dispatchTargetMaterializations += 1;
  return env.DISPATCH_DO;
};

export const DispatchTestDO = defineAgentDO<DispatchEnv>({
  bindings: [
    durableObjectTarget<DispatchEnv>("peer").from(dispatchTarget),
    durableObjectTarget<DispatchEnv>("dead").from(() => DEAD_TARGET),
    binding<DispatchEnv, DispatchTargetNamespace>("cloudflare", "durable_object", "generic").from(
      (env) => env.DISPATCH_DO,
    ),
  ],
  eventHandlers: ({ runtime }) => [
    {
      kind: "dispatch.inbound.accepted",
      handler: () => runtime.emit("test.inbound_accepted_handler_fired", {}).then(() => undefined),
    },
    {
      kind: "dispatch.outbound.requested",
      handler: () =>
        runtime.emit("test.outbound_requested_handler_fired", {}).then(() => undefined),
    },
    {
      kind: "test.delivered",
      handler: (event) =>
        runtime
          .emit("test.followup", { sourceId: event.id, sourcePayload: event.payload })
          .then(() => undefined),
    },
  ],
});
export type DispatchTestDO = InstanceType<typeof DispatchTestDO>;

export const StreamTestDO = defineAgentDO<CloudflareAgentEnv>({
  eventHandlers: () => [
    {
      kind: "stream.slow",
      handler: () => scheduler.wait(1_000),
    },
  ],
});
export type StreamTestDO = InstanceType<typeof StreamTestDO>;

const proofBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/proof",
  kindPrefixes: ["proof."],
  roles: ["generator", "reader"],
  vocabulary: {
    RECORDED: "proof.recorded",
  },
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    "proof.recorded": ["lived"],
  },
  proof: {
    anchorKinds: ["carrier_proof"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

const proofPreClaim = makePreClaim({
  operationRef: "proof:record",
  scopeRef: { kind: "conversation", scopeId: "extension-proof" },
  authorityRef: { authorityId: "proof.record", authorityClass: "effect" },
  originRef: { originId: "extension-test", originKind: "test" },
});

export const proofLivedClaim = settleLivedClaim(proofPreClaim, {
  anchorId: "proof:record",
  anchorKind: "carrier_proof",
  carrierRef: "proof",
});

export const EXTENSION_COMMAND_EVENT = "test.extension.command";
export const EXTENSION_RESULT_EVENT = "test.extension.result";

type ExtensionCommand =
  | { readonly op: "commitImageFact"; readonly data: unknown }
  | { readonly op: "commitWrongPrefix"; readonly data: unknown }
  | { readonly op: "commitMissingExtension"; readonly data: unknown }
  | { readonly op: "scheduleImageFact"; readonly at: number; readonly data: unknown }
  | { readonly op: "commitProofFact"; readonly data: unknown }
  | { readonly op: "commitProofOther"; readonly data: unknown }
  | { readonly op: "scheduleProofFact"; readonly at: number; readonly data: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ExtensionCommandParseResult =
  | { readonly ok: true; readonly command: ExtensionCommand }
  | { readonly ok: false; readonly error: Record<string, unknown> };

const malformedCommand = (message: string): ExtensionCommandParseResult => ({
  ok: false,
  error: { message },
});

const parseExtensionCommand = (value: unknown): ExtensionCommandParseResult => {
  if (!isRecord(value) || typeof value.op !== "string") {
    return malformedCommand("extension command malformed");
  }
  const data = value.data;
  switch (value.op) {
    case "commitImageFact":
    case "commitWrongPrefix":
    case "commitMissingExtension":
    case "commitProofFact":
    case "commitProofOther":
      return { ok: true, command: { op: value.op, data } };
    case "scheduleImageFact":
    case "scheduleProofFact":
      if (typeof value.at !== "number") return malformedCommand("extension command at malformed");
      return { ok: true, command: { op: value.op, at: value.at, data } };
    default:
      return malformedCommand(`extension command unsupported: ${value.op}`);
  }
};

const errorPayload = (cause: unknown): Record<string, unknown> => {
  if (isRecord(cause)) {
    return {
      ...(typeof cause._tag === "string" ? { _tag: cause._tag } : {}),
      ...(typeof cause.event === "string" ? { event: cause.event } : {}),
      ...(typeof cause.capability === "string" ? { capability: cause.capability } : {}),
      ...(typeof cause.issue === "string" ? { issue: cause.issue } : {}),
      ...(typeof cause.message === "string" ? { message: cause.message } : {}),
    };
  }
  if (cause instanceof Error) return { message: cause.message };
  return { message: String(cause) };
};

type CapabilityResult =
  | { readonly ok: true; readonly capability: ExtensionCapability }
  | { readonly ok: false; readonly error: CapabilityRejected };

const capabilityOrReject = (
  capabilities: ReadonlyMap<string, ExtensionCapability>,
  packageId: string,
): CapabilityResult => {
  const cap = capabilities.get(packageId);
  if (cap !== undefined) return { ok: true, capability: cap };
  return {
    ok: false,
    error: new CapabilityRejected({
      event: "*",
      capability:
        packageId === "@agent-os/image"
          ? `extension:${packageId}:boundary`
          : `extension:${packageId}`,
    }),
  };
};

const capabilityPromise = (
  capabilities: ReadonlyMap<string, ExtensionCapability>,
  packageId: string,
): Promise<ExtensionCapability> => {
  const result = capabilityOrReject(capabilities, packageId);
  return result.ok ? Promise.resolve(result.capability) : Promise.reject(result.error);
};

const runExtensionCommand = (
  capabilities: ReadonlyMap<string, ExtensionCapability>,
  command: ExtensionCommand,
) => {
  const image = () => capabilityPromise(capabilities, "@agent-os/image");
  const proof = () => capabilityPromise(capabilities, "@agent-os/proof");
  const missing = () => capabilityPromise(capabilities, "@agent-os/missing");
  return command.op === "commitImageFact"
    ? image().then((cap) => cap.commit({ event: "image.job.recorded", data: command.data }))
    : command.op === "commitWrongPrefix"
      ? image().then((cap) => cap.commit({ event: "git.commit.recorded", data: command.data }))
      : command.op === "commitMissingExtension"
        ? missing().then((cap) => cap.commit({ event: "missing.fact", data: command.data }))
        : command.op === "scheduleImageFact"
          ? image().then((cap) =>
              cap.time({
                at: command.at,
                event: "image.job.deferred",
                data: command.data,
              }),
            )
          : command.op === "commitProofFact"
            ? proof().then((cap) => cap.commit({ event: "proof.recorded", data: command.data }))
            : command.op === "commitProofOther"
              ? proof().then((cap) => cap.commit({ event: "proof.other", data: command.data }))
              : proof().then((cap) =>
                  cap.time({
                    at: command.at,
                    event: "proof.recorded",
                    data: command.data,
                  }),
                );
};

const extensionCommandHandlers = ({
  runtime,
  capabilities,
}: AgentEventHandlerContext<AgentFacadeRuntimeClient>) => [
  {
    kind: EXTENSION_COMMAND_EVENT,
    handler: async (event: Parameters<EventHandler>[0]) => {
      const parsed = parseExtensionCommand(event.payload);
      if (!parsed.ok) {
        await runtime.emit(EXTENSION_RESULT_EVENT, {
          op: "malformed",
          ok: false,
          error: parsed.error,
        });
        return;
      }
      const outcome = await runExtensionCommand(capabilities, parsed.command).then(
        (result) => ({ ok: true, result }) as const,
        (cause) => ({ ok: false, error: errorPayload(cause) }) as const,
      );
      await runtime.emit(EXTENSION_RESULT_EVENT, { op: parsed.command.op, ...outcome });
    },
  },
];

export const ExtensionTestDO = defineAgentDO<CloudflareAgentEnv>({
  extensions: () => [
    eventNamespace({
      packageId: "@agent-os/image",
      kindPrefixes: ["image."],
      version: "0.3.0",
    }),
    boundaryPackage(proofBoundaryContract, "0.1.0"),
  ],
  eventHandlers: extensionCommandHandlers,
});
export type ExtensionTestDO = InstanceType<typeof ExtensionTestDO>;

const facadeLookup = defineTool({
  name: "lookup",
  description: "Lookup a symbolic key",
  args: Schema.Struct({ key: Schema.String }),
  authority: "read",
  admit: "allow",
  execute: ({ key }) => ({ value: key }),
});

export const makeFacadeSubmitChatResponse = (): Response =>
  Response.json({
    choices: [{ message: { content: "facade done" } }],
    usage: { total_tokens: 7 },
  });

export const FacadeSubmitTestDO = defineAgentDO<CloudflareAgentEnv>({
  bindings: [
    endpoint<CloudflareAgentEnv>("llm").from(() => "https://stub.openai.test/v1"),
    credential<CloudflareAgentEnv>("llm-key").from(() => "stub-key"),
  ],
  llms: {
    default: openAIChat({
      model: "gpt-4.1-mini",
      endpoint: "llm",
      credential: "llm-key",
    }),
  },
  tools: [facadeLookup],
  scopeRefForScope: (scope) => ({ kind: "conversation", scopeId: scope }),
});
export type FacadeSubmitTestDO = InstanceType<typeof FacadeSubmitTestDO>;

interface WorkerEnv extends CloudflareAgentEnv {
  readonly STREAM_DO: DurableObjectNamespace<StreamTestDO>;
  readonly EXTENSION_DO: DurableObjectNamespace<ExtensionTestDO>;
  readonly FACADE_SUBMIT_DO: DurableObjectNamespace<FacadeSubmitTestDO>;
}

const parseLastEventId = (value: string | null): number => {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/dispatch-target-materializations") {
      return Response.json({ count: dispatchTargetMaterializations });
    }
    const match = url.pathname.match(/^\/stream\/([^/]+)$/);
    if (match !== null) {
      const scope = decodeURIComponent(match[1] ?? "");
      const stub = env.STREAM_DO.get(env.STREAM_DO.idFromName(scope));
      return stub.streamEvents({
        afterId: parseLastEventId(req.headers.get("Last-Event-ID")),
      });
    }
    return new Response("@agent-os/backend-cloudflare-do test worker (not for direct use)");
  },
};
