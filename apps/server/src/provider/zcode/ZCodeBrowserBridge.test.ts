import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PreviewAutomationError,
  type PreviewAutomationRequest,
  type PreviewAutomationOperation,
} from "@t3tools/contracts";
import {
  McpProviderSessions,
  layer as sessionsLayer,
} from "@t3tools/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { SessionControl } from "../../preview/SessionControl.ts";
import { makeClientFromHandle } from "./ZCodeAppServerClient.ts";
import type * as ZCodeError from "./ZCodeProtocolErrors.ts";
import * as ZCodeBrowserBridge from "./ZCodeBrowserBridge.ts";

type WireResult = Effect.Effect<Record<string, unknown>, ZCodeError.ZCodeAppServerError>;

// A real newline-delimited child transport, with no vendor runtime or LLM.
const fixture = `const pending=new Map();let sequence=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='terminateFixture') {process.exit(7);return;}
 if(message.method==='reverse') {
  const id='native-'+sequence++;pending.set(id,message.id);
  send({id,method:message.params.method,params:message.params.params});
 } else if(pending.has(message.id)) {
  send({id:pending.get(message.id),result:message.result??{wireError:message.error}});
  pending.delete(message.id);
 }
});`;

const threadId = ThreadId.make("browser-contract-thread");
const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("browser-contract-environment"),
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("zcode-test"),
    providerSessionId: "t3-session",
  },
  requestNamespace: "browser-contract",
  issuedAt: 1,
  client: undefined,
  capabilities: new Set(["preview"]),
};
const context = {
  sessionId: "native-session",
  workspacePath: "/fixture/workspace",
  workspaceKey: "/fixture/workspace",
  clientMode: "desktop-continuous",
  sessionContext: "live",
  turnId: "turn-a",
};
const thread = {
  id: threadId,
  deletedAt: null,
  archivedAt: null,
  activeRunId: "run-1",
  providerInstanceId: scope.thread.providerInstanceId,
  runtimeMode: "full-access",
  interactionMode: "default",
} as OrchestrationV2ThreadShell;

const withBridge = <A, E, R>(
  run: (harness: {
    list: (extra?: Record<string, unknown>) => WireResult;
    execute: (command: Record<string, unknown>, extra?: Record<string, unknown>) => WireResult;
    raw: (method: string, params: unknown) => WireResult;
    sessions: McpProviderSessions["Service"];
    requests: PreviewAutomationRequest[];
    pending: Map<string, PreviewAutomationRequest>;
    entered: Deferred.Deferred<PreviewAutomationRequest>;
    state: {
      revoked: boolean;
      nativeSessionId: string;
      shell: OrchestrationV2ThreadShell;
      capabilities: ReadonlySet<"preview">;
      history: { canGoBack: boolean; canGoForward: boolean } | undefined;
    };
    control: SessionControl;
    revoke: Effect.Effect<void>;
    terminate: Effect.Effect<void>;
    killChild: Effect.Effect<void>;
    cleanupCompleted: Effect.Effect<void>;
    reply: (
      request: PreviewAutomationRequest,
      result: unknown,
    ) => Effect.Effect<void, PreviewAutomationError>;
  }) => Effect.Effect<A, E, R>,
  supportedOperations: ReadonlyArray<PreviewAutomationOperation> = PREVIEW_AUTOMATION_SERVER_OPERATIONS,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-browser-contract-" });
    const script = `${directory}/fixture.cjs`;
    yield* fs.writeFileString(script, fixture);
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const entered = yield* Deferred.make<PreviewAutomationRequest>();
    const pending = new Map<string, PreviewAutomationRequest>();
    const requests: PreviewAutomationRequest[] = [];
    const revoked = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    const state = {
      revoked: false,
      nativeSessionId: "native-session",
      shell: thread,
      capabilities: scope.capabilities as ReadonlySet<"preview">,
      history: { canGoBack: true, canGoForward: false } as
        | { canGoBack: boolean; canGoForward: boolean }
        | undefined,
    };
    const control = new SessionControl(
      `${scope.environmentId}\u0000${scope.thread.providerSessionId}\u0000${scope.thread.threadId}`,
    );
    const credential = {
      ...scope.thread,
      environmentId: scope.environmentId,
      endpoint: "http://fixture.invalid/mcp",
      authorizationHeader: "Bearer synthetic-browser-token",
      browserToolsAvailable: true,
    };
    const sessions = yield* McpProviderSessions;
    yield* sessions.set(credential);
    let connectionId = "";
    const reply = (request: PreviewAutomationRequest, result: unknown) =>
      broker.respond({
        clientId: "fixture-host",
        connectionId,
        requestId: request.requestId,
        ok: true,
        result,
      });
    const hosts = yield* broker.connect({
      clientId: "fixture-host",
      environmentId: scope.environmentId,
      supportedOperations: [...supportedOperations],
    });
    const connected = yield* Deferred.make<void>();
    yield* hosts.pipe(
      Stream.runForEach((event) => {
        if (event.type === "connected") {
          connectionId = event.connectionId;
          return Deferred.succeed(connected, undefined);
        }
        const request = event.request;
        requests.push(request);
        if (request.operation === "releaseAgent")
          return reply(request, {}).pipe(Effect.andThen(Deferred.succeed(cleanup, undefined)));
        if (
          request.operation === "evaluate" &&
          (request.input as { expression: string }).expression === "hold"
        ) {
          pending.set(request.requestId, request);
          return Deferred.succeed(entered, request);
        }
        return Effect.matchEffect(
          Effect.tryPromise({
            try: () =>
              control.agent(request.agentSessionId!, async () =>
                request.operation === "listTabs"
                  ? [
                      {
                        tabId: "fixture-tab",
                        url: "about:blank",
                        title: "",
                        viewport: { width: 800, height: 600 },
                      },
                    ]
                  : request.operation === "open" || request.operation === "status"
                    ? {
                        available: true,
                        visible: true,
                        loading: false,
                        tabId: "fixture-tab",
                        url: null,
                        title: null,
                        viewport: { width: 800, height: 600 },
                        dialog: null,
                        navigationHistory: state.history,
                      }
                    : request.operation === "evaluate"
                      ? { marker: "native-value" }
                      : request.operation === "snapshot"
                        ? {
                            url: "about:blank",
                            title: "",
                            loading: false,
                            visibleText: "",
                            interactiveElements: [],
                            accessibilityTree: '- button "Continue" [ref=t3-1-e1]',
                            consoleEntries: [],
                            networkEntries: [],
                            actionTimeline: [],
                            screenshot: {
                              mimeType: "image/png",
                              data: "fixture-png",
                              width: 800,
                              height: 600,
                            },
                          }
                        : undefined,
              ),
            catch: () => "humanControl" as const,
          }),
          {
            onFailure: () =>
              broker.respond({
                clientId: "fixture-host",
                connectionId,
                requestId: request.requestId,
                ok: false,
                error: {
                  _tag: "PreviewAutomationControlInterruptedError",
                  message: "Human owns the tab",
                  detail: "humanControl",
                },
              }),
            onSuccess: (result) => reply(request, result),
          },
        );
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(connected);
    const bridge = yield* ZCodeBrowserBridge.ZCodeBrowserBridge.pipe(
      Effect.provide(
        ZCodeBrowserBridge.layer.pipe(
          Layer.provide(
            Layer.succeed(McpSessionRegistry, {
              awaitRevocation: () => Deferred.await(revoked),
              resolve: () =>
                Effect.sync(() =>
                  state.revoked ? undefined : { ...scope, capabilities: state.capabilities },
                ),
            } as unknown as McpSessionRegistry["Service"]),
          ),
          Layer.provide(
            Layer.succeed(ProjectionStoreV2, {
              getThreadShell: () => Effect.sync(() => state.shell),
            } as unknown as ProjectionStoreV2["Service"]),
          ),
        ),
      ),
    );
    const options = yield* bridge.bind({
      threadId,
      workspacePath: context.workspacePath,
      nativeSessionId: Effect.sync(() => state.nativeSessionId),
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [script]));
    const client = yield* makeClientFromHandle(handle, options);
    const raw = (method: string, params: unknown) =>
      client.request("reverse", { method, params }) as WireResult;
    const list = (extra = {}) =>
      raw("interaction/browserList", { ...context, requestId: "list-request", ...extra });
    const [host] = (yield* list()).browsers as { id: string; generation: number }[];
    expect(host).toBeDefined();
    let sequence = 0;
    const execute = (command: Record<string, unknown>, extra = {}) =>
      raw("interaction/browserExecute", {
        ...context,
        requestId: `execute-${sequence++}`,
        browserId: host!.id,
        browserGeneration: host!.generation,
        command,
        ...extra,
      });
    return yield* run({
      list,
      execute,
      raw,
      sessions,
      requests,
      pending,
      entered,
      state,
      control,
      reply,
      revoke: Effect.sync(() => {
        state.revoked = true;
      }).pipe(Effect.andThen(Deferred.succeed(revoked, undefined)), Effect.asVoid),
      terminate: options.onBrowserTermination!(),
      killChild: client.request("terminateFixture").pipe(Effect.ignore),
      cleanupCompleted: Deferred.await(cleanup),
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        sessionsLayer,
        PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

it.live("disables native APIs absent from the connected host", () =>
  withBridge(
    ({ list }) =>
      Effect.gen(function* () {
        expect(yield* list()).toMatchObject({
          browsers: [
            {
              apiSupportOverrides: {
                "Tab.title": true,
                "Tab.goto": false,
                "Tab.setViewportSize": false,
                "PlaywrightAPI.domSnapshot": false,
                "PlaywrightAPI.evaluate": false,
                "PlaywrightLocator.click": false,
              },
            },
          ],
        });
      }),
    ["status", "releaseAgent"],
  ),
);

it.live("carries native browser results over stdio and refuses unsupported translations", () =>
  withBridge(({ list, execute, raw, requests }) =>
    Effect.gen(function* () {
      expect(yield* list()).toMatchObject({
        browsers: [
          {
            capabilities: { browser: [], tab: [] },
            apiSupportOverrides: {
              "Tab.setViewportSize": true,
              "PlaywrightAPI.domSnapshot": true,
              "PlaywrightLocator.click": true,
              "Tab.back": false,
              "BrowserUser.openTabs": false,
              "PlaywrightLocator.waitFor": false,
              "Tab.dom_cua": false,
            },
          },
        ],
      });
      expect(
        yield* execute({ method: "browserViewportSet", width: 1280, height: 720 }),
      ).toMatchObject({ ok: true });
      expect(requests.at(-1)?.input).toEqual({ mode: "freeform", width: 1280, height: 720 });
      expect(yield* execute({ method: "newTab" })).toMatchObject({
        ok: true,
        tab: { tabId: "fixture-tab", viewport: { width: 800, height: 600 } },
      });
      expect(
        yield* execute({ method: "evaluate", expression: "1", tabId: "fixture-tab" }),
      ).toMatchObject({ ok: true, value: { marker: "native-value" } });
      expect(yield* execute({ method: "click", x: 1, y: 2, doubleClick: true })).toMatchObject({
        ok: true,
      });
      expect(requests.at(-1)?.input).toEqual({ x: 1, y: 2, clickCount: 2 });
      expect(yield* execute({ method: "scroll", x: 10, y: -20 })).toMatchObject({ ok: true });
      expect(requests.at(-1)?.input).toEqual({ deltaX: 10, deltaY: -20 });
      expect(yield* execute({ method: "screenshot" })).toMatchObject({
        ok: true,
        image: { base64: "fixture-png", mimeType: "image/png" },
      });
      for (const command of [
        { method: "playwright", action: { name: "domSnapshot", unexpected: true } },
        { method: "browserViewportSet", width: 1280, height: 720, deviceScaleFactor: 2 },
        { method: "browserViewportSet", width: 250, height: 720 },
        { method: "browserViewportSet", width: 1280, height: 3000 },
        { method: "click", ref: "native-ref" },
        { method: "snapshot" },
        { method: "screenshot", fullPage: true },
        { method: "screenshot", ref: "native-ref" },
        { method: "scroll", ref: "native-ref" },
        { method: "scroll", x: "10" },
        { method: "scroll", x: null },
        { method: "evaluate", expression: "1", unexpected: true },
      ]) {
        expect(yield* execute(command)).toMatchObject({
          ok: false,
          error: { code: "capability_unsupported", sideEffect: "none" },
        });
      }
      expect(
        yield* raw("interaction/browserExecute", {
          ...context,
          requestId: "invalid",
          command: { method: 1 },
        }),
      ).toHaveProperty("wireError");
      expect(
        yield* execute({ method: "playwright", action: { name: "domSnapshot" } }),
      ).toMatchObject({ ok: true, value: '- button "Continue"' });
      expect(
        yield* execute({
          method: "playwright",
          action: { name: "locator", selector: 'role=button[name="Continue"]', operation: "click" },
        }),
      ).toMatchObject({ ok: true });
      expect(requests.at(-1)?.input).toEqual({
        locator: 'role=button[name="Continue"]',
        clickCount: 1,
      });
      expect(
        yield* execute({
          method: "playwright",
          action: { name: "locator", selector: "textarea", operation: "fill", value: "hello" },
        }),
      ).toMatchObject({ ok: true });
      expect(requests.at(-1)?.input).toEqual({ locator: "textarea", text: "hello", clear: true });
      expect(
        yield* execute({
          method: "playwright",
          action: { name: "evaluate", expressionKind: "string", expression: "document.title" },
        }),
      ).toMatchObject({ ok: true, value: { marker: "native-value" } });
      expect(requests.at(-1)?.input).toEqual({ expression: "document.title" });
      for (const action of [
        { name: "evaluate", expressionKind: "function", expression: "() => document.title" },
        { name: "evaluate", expressionKind: "string", expression: "document.title", arg: null },
        { name: "evaluate", expressionKind: "string", expression: "document.title", timeoutMs: 10 },
      ]) {
        expect(yield* execute({ method: "playwright", action })).toMatchObject({
          ok: false,
          error: { code: "capability_unsupported", sideEffect: "none" },
        });
      }
      expect(requests.filter((request) => request.operation !== "releaseAgent")).toHaveLength(10);
    }),
  ),
);

it.live("returns native page state only with authoritative navigation history", () =>
  withBridge(({ execute, state }) =>
    Effect.gen(function* () {
      state.shell = { ...thread, interactionMode: "plan" };
      expect(yield* execute({ method: "getState" })).toMatchObject({
        ok: true,
        state: {
          url: "about:blank",
          title: "",
          canGoBack: true,
          canGoForward: false,
          viewportWidth: 800,
          viewportHeight: 600,
        },
      });
      expect(yield* execute({ method: "getState", unexpected: true })).toMatchObject({ ok: false });
      state.history = undefined;
      expect(yield* execute({ method: "getState" })).toMatchObject({
        ok: false,
        error: { code: "capability_unsupported", sideEffect: "none" },
      });
    }),
  ),
);

it.live("rechecks credential, workspace, session, mode, generation and human ownership", () =>
  withBridge(({ execute, list, state, control, requests }) =>
    Effect.gen(function* () {
      const command = { method: "evaluate", expression: "1" };
      for (const extra of [
        { sessionId: "foreign" },
        { workspaceKey: "foreign" },
        { workspacePath: "/foreign" },
        { workspaceIdentity: "foreign" },
        { remoteSessionId: "foreign" },
        { browserGeneration: 999 },
        { browserId: "foreign" },
        { sessionContext: "cached" },
      ]) {
        expect(yield* execute(command, extra)).toMatchObject({
          ok: false,
          error: { code: "backend_unavailable", sideEffect: "none" },
        });
      }
      state.shell = { ...thread, interactionMode: "plan" };
      expect(yield* execute(command)).toMatchObject({ ok: false });
      expect(
        yield* execute({
          method: "playwright",
          action: { name: "evaluate", expressionKind: "string", expression: "document.title" },
        }),
      ).toMatchObject({ ok: false });
      expect(yield* execute({ method: "getDialog" })).toMatchObject({ ok: true, dialog: null });
      expect(yield* execute({ method: "closeSession", closeTabs: true })).toMatchObject({
        ok: false,
      });
      state.shell = { ...thread, runtimeMode: "approval-required" };
      expect(yield* execute(command)).toMatchObject({ ok: false });
      state.shell = { ...thread, activeRunId: null };
      expect(yield* list()).toEqual({ browsers: [] });
      state.shell = { ...thread, providerInstanceId: ProviderInstanceId.make("foreign") };
      expect(yield* execute(command)).toMatchObject({ ok: false });
      state.shell = thread;
      state.capabilities = new Set();
      expect(yield* list()).toEqual({ browsers: [] });
      expect(yield* execute(command)).toMatchObject({ ok: false });
      state.capabilities = new Set(["preview"]);
      yield* Effect.promise(() => control.take("human"));
      expect(yield* execute(command)).toMatchObject({
        ok: false,
        error: { sideEffect: "uncertain" },
      });
      yield* Effect.promise(() => control.release("human"));
      state.revoked = true;
      expect(yield* execute(command)).toMatchObject({ ok: false, error: { sideEffect: "none" } });
      state.revoked = false;
      state.nativeSessionId = "replaced-native-session";
      expect(yield* execute(command)).toMatchObject({ ok: false });
      expect(requests.filter((request) => request.operation === "evaluate")).toHaveLength(1);
    }),
  ),
);

it.live("cancels exact pending native requests and keeps dispatched outcomes uncertain", () =>
  withBridge(({ execute, entered, reply, requests }) =>
    Effect.gen(function* () {
      const held = yield* execute(
        { method: "evaluate", expression: "hold" },
        { requestId: "native-held" },
      ).pipe(Effect.forkScoped);
      const request = yield* Deferred.await(entered);
      expect(
        yield* execute({ method: "evaluate", expression: "1" }, { requestId: "native-held" }),
      ).toMatchObject({ error: { code: "duplicate_request_id" } });
      expect(yield* execute({ method: "cancelRequest", requestId: "native-held" })).toMatchObject({
        ok: true,
      });
      expect(yield* Fiber.join(held)).toMatchObject({
        ok: false,
        error: { code: "cancelled", sideEffect: "uncertain" },
      });
      expect(requests.at(-1)?.input).toMatchObject({
        requestIds: [request.requestId],
        closeSession: false,
      });
      yield* reply(request, "late success");
      expect(
        yield* execute({ method: "evaluate", expression: "1" }, { requestId: "native-held" }),
      ).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(yield* execute({ method: "turnEnded", turnId: "turn-a" })).toMatchObject({ ok: true });
      expect(yield* execute({ method: "evaluate", expression: "1" })).toMatchObject({ ok: false });
      expect(
        yield* execute({ method: "evaluate", expression: "1" }, { turnId: "turn-b" }),
      ).toMatchObject({ ok: true });
      expect(yield* execute({ method: "closeSession" }, { turnId: "turn-b" })).toMatchObject({
        ok: true,
      });
      expect(
        yield* execute({ method: "evaluate", expression: "1" }, { turnId: "turn-b" }),
      ).toMatchObject({ ok: false });
    }),
  ),
);

it.live(
  "translates every supported command and rejects native-only arguments before dispatch",
  () =>
    withBridge(({ execute, requests }) =>
      Effect.gen(function* () {
        expect(yield* execute({ method: "newTab" })).toMatchObject({
          ok: true,
          tab: { url: "about:blank", title: "" },
        });
        expect(yield* execute({ method: "list" })).toMatchObject({
          ok: true,
          tabs: [{ tabId: "fixture-tab" }],
        });
        expect(yield* execute({ method: "activateTab", tabId: "fixture-tab" })).toMatchObject({
          ok: true,
          tab: { tabId: "fixture-tab" },
        });
        for (const command of [
          { method: "navigate", url: "https://example.test" },
          { method: "hover", x: 12, y: 24 },
          { method: "type", text: "fixture input" },
          { method: "press", key: "Enter" },
          { method: "handleDialog", accept: true, promptText: "answer" },
          { method: "getDialog" },
          { method: "close" },
        ])
          expect(yield* execute(command)).toMatchObject({ ok: true });
        const dispatched = requests.length;
        for (const command of [
          { method: "click", x: 1, y: 2, modifiers: ["Shift"] },
          { method: "hover", ref: "native-ref" },
          { method: "type", text: "x", ref: "native-ref" },
          { method: "press", key: "Enter", modifiers: ["Shift"] },
          { method: "cancelRequest", requestId: "target", extra: true },
          { method: "turnEnded", turnId: "wrong-turn" },
          { method: "closeSession", closeTabs: "true" },
        ])
          expect(yield* execute(command)).toMatchObject({
            ok: false,
            error: { code: "capability_unsupported" },
          });
        expect(requests).toHaveLength(dispatched);
      }),
    ),
);

it.live("deduplicates native lifecycle effects across new callback request IDs", () =>
  withBridge(({ execute, requests }) =>
    Effect.gen(function* () {
      for (const command of [
        { method: "cancelRequest", requestId: "target" },
        { method: "turnEnded", turnId: "turn-a" },
        { method: "closeSession" },
      ]) {
        expect(yield* execute(command)).toMatchObject({ ok: true });
        expect(yield* execute(command)).toMatchObject({ ok: true });
      }
      expect(requests.filter((request) => request.operation === "releaseAgent")).toHaveLength(3);
    }),
  ),
);

it.live("refuses replaced provider credentials and foreign thread tokens", () =>
  withBridge(({ sessions, list, execute }) =>
    Effect.gen(function* () {
      const current = (yield* sessions.read(threadId))!;
      yield* sessions.set({
        ...current,
        authorizationHeader: "Bearer synthetic-replacement-token",
      });
      expect(yield* list()).toEqual({ browsers: [] });
      expect(yield* execute({ method: "newTab" })).toMatchObject({
        ok: false,
        error: { sideEffect: "none" },
      });
    }),
  ),
);

it.live("revocation settles an in-flight callback and releases its session exactly once", () =>
  withBridge(({ execute, entered, revoke, terminate, requests }) =>
    Effect.gen(function* () {
      const running = yield* execute({ method: "evaluate", expression: "hold" }).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* revoke;
      expect(yield* Fiber.join(running)).toMatchObject({
        ok: false,
        error: { code: "cancelled", sideEffect: "uncertain" },
      });
      yield* terminate;
      expect(yield* execute({ method: "newTab" })).toMatchObject({ ok: false });
      expect(requests.filter((request) => request.operation === "releaseAgent")).toHaveLength(1);
    }),
  ),
);

it.live("process termination cancels pending callbacks and invalidates browser handles", () =>
  withBridge(({ execute, entered, terminate }) =>
    Effect.gen(function* () {
      const running = yield* execute({ method: "evaluate", expression: "hold" }).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* terminate;
      expect(yield* Fiber.join(running)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(yield* execute({ method: "newTab" })).toMatchObject({ ok: false });
    }),
  ),
);

it.live("child stdio termination releases an active native browser session", () =>
  withBridge(({ execute, entered, killChild, cleanupCompleted, requests }) =>
    Effect.gen(function* () {
      const pending = yield* execute({ method: "evaluate", expression: "hold" }).pipe(
        Effect.result,
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* killChild;
      yield* cleanupCompleted;
      expect(yield* Fiber.join(pending)).toMatchObject({
        failure: { _tag: "ZCodeAppServerProcessExitedError" },
      });
      expect(requests.filter((request) => request.operation === "releaseAgent")).toHaveLength(1);
    }),
  ),
);
