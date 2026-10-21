import {
  ComputerAction,
  OrchestratorMcpFailure,
  type ComputerDesktopRequest,
  type ComputerDesktopResponse,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { DesktopComputerClient, computerOwner } from "../../DesktopComputerClient.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

/** Run statuses during which the owning provider session is live. */
const ACTIVE_RUN_STATUSES: ReadonlyArray<OrchestrationV2ThreadShell["status"]> = [
  "preparing",
  "starting",
  "running",
  "waiting",
];

export function currentComputerInvocation(
  scope: McpInvocationScope,
  thread: OrchestrationV2ThreadShell | null | undefined,
  current: McpProviderSessionConfig | undefined,
) {
  const caller = computerCaller(scope);
  if (
    !caller ||
    !thread ||
    thread.archivedAt !== null ||
    !current ||
    current.environmentId !== scope.environmentId ||
    current.providerInstanceId !== caller.providerInstanceId ||
    current.providerSessionId !== caller.providerSessionId ||
    current.threadId !== caller.threadId ||
    thread.providerInstanceId !== caller.providerInstanceId ||
    !ACTIVE_RUN_STATUSES.includes(thread.status)
  )
    return undefined;
  return {
    owner: computerOwner(caller),
    threadTitle: thread.title.slice(0, 200),
    readOnly: thread.interactionMode === "plan" || thread.runtimeMode !== "full-access",
  };
}

/** Computer access belongs to T3-launched sessions; OAuth client callers have none. */
function computerCaller(scope: McpInvocationScope) {
  return scope.thread === undefined
    ? undefined
    : { environmentId: scope.environmentId, ...scope.thread };
}

const AccessInput = Schema.Struct({
  application: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
const SnapshotInput = Schema.Struct({ includeImage: Schema.optional(Schema.Boolean) });
const ActionInput = Schema.Struct({
  snapshotId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  action: ComputerAction,
});
const StopInput = Schema.Struct({
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
const decodeAccess = Schema.decodeUnknownSync(AccessInput);
const decodeSnapshot = Schema.decodeUnknownSync(SnapshotInput);
const decodeAction = Schema.decodeUnknownSync(ActionInput);
const decodeStop = Schema.decodeUnknownSync(StopInput);

const definitions = [
  {
    tool: Tool.make("computer_access_status", {
      description:
        "Check whether this session's local computer request is pending, granted or denied. Call after the user has answered the local approval dialog; never assume that request_access means approval.",
      success: Schema.Unknown,
      failure: OrchestratorMcpFailure,
      dependencies: [
        McpInvocationContext,
        ThreadManagement.ThreadManagementService,
        DesktopComputerClient,
        ProjectionStoreV2,
        McpProviderSessions,
      ],
      parameters: StopInput,
    }),
    command: (input: unknown): ComputerDesktopRequest["command"] => {
      decodeStop(input);
      return { kind: "status" };
    },
  },
  {
    tool: Tool.make("computer_request_access", {
      description:
        "Request local desktop approval for one running application by exact native name. Returns pending while the local dialog waits for the user. Tell the user to approve and wait for their reply; then use computer_access_status. Do not poll in a loop. Grants expire after 10 minutes. Input requires Full access and is never allowed in Plan mode. Bring the app to the foreground before taking a snapshot. Remote environments without their own T3 desktop are unavailable.",
      success: Schema.Unknown,
      failure: OrchestratorMcpFailure,
      dependencies: [
        McpInvocationContext,
        ThreadManagement.ThreadManagementService,
        DesktopComputerClient,
        ProjectionStoreV2,
        McpProviderSessions,
      ],
      parameters: AccessInput,
    }),
    command: (input: unknown): ComputerDesktopRequest["command"] => ({
      kind: "requestAccess",
      ...decodeAccess(input),
    }),
  },
  {
    tool: Tool.make("computer_snapshot", {
      description:
        "Read the approved foreground app's active window and image. Element indexes are valid only for this fresh snapshot and one action. Do not guess indexes or reuse a snapshot after an action or app switch.",
      success: Schema.Unknown,
      failure: OrchestratorMcpFailure,
      dependencies: [
        McpInvocationContext,
        ThreadManagement.ThreadManagementService,
        DesktopComputerClient,
        ProjectionStoreV2,
        McpProviderSessions,
      ],
      parameters: SnapshotInput,
    }),
    command: (input: unknown): ComputerDesktopRequest["command"] => {
      decodeSnapshot(input);
      return { kind: "inspect" };
    },
  },
  {
    tool: Tool.make("computer_action", {
      description:
        "Perform one semantic action on an element from computer_snapshot. press activates a control; fill replaces editable text; scrollIntoView reveals a control. Requires a local control grant and Full access outside Plan mode. Take another snapshot after each action. Never retry an uncertain action automatically.",
      success: Schema.Unknown,
      failure: OrchestratorMcpFailure,
      dependencies: [
        McpInvocationContext,
        ThreadManagement.ThreadManagementService,
        DesktopComputerClient,
        ProjectionStoreV2,
        McpProviderSessions,
      ],
      parameters: ActionInput,
    }),
    command: (input: unknown): ComputerDesktopRequest["command"] => ({
      kind: "act",
      ...decodeAction(input),
    }),
  },
  {
    tool: Tool.make("computer_stop", {
      description:
        "Revoke this provider session's local computer access, including a pending approval dialog. The user can also use File > Stop Computer Access in T3.",
      success: Schema.Unknown,
      failure: OrchestratorMcpFailure,
      dependencies: [
        McpInvocationContext,
        ThreadManagement.ThreadManagementService,
        DesktopComputerClient,
        ProjectionStoreV2,
        McpProviderSessions,
      ],
      parameters: StopInput,
    }),
    command: (input: unknown): ComputerDesktopRequest["command"] => {
      decodeStop(input);
      return { kind: "stop" };
    },
  },
] as const;

export const ComputerToolkit = Toolkit.make(...definitions.map(({ tool }) => tool));

export function computerToolResult(result: ComputerDesktopResponse["result"], includeImage = true) {
  if (result.kind !== "snapshot")
    return new McpSchema.CallToolResult({
      isError: result.kind === "unavailable",
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
  const { image, ...snapshot } = result.snapshot;
  return new McpSchema.CallToolResult({
    isError: false,
    content: [
      { type: "text", text: JSON.stringify({ kind: "snapshot", ...snapshot }) },
      ...(includeImage && image
        ? [
            {
              type: "image" as const,
              data: new Uint8Array(Buffer.from(image.data, "base64")),
              mimeType: image.mimeType,
            },
          ]
        : []),
    ],
  });
}

const handle = Effect.fn("tools.handle")(function* (
  definition: (typeof definitions)[number],
  payload: unknown,
) {
  return yield* Effect.gen(function* () {
    const scope = yield* McpInvocationContext;
    const desktop = yield* DesktopComputerClient;
    const projection = yield* ProjectionStoreV2;
    const mcpSessions = yield* McpProviderSessions;
    const command = definition.command(payload);
    const caller = computerCaller(scope);
    const fallback = {
      owner: caller === undefined ? "" : computerOwner(caller),
      threadTitle: "Computer access",
      readOnly: true,
    };
    // A caller without a T3-launched thread has no computer bridge.
    if (caller === undefined) return computerToolResult({ kind: "unavailable", reason: "denied" });
    if (command.kind === "stop")
      return computerToolResult(yield* desktop.invoke({ invocation: fallback, command }));
    if (!desktop.available)
      return computerToolResult({ kind: "unavailable", reason: "unsupported" });
    const thread = yield* projection
      .getThreadShell(caller.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const invocation = currentComputerInvocation(
      scope,
      thread,
      yield* mcpSessions.read(caller.threadId),
    );
    if (!invocation) {
      yield* desktop
        .invoke({ invocation: fallback, command: { kind: "stop" } })
        .pipe(Effect.ignore);
      return computerToolResult({ kind: "unavailable", reason: "denied" });
    }
    if (command.kind === "act" && invocation.readOnly) {
      yield* desktop.invoke({ invocation, command: { kind: "stop" } }).pipe(Effect.ignore);
      return computerToolResult({ kind: "unavailable", reason: "read-only" });
    }
    const result = yield* desktop.invoke({ invocation, command });
    return computerToolResult(
      result,
      definition.tool.name !== "computer_snapshot" ||
        decodeSnapshot(payload).includeImage !== false,
    );
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(computerToolResult({ kind: "unavailable", reason: "worker-failed" })),
    ),
  );
});

export const layer = McpToolAccess.toLayer(ComputerToolkit, {
  computer_access_status: McpToolAccess.readsAsCaller((input) => handle(definitions[0], input)),
  computer_request_access: McpToolAccess.actsAsCaller((input) => handle(definitions[1], input)),
  computer_snapshot: McpToolAccess.readsAsCaller((input) => handle(definitions[2], input)),
  computer_action: McpToolAccess.actsAsCaller((input) => handle(definitions[3], input)),
  computer_stop: McpToolAccess.readsAsCaller((input) => handle(definitions[4], input)),
});
