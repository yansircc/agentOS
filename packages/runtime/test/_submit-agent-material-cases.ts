import {
  Effect,
  Schema,
  expect,
  it,
  compileBoundaryContract,
  defineBoundaryContract,
  defineTool,
  externalToolExecution,
  deterministicToolExecution,
  isMaterialBrokerPlaceholder,
  withToolWriteRequirement,
  projectInputRequest,
  submitResumeDecisionFromInputRequestProjection,
  receiptBackedToolResult,
  defineSettlementContract,
  credentialMaterialRef,
  materialRefKey,
  materialRequirement,
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  WORKSPACE_OP_OWNER_ID,
  scope,
  baseSpec,
  response,
  makeServices,
  runSubmit,
  runSubmitWithServices,
  decodedRuntimeBehaviorKinds,
  type SubmitSpec,
  type InternalSubmitSpec,
  type ResolvedMaterial,
} from "./_submit-agent-harness";

export const registerSubmitAgentMaterialCases = () => {
  it.effect("records only a symbolic version receipt while passing live material to a tool", () =>
    Effect.gen(function* () {
      const tokenRef = credentialMaterialRef("WP_TOKEN", {
        provider: "wordpress",
        purpose: "apply",
      });
      let observedToken: unknown;
      const materialLookups: string[] = [];
      const disposed: string[] = [];
      const tool = defineTool({
        name: "apply",
        description: "apply",
        args: Schema.Struct({ title: Schema.String }),
        execute: (_args, ctx) => {
          observedToken = ctx.materials.wp_token;
          return Effect.succeed({ applied: true });
        },
        authority: "write",
        requiredMaterials: [
          materialRequirement({
            slot: "wp_token",
            kind: "credential",
            provider: "wordpress",
            purpose: "apply",
          }),
        ],
        admit: () => {
          expect(materialLookups).toEqual([]);
          return Effect.succeed({ ok: true });
        },
        execution: deterministicToolExecution(),
      });

      const services = makeServices(
        [
          response({
            items: [
              { type: "message", text: "use apply" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "apply", arguments: '{"title":"Hello"}' },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
        { [materialRefKey(tokenRef)]: "secret-token-value" },
        {
          onMaterial: (ref) => materialLookups.push(materialRefKey(ref)),
          onDispose: (ref, material) =>
            disposed.push(
              `${materialRefKey(ref)}:${typeof material === "string" ? material : JSON.stringify(material)}`,
            ),
        },
      );

      const { result, events } = yield* runSubmitWithServices(
        baseSpec({
          tools: { apply: tool },
          materials: { wp_token: tokenRef },
        }),
        services,
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(observedToken).toBe("secret-token-value");
      expect(materialLookups).toEqual([materialRefKey(tokenRef)]);
      expect(disposed).toEqual([`${materialRefKey(tokenRef)}:secret-token-value`]);
      expect(JSON.stringify(events)).not.toContain("secret-token-value");
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "agent.material.resolved",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
      ]);
      expect(events.find((event) => event.kind === "agent.material.resolved")?.payload).toEqual({
        runId: 1,
        materialRef: materialRefKey(tokenRef),
        version: "fixture-v1",
      });
    }),
  );

  it.effect(
    "passes broker placeholders to receipt-backed external tools without resolving raw material",
    () =>
      Effect.gen(function* () {
        const tokenRef = credentialMaterialRef("WP_TOKEN", {
          provider: "wordpress",
          purpose: "apply",
        });
        const domain = { kind: "workspace" as const, ref: "workspace:default" };
        const materialLookups: string[] = [];
        let observedPlaceholder = false;
        let observedReceipts: unknown;
        const receiptClaim = {
          phase: "lived" as const,
          operationRef: "tool:submit-runtime-events:1:0:call-1",
          scopeRef: { kind: "conversation" as const, scopeId: scope },
          effectAuthorityRef: {
            authorityClass: "write",
            authorityId: "tool:apply",
          },
          originRef: { originId: "run:1", originKind: "submit" },
          anchorRef: {
            anchorId: "workspace_op:receipt:tool:submit-runtime-events:1:0:call-1:broker",
            anchorKind: "external_receipt" as const,
            carrierRef: "workspace_op:carrier:workspace-op",
          },
        };
        const tool = defineTool({
          name: "apply",
          description: "apply",
          args: Schema.Struct({ title: Schema.String }),
          execute: (_args, ctx) => {
            observedPlaceholder = isMaterialBrokerPlaceholder(ctx.materials.wp_token);
            observedReceipts = ctx.materialBrokerReceipts;
            return withToolWriteRequirement(
              Effect.succeed(
                receiptBackedToolResult({
                  result: { applied: true },
                  claim: receiptClaim,
                }),
              ),
            );
          },
          authority: "write",
          requiredMaterials: [
            materialRequirement({
              slot: "wp_token",
              kind: "credential",
              provider: "wordpress",
              purpose: "apply",
            }),
          ],
          admit: () => Effect.succeed({ ok: true }),
          execution: externalToolExecution("write", domain),
        });

        const { result, events } = yield* runSubmitWithServices(
          baseSpec({
            tools: { apply: tool },
            materials: { wp_token: tokenRef },
            executionDomains: [
              {
                domain,
                replay: { access: "write", witness: "receipt" },
                broker: {
                  mode: "trusted_substitution",
                  materialKinds: ["credential"],
                  outboundBoundary: "domain-owner-defined",
                },
              },
            ],
            toolIntents: [
              {
                kind: "workspace_op.requested",
                boundaryModule: compileBoundaryContract(
                  defineBoundaryContract({
                    ownerId: WORKSPACE_OP_OWNER_ID,
                    sourcePackageName: "../src/workspace-op-carrier",
                    kindPrefixes: ["workspace_op."],
                    roles: ["generator", "reader"],
                    events: {
                      "workspace_op.requested": {
                        payloadSchema: {
                          type: "object",
                          properties: { requestedBy: { type: "string" } },
                          required: ["requestedBy"],
                          additionalProperties: true,
                        },
                      },
                    },
                    effectAuthorityContracts: [],
                    materialRequirements: [],
                    settlement: defineSettlementContract({
                      settlementId: WORKSPACE_OP_OWNER_ID,
                      anchorKinds: ["external_receipt"],
                      rejectionKinds: ["provider_rejected"],
                      indeterminateKinds: [],
                    }),
                    projection: { derivedFromLedger: true, shadowState: false },
                  }),
                  "0.2.9",
                ),
              },
            ],
            receiptBackedTools: {
              apply: {
                kind: "intent_projection",
                intentKinds: ["workspace_op.requested"],
              },
            },
          }),
          makeServices(
            [
              response({
                items: [
                  { type: "message", text: "use apply" },
                  {
                    type: "tool_call",
                    call: {
                      id: "call-1",
                      type: "function",
                      function: { name: "apply", arguments: '{"title":"Hello"}' },
                    },
                  },
                ],
              }),
              response({ items: [{ type: "message", text: "done" }] }),
            ],
            { [materialRefKey(tokenRef)]: "secret-token-value" },
            { onMaterial: (ref) => materialLookups.push(materialRefKey(ref)) },
          ),
        );

        expect(result).toMatchObject({ ok: true, final: "done" });
        expect(observedPlaceholder).toBe(true);
        expect(observedReceipts).toMatchObject([{ slot: "wp_token", materialKind: "credential" }]);
        expect(materialLookups).toEqual([]);
        expect(JSON.stringify(events)).not.toContain("secret-token-value");
      }),
  );

  it.effect("rejects a missing required material before tool execution", () =>
    Effect.gen(function* () {
      let executed = false;
      const tool = defineTool({
        name: "apply",
        description: "apply",
        args: Schema.Struct({ title: Schema.String }),
        execute: () => {
          executed = true;
          return Effect.succeed({ applied: true });
        },
        authority: "write",
        requiredMaterials: [
          materialRequirement({
            slot: "wp_token",
            kind: "credential",
            provider: "wordpress",
            purpose: "apply",
          }),
        ],
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { apply: tool },
        }),
        [
          response({
            items: [
              { type: "message", text: "use apply" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "apply", arguments: '{"title":"Hello"}' },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(executed).toBe(false);
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(JSON.stringify(rejected?.payload)).toContain("material_missing:wp_token");
      expect(JSON.stringify(events)).not.toContain("secret-token-value");
    }),
  );

  it.effect("rejects non-symbolic material values before resolver lookup", () =>
    Effect.gen(function* () {
      let executed = false;
      const tool = defineTool({
        name: "apply",
        description: "apply",
        args: Schema.Struct({ title: Schema.String }),
        execute: () => {
          executed = true;
          return Effect.succeed({ applied: true });
        },
        authority: "write",
        requiredMaterials: [
          materialRequirement({
            slot: "wp_token",
            kind: "credential",
            provider: "wordpress",
            purpose: "apply",
          }),
        ],
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const resolvedProviderMaterial = {
        kind: "credential",
        ref: "WP_TOKEN",
        provider: "wordpress",
        purpose: "apply",
        value: "secret-token-value",
      };

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { apply: tool },
          materials: {
            wp_token: resolvedProviderMaterial,
          } as unknown as InternalSubmitSpec["materials"],
        }),
        [
          response({
            items: [
              { type: "message", text: "use apply" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "apply", arguments: '{"title":"Hello"}' },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(executed).toBe(false);
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(JSON.stringify(rejected?.payload)).toContain("material_invalid:wp_token");
      expect(JSON.stringify(events)).not.toContain("secret-token-value");
    }),
  );

  it.effect("ignores smuggled submit-scoped resolved material values and uses the resolver", () =>
    Effect.gen(function* () {
      let executed = false;
      const tool = defineTool({
        name: "apply",
        description: "Apply a post",
        args: Schema.Struct({ title: Schema.String }),
        execute: (_args, ctx) => {
          executed = ctx.materials.wp_token === "secret-token-value";
          return Effect.succeed({ applied: true });
        },
        authority: "write",
        requiredMaterials: [
          materialRequirement({
            slot: "wp_token",
            kind: "credential",
            provider: "wordpress",
            purpose: "apply",
          }),
        ],
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const tokenRef = credentialMaterialRef("run-wp-token", {
        provider: "wordpress",
        purpose: "apply",
      });
      const smuggledSubmitFields = {
        tools: { apply: tool },
        materials: { wp_token: tokenRef },
        budget: { maxTurns: 2 },
        resolvedMaterials: { wp_token: "attacker-material" },
      } as Partial<SubmitSpec> & {
        readonly resolvedMaterials: Readonly<Record<string, ResolvedMaterial>>;
      };

      const { result, events } = yield* runSubmitWithServices(
        baseSpec(smuggledSubmitFields),
        makeServices(
          [
            response({
              items: [
                { type: "message", text: "use apply" },
                {
                  type: "tool_call",
                  call: {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "apply",
                      arguments: '{"title":"Hello"}',
                    },
                  },
                },
              ],
            }),
            response({ items: [{ type: "message", text: "applied" }] }),
          ],
          { [materialRefKey(tokenRef)]: "secret-token-value" },
        ),
      );

      expect(result).toMatchObject({ ok: true, final: "applied" });
      expect(executed).toBe(true);
      expect(JSON.stringify(events)).not.toContain("secret-token-value");
    }),
  );

  it.effect("passes authorization input requests as symbolic material refs", () =>
    Effect.gen(function* () {
      let observedResume: unknown;
      const tool = defineTool({
        name: "connectGithub",
        description: "connect github",
        args: Schema.Struct({ installation: Schema.String }),
        execute: (_args, ctx) => {
          observedResume = ctx.resume;
          return Effect.succeed({
            kind: "authorization_received",
            resume: ctx.resume,
          });
        },
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            { type: "message", text: "need auth" },
            {
              type: "tool_call",
              call: {
                id: "call-auth",
                type: "function",
                function: {
                  name: "connectGithub",
                  arguments: '{"installation":"install-1"}',
                },
              },
            },
          ],
        }),
        response({ items: [{ type: "message", text: "authorized" }] }),
      ]);

      const first = yield* runSubmitWithServices(
        baseSpec({
          tools: { connectGithub: tool },
          decisionInterrupts: [{ toolName: "connectGithub", reason: "authorization_required" }],
        }),
        services,
      );
      if (first.result.status !== "interrupted") {
        expect.fail("expected interrupted result");
      }
      expect(first.result.inputRequest).toMatchObject({
        kind: "authorization",
        toolCallId: "call-auth",
        toolName: "connectGithub",
        ref: {
          kind: "agent.run.input_request",
          requestKind: "authorization",
        },
      });

      yield* services.boundaryEvents.commit(
        decisionGateBoundaryContract,
        DECISION_GATE_KIND.DECIDED,
        {
          gateRef: first.result.gateRef,
          decisionRef: "decision/auth",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      );

      if (first.result.inputRequest === undefined) {
        expect.fail("expected typed input request");
      }
      const authorization = {
        kind: "authorization" as const,
        authorization: {
          kind: "material_ref" as const,
          materialRef: { kind: "credential" as const, ref: "oauth/github/install-1" },
        },
      };
      const resume = submitResumeDecisionFromInputRequestProjection(
        projectInputRequest(services.events, first.result.inputRequest.ref),
        authorization,
      );
      if (!resume.ok) expect.fail(`expected approved input request: ${resume.reason}`);

      const resumed = yield* runSubmitWithServices(
        baseSpec({
          tools: { connectGithub: tool },
          resume: resume.resume,
        }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: true, final: "authorized" });
      expect(observedResume).toEqual(authorization);
      const executed = services.events.find((event) => event.kind === "tool.executed");
      expect(executed?.payload).toMatchObject({
        result: { kind: "authorization_received", resume: authorization },
      });
    }),
  );

  it.effect("replays the ledger-pinned material version after an interrupt", () =>
    Effect.gen(function* () {
      const tokenRef = credentialMaterialRef("provider-key");
      const tool = defineTool({
        name: "approve",
        description: "approval gate",
        args: Schema.Struct({}),
        execute: () => Effect.succeed({ approved: true }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const services = makeServices([
        response({
          items: [
            {
              type: "tool_call",
              call: {
                id: "call-approval",
                type: "function",
                function: { name: "approve", arguments: "{}" },
              },
            },
          ],
          testMaterialResolutions: [{ materialRef: tokenRef, version: "v1" }],
        }),
        response({ items: [{ type: "message", text: "resumed" }] }),
      ]);
      const first = yield* runSubmitWithServices(
        baseSpec({
          tools: { approve: tool },
          decisionInterrupts: [{ toolName: "approve", reason: "approval_required" }],
        }),
        services,
      );
      if (first.result.status !== "interrupted" || first.result.inputRequest === undefined) {
        expect.fail("expected interrupted input request");
      }
      yield* services.boundaryEvents.commit(
        decisionGateBoundaryContract,
        DECISION_GATE_KIND.DECIDED,
        {
          gateRef: first.result.gateRef,
          decisionRef: "decision/material-resume",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      );
      const resume = submitResumeDecisionFromInputRequestProjection(
        projectInputRequest(services.events, first.result.inputRequest.ref),
        { kind: "approval", approved: true },
      );
      if (!resume.ok) expect.fail(`expected resumable request: ${resume.reason}`);

      const resumed = yield* runSubmitWithServices(
        baseSpec({ tools: { approve: tool }, resume: resume.resume }),
        services,
      );

      expect(resumed.result).toMatchObject({ ok: true, final: "resumed" });
      expect(services.llmRequests[1]?.materialResolution?.expectedVersions).toEqual({
        [materialRefKey(tokenRef)]: "v1",
      });
      expect(
        services.events.filter((event) => event.kind === "agent.material.resolved"),
      ).toHaveLength(1);
    }),
  );
};
