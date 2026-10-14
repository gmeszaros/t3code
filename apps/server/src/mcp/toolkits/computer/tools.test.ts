import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { computerToolResult, currentComputerInvocation, registration } from "./tools.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { DesktopComputerClient } from "../../DesktopComputerClient.ts";

const threadCaller = {
  threadId: ThreadId.make("computer-test"),
  providerInstanceId: ProviderInstanceId.make("zcode"),
  providerSessionId: "provider-session",
};
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
  requestNamespace: "computer-tools-test",
  thread: threadCaller,
  client: undefined,
};
const current: McpProviderSessionConfig = {
  threadId: threadCaller.threadId,
  environmentId: scope.environmentId,
  providerInstanceId: threadCaller.providerInstanceId,
  providerSessionId: threadCaller.providerSessionId,
  endpoint: "http://unused.test/mcp",
  authorizationHeader: "test-only",
  browserToolsAvailable: true,
  capabilities: new Set(["preview"]),
};
const thread = {
  id: threadCaller.threadId,
  title: "Test",
  archivedAt: null,
  providerInstanceId: threadCaller.providerInstanceId,
  status: "running" as const,
  interactionMode: "default" as const,
  runtimeMode: "full-access" as const,
} as OrchestrationV2ThreadShell;

it("rejects stale sessions and archived threads without falling back to another owner", () => {
  assert.isDefined(currentComputerInvocation(scope, thread, current));
  assert.isUndefined(
    currentComputerInvocation(scope, thread, { ...current, providerSessionId: "rotated" }),
  );
  assert.isUndefined(
    currentComputerInvocation(
      scope,
      { ...thread, archivedAt: DateTime.makeUnsafe("2026-10-01") },
      current,
    ),
  );
  assert.isUndefined(currentComputerInvocation(scope, undefined, current));
});

it("Plan wins over Full access and approval-required cannot silently gain write access", () => {
  assert.isTrue(
    currentComputerInvocation(scope, { ...thread, interactionMode: "plan" }, current)?.readOnly,
  );
  assert.isTrue(
    currentComputerInvocation(scope, { ...thread, runtimeMode: "approval-required" }, current)
      ?.readOnly,
  );
  assert.isFalse(currentComputerInvocation(scope, thread, current)?.readOnly);
});

it("returns screenshot bytes as image content without copying base64 into model text", () => {
  const snapshot = {
    snapshotId: "snapshot",
    application: "Test",
    elements: [],
    truncated: false,
    image: { data: Buffer.from("image-marker").toString("base64"), mimeType: "image/png" as const },
  };
  const result = computerToolResult({ kind: "snapshot", snapshot });
  assert.equal(result.content.length, 2);
  const image = result.content[1];
  assert.equal(image?.type, "image");
  if (image?.type === "image") assert.equal(Buffer.from(image.data).toString(), "image-marker");
  assert.notInclude(JSON.stringify(result.content[0]), snapshot.image.data);
  assert.equal(computerToolResult({ kind: "snapshot", snapshot }, false).content.length, 1);
});

it.effect("MCP actions re-read mode and revoke instead of executing after switching to Plan", () =>
  Effect.gen(function* () {
    let mode: "default" | "plan" = "default";
    const commands: string[] = [];
    const sessionsLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(current);
        yield* Effect.addFinalizer(() => sessions.clear(threadCaller.threadId));
      }),
    ).pipe(Layer.provideMerge(McpProviderSessions.layer));
    const testLayer = registration.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(sessionsLayer),
      Layer.provide(
        Layer.succeed(DesktopComputerClient, {
          available: true,
          invoke: (input) =>
            Effect.sync(() => {
              commands.push(input.command.kind);
              return { kind: "completed" as const };
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionStoreV2)({
          getThreadShell: () => Effect.sync(() => ({ ...thread, interactionMode: mode })),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const args = { snapshotId: "snapshot", action: { kind: "press", element: 0 } };
      yield* server.callTool({ name: "computer_action", arguments: args });
      mode = "plan";
      const denied = yield* server.callTool({ name: "computer_action", arguments: args });
      assert.isTrue(denied.isError);
      assert.deepEqual(commands, ["act", "stop"]);
    }).pipe(
      Effect.provide(testLayer),
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, {
        clientId: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
        getClient: Effect.die("unused"),
      }),
    );
  }).pipe(Effect.scoped),
);
