import {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationResizeInput,
  PreviewAutomationPressInput,
  PreviewAutomationTypeInput,
  PreviewAutomationDialogInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewTabId,
  type PreviewAutomationOperation,
  PreviewAutomationStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Result from "effect/Result";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { assertLiveThread, assertPreviewAction } from "../../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { ZCodeAppServerClientOptions } from "./ZCodeAppServerClient.ts";
import * as Deferred from "effect/Deferred";
import * as Browser from "./ZCodeBrowserSchema.ts";

const decodeClick = Schema.decodeUnknownOption(PreviewAutomationClickInput);
const decodeTabId = Schema.decodeUnknownOption(PreviewTabId);
const decodeTabs = Schema.decodeUnknownOption(Schema.Array(Browser.BrowserTabSummary));
const decodeStatus = Schema.decodeUnknownOption(PreviewAutomationStatus);
const decodeSnapshot = Schema.decodeUnknownOption(PreviewAutomationSnapshot);
const decodeScroll = Schema.decodeUnknownOption(PreviewAutomationScrollInput);
const decodeEvaluate = Schema.decodeUnknownOption(PreviewAutomationEvaluateInput);
const decodeResize = Schema.decodeUnknownOption(PreviewAutomationResizeInput);
const encodeLifecycleKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const nativeApiOperations: Readonly<Record<string, PreviewAutomationOperation | false>> = {
  "BrowserUser.claimTab": false,
  "BrowserUser.history": false,
  "BrowserUser.openTabs": false,
  "Tabs.get": "listTabs",
  "Tabs.list": "listTabs",
  "Tabs.selected": "listTabs",
  "Tabs.new": "open",
  "Tabs.finalize": false,
  "Tab.back": false,
  "Tab.forward": false,
  "Tab.reload": false,
  "Tab.goto": "navigate",
  "Tab.close": "close",
  "Tab.getJsDialog": "status",
  "Tab.title": "status",
  "Tab.url": "status",
  "Tab.screenshot": "snapshot",
  "Tab.setViewportSize": "resize",
  "Tab.finalize": false,
  "Tab.markDeliverable": false,
  "Tab.markHandoff": false,
  "Tab.cua": false,
  "Tab.dom_cua": false,
  "Tab.recording": false,
  "PlaywrightAPI.domSnapshot": "snapshot",
  "PlaywrightAPI.evaluate": "evaluate",
  "PlaywrightAPI.elementInfo": false,
  "PlaywrightAPI.elementScreenshot": false,
  "PlaywrightAPI.expectNavigation": false,
  "PlaywrightAPI.waitForEvent": false,
  "PlaywrightAPI.waitForLoadState": false,
  "PlaywrightAPI.waitForTimeout": false,
  "PlaywrightAPI.waitForURL": false,
  "PlaywrightLocator.click": "click",
  "PlaywrightLocator.dblclick": "click",
  "PlaywrightLocator.fill": "type",
  "PlaywrightLocator.type": "type",
  "PlaywrightLocator.allTextContents": false,
  "PlaywrightLocator.check": false,
  "PlaywrightLocator.count": false,
  "PlaywrightLocator.downloadMedia": false,
  "PlaywrightLocator.evaluate": false,
  "PlaywrightLocator.getAttribute": false,
  "PlaywrightLocator.innerText": false,
  "PlaywrightLocator.isEnabled": false,
  "PlaywrightLocator.isVisible": false,
  "PlaywrightLocator.press": false,
  "PlaywrightLocator.selectOption": false,
  "PlaywrightLocator.setChecked": false,
  "PlaywrightLocator.textContent": false,
  "PlaywrightLocator.uncheck": false,
  "PlaywrightLocator.waitFor": false,
};

type Host = { readonly id: string; readonly generation: number };
interface Binding {
  readonly threadId: ThreadId;
  readonly workspacePath: string;
  readonly nativeSessionId: Effect.Effect<string | undefined>;
}

export class ZCodeBrowserBridge extends Context.Service<
  ZCodeBrowserBridge,
  {
    readonly bind: (
      binding: Binding,
    ) => Effect.Effect<
      Pick<
        ZCodeAppServerClientOptions,
        "onBrowserList" | "onBrowserExecute" | "onBrowserTermination"
      >,
      never,
      Scope.Scope
    >;
  }
>()("t3/provider/zcode/ZCodeBrowserBridge") {}

const unavailable = (
  code: NonNullable<Browser.BrowserExecuteResult["error"]>["code"],
  message: string,
  uncertain = false,
): Browser.BrowserExecuteResult => ({
  ok: false,
  elapsedMs: 0,
  error: { code, message, sideEffect: uncertain ? "uncertain" : "none" },
});

// Native ref strings are not T3 snapshot locators. Only variants with an exact
// supported preview input survive this translation; never feed an MCP envelope to ZCode.
const translate = (
  command: Readonly<Record<string, unknown>>,
): { operation: PreviewAutomationOperation; input: unknown; read: boolean } | undefined => {
  const { method, tabId: _tabId, ...input } = command;
  const decode = <A>(codec: Schema.Codec<A, unknown>, allowed: string[]) => {
    if (Object.keys(input).some((key) => !allowed.includes(key))) return undefined;
    const decoded = Schema.decodeUnknownOption(codec)(input, { onExcessProperty: "error" });
    return decoded._tag === "Some" ? decoded.value : undefined;
  };
  let operation: PreviewAutomationOperation;
  let translated: unknown;
  switch (method) {
    case "newTab":
      if (Object.keys(input).length > 0 || _tabId !== undefined) return undefined;
      return { operation: "open", input: { reuseExistingTab: false }, read: false };
    case "navigate":
      operation = "navigate";
      translated = decode(PreviewAutomationNavigateInput, ["url"]);
      break;
    case "browserViewportSet": {
      if (Object.keys(input).some((key) => !["width", "height"].includes(key))) return undefined;
      if (
        typeof input.width !== "number" ||
        input.width < 320 ||
        input.width > 3840 ||
        typeof input.height !== "number" ||
        input.height < 320 ||
        input.height > 2160
      )
        return undefined;
      const decoded = decodeResize({
        mode: "freeform",
        width: input.width,
        height: input.height,
      });
      return decoded._tag === "Some"
        ? { operation: "resize", input: decoded.value, read: false }
        : undefined;
    }
    case "evaluate":
      operation = "evaluate";
      translated = decode(PreviewAutomationEvaluateInput, ["expression"]);
      break;
    case "click": {
      if (input.doubleClick !== undefined && typeof input.doubleClick !== "boolean")
        return undefined;
      const { doubleClick, ...click } = input;
      if (Object.keys(click).some((key) => !["x", "y", "button"].includes(key))) return undefined;
      const decoded = decodeClick({
        ...click,
        ...(doubleClick === undefined ? {} : { clickCount: doubleClick ? 2 : 1 }),
      });
      return decoded._tag === "Some"
        ? { operation: "click", input: decoded.value, read: false }
        : undefined;
    }
    case "hover":
      operation = "hover";
      translated = decode(PreviewAutomationHoverInput, ["x", "y"]);
      break;
    case "type":
      operation = "type";
      translated = decode(PreviewAutomationTypeInput, ["text"]);
      break;
    case "press":
      operation = "press";
      translated = decode(PreviewAutomationPressInput, ["key"]);
      break;
    case "scroll": {
      if (Object.keys(input).some((key) => !["x", "y"].includes(key))) return undefined;
      const decoded = decodeScroll({
        deltaX: input.x === undefined ? 0 : input.x,
        deltaY: input.y === undefined ? 0 : input.y,
      });
      return decoded._tag === "Some"
        ? { operation: "scroll", input: decoded.value, read: false }
        : undefined;
    }
    case "screenshot":
      if (Object.keys(input).length > 0) return undefined;
      return { operation: "snapshot", input: {}, read: true };
    case "playwright": {
      if (
        Object.keys(input).some((key) => key !== "action") ||
        typeof input.action !== "object" ||
        input.action === null ||
        Array.isArray(input.action)
      )
        return undefined;
      const action = input.action as Record<string, unknown>;
      if (action.name === "domSnapshot" && Object.keys(action).length === 1)
        return { operation: "snapshot", input: {}, read: true };
      if (action.name === "evaluate") {
        if (
          action.expressionKind !== "string" ||
          Object.keys(action).some((key) => !["name", "expressionKind", "expression"].includes(key))
        )
          return undefined;
        const decoded = decodeEvaluate({
          expression: action.expression,
        });
        return decoded._tag === "Some"
          ? { operation: "evaluate", input: decoded.value, read: false }
          : undefined;
      }
      if (action.name !== "locator" || typeof action.selector !== "string") return undefined;
      const decodeAction = <A>(
        codec: Schema.Codec<A, unknown>,
        allowed: string[],
        value: unknown,
      ) =>
        Object.keys(action).some(
          (key) => !["name", "selector", "operation", ...allowed].includes(key),
        )
          ? undefined
          : Schema.decodeUnknownOption(codec)(value, { onExcessProperty: "error" });
      if (action.operation === "click" || action.operation === "dblclick") {
        const decoded = decodeAction(PreviewAutomationClickInput, ["button"], {
          locator: action.selector,
          ...(action.button === undefined ? {} : { button: action.button }),
          clickCount: action.operation === "dblclick" ? 2 : 1,
        });
        return decoded?._tag === "Some"
          ? { operation: "click", input: decoded.value, read: false }
          : undefined;
      }
      if (action.operation === "fill" || action.operation === "type") {
        if (
          typeof action.value !== "string" ||
          (action.replace !== undefined && typeof action.replace !== "boolean")
        )
          return undefined;
        const decoded = decodeAction(
          PreviewAutomationTypeInput,
          ["value", "replace", "timeoutMs"],
          {
            locator: action.selector,
            text: action.value,
            clear: action.operation === "fill" && action.replace !== false,
            ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
          },
        );
        return decoded?._tag === "Some"
          ? { operation: "type", input: decoded.value, read: false }
          : undefined;
      }
      return undefined;
    }
    case "handleDialog":
      operation = "dialog";
      translated = decode(PreviewAutomationDialogInput, ["accept", "promptText"]);
      break;
    case "list":
      if (Object.keys(input).length > 0 || _tabId !== undefined) return undefined;
      return { operation: "listTabs", input: {}, read: true };
    case "activateTab":
      if (Object.keys(input).length > 0 || typeof _tabId !== "string") return undefined;
      return { operation: "status", input: {}, read: true };
    case "getDialog":
    case "getState":
      if (Object.keys(input).length > 0) return undefined;
      return { operation: "status", input: {}, read: true };
    case "close":
      if (Object.keys(input).length > 0) return undefined;
      return { operation: "close", input: {}, read: false };
    default:
      return undefined;
  }
  return translated === undefined ? undefined : { operation, input: translated, read: false };
};

export const layer = Layer.effect(
  ZCodeBrowserBridge,
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const sessions = yield* McpProviderSessions;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return ZCodeBrowserBridge.of({
      bind: (binding) =>
        Effect.gen(function* () {
          const credential = yield* sessions.read(binding.threadId);
          let closed = false;
          let released = false;
          const discovered = new Map<string, Host>();
          const inFlight = new Set<string>();
          const canceled = new Set<string>();
          const endedTurns = new Set<string>();
          const lifecycleResults = new Map<
            string,
            Deferred.Deferred<Browser.BrowserExecuteResult>
          >();
          let cleanupScope: McpInvocationContext.McpThreadInvocationScope | undefined;
          const scopeFor = Effect.gen(function* () {
            const current = yield* sessions.read(binding.threadId);
            if (
              !credential ||
              !current ||
              current.providerSessionId !== credential.providerSessionId ||
              current.authorizationHeader !== credential.authorizationHeader
            )
              return undefined;
            const scope = yield* registry.resolve(
              current.authorizationHeader.replace(/^Bearer /, ""),
            );
            if (
              scope?.thread.threadId !== binding.threadId ||
              scope.thread.providerSessionId !== credential.providerSessionId ||
              scope.thread.providerInstanceId !== credential.providerInstanceId ||
              scope.environmentId !== credential.environmentId
            )
              return undefined;
            return yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.orElseSucceed(() => undefined),
            );
          });
          const validate = (
            params: Browser.BrowserExecuteParams | Browser.BrowserListParams,
            action: boolean,
            lifecycle = false,
          ) =>
            Effect.gen(function* () {
              const scope = yield* scopeFor;
              if (
                !scope ||
                params.sessionId !== (yield* binding.nativeSessionId) ||
                params.workspacePath !== binding.workspacePath ||
                params.workspaceKey !== binding.workspacePath ||
                params.workspaceIdentity !== undefined ||
                params.remoteSessionId !== undefined ||
                params.sessionContext !== "live" ||
                params.clientMode !== "desktop-continuous"
              )
                return undefined;
              if (!lifecycle) {
                if (closed) return undefined;
                const thread = yield* projections
                  .getThreadShell(binding.threadId)
                  .pipe(Effect.orElseSucceed(() => null));
                if (!thread) return undefined;
                const authorized = yield* assertLiveThread(scope, thread).pipe(
                  Effect.andThen(action ? assertPreviewAction(thread) : Effect.void),
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
                if (!authorized) return undefined;
              }
              cleanupScope = scope;
              return scope;
            });
          const release = Effect.gen(function* () {
            if (released) return;
            released = true;
            const scope = cleanupScope;
            closed = true;
            if (!scope) return;
            const hosts = [...discovered.values()];
            yield* Effect.forEach(
              hosts,
              (host) =>
                broker
                  .nativeLifecycle({
                    scope,
                    host,
                    operation: "releaseAgent",
                    input: {},
                    kind: "closeSession",
                    timeoutMs: 1_000,
                  })
                  .pipe(Effect.ignore),
              { discard: true },
            );
          });
          yield* Effect.addFinalizer(() => release);
          if (credential)
            yield* registry
              .awaitRevocation(credential.authorizationHeader.replace(/^Bearer /, ""))
              .pipe(Effect.andThen(release), Effect.forkScoped);
          return {
            onBrowserTermination: () => release,
            onBrowserList: (params) =>
              Effect.gen(function* () {
                const scope = yield* validate(params, false);
                if (!scope) return { browsers: [] };
                const hosts = yield* broker.nativeHosts(scope);
                for (const host of hosts) discovered.set(host.id, host);
                return {
                  browsers: hosts.map((host) => ({
                    id: host.id,
                    generation: host.generation,
                    type: "cdp" as const,
                    name: "T3 preview",
                    capabilities: { browser: [], tab: [] },
                    apiSupportOverrides: Object.fromEntries(
                      Object.entries(nativeApiOperations).map(([api, operation]) => [
                        api,
                        operation !== false && host.supportedOperations.includes(operation),
                      ]),
                    ),
                  })),
                };
              }),
            onBrowserExecute: (params) =>
              Effect.gen(function* () {
                const startedAt = yield* Clock.currentTimeMillis;
                const execute = Effect.gen(function* () {
                  const method = params.command.method;
                  const lifecycle =
                    method === "cancelRequest" ||
                    method === "turnEnded" ||
                    method === "closeSession";
                  const translation = lifecycle ? undefined : translate(params.command);
                  const scope = yield* validate(params, !(translation?.read ?? false), lifecycle);
                  if (
                    lifecycle &&
                    params.command.closeTabs === true &&
                    !(yield* validate(params, true))
                  )
                    return unavailable(
                      "capability_unsupported",
                      "Closing native tabs requires live action authority",
                    );
                  const host =
                    params.browserId === undefined ? undefined : discovered.get(params.browserId);
                  if (!scope || !host || params.browserGeneration !== host.generation)
                    return unavailable(
                      "backend_unavailable",
                      "Native browser scope or generation unavailable",
                    );
                  if (
                    !lifecycle &&
                    (canceled.has(params.requestId) ||
                      (params.turnId !== undefined && endedTurns.has(params.turnId)))
                  )
                    return unavailable("cancelled", "Native browser request or turn has ended");
                  if (inFlight.has(params.requestId))
                    return unavailable(
                      "duplicate_request_id",
                      "Native browser request ID is already pending",
                    );
                  if (lifecycle)
                    return yield* Effect.gen(function* () {
                      const allowed =
                        method === "cancelRequest"
                          ? ["method", "requestId"]
                          : method === "turnEnded"
                            ? ["method", "turnId"]
                            : ["method", "closeTabs"];
                      if (
                        Object.keys(params.command).some((key) => !allowed.includes(key)) ||
                        (method === "cancelRequest" &&
                          (typeof params.command.requestId !== "string" ||
                            params.command.requestId.length === 0)) ||
                        (method === "turnEnded" &&
                          (params.turnId === undefined ||
                            params.command.turnId !== params.turnId)) ||
                        (method === "closeSession" &&
                          params.command.closeTabs !== undefined &&
                          typeof params.command.closeTabs !== "boolean")
                      )
                        return unavailable(
                          "capability_unsupported",
                          "Invalid native lifecycle command",
                        );
                      const targetRequestId =
                        method === "cancelRequest"
                          ? (params.command.requestId as string)
                          : undefined;
                      const key = encodeLifecycleKey([
                        host.id,
                        String(host.generation),
                        method,
                        method === "closeSession" ? "" : (targetRequestId ?? params.turnId ?? ""),
                      ]);
                      const previous = lifecycleResults.get(key);
                      if (previous) return yield* Deferred.await(previous);
                      if (closed)
                        return unavailable(
                          "backend_unavailable",
                          "Native browser session has closed",
                        );
                      const completion = yield* Deferred.make<Browser.BrowserExecuteResult>();
                      lifecycleResults.set(key, completion);
                      if (targetRequestId !== undefined) canceled.add(targetRequestId);
                      if (method === "turnEnded" && params.turnId !== undefined)
                        endedTurns.add(params.turnId);
                      if (method === "closeSession") closed = true;
                      const cleanup = (target: Host) =>
                        broker.nativeLifecycle({
                          scope,
                          host: target,
                          operation: "releaseAgent",
                          input: {},
                          kind: method,
                          targetRequestId,
                          nativeTurnId: params.turnId,
                          closeTabs: params.command.closeTabs === true,
                        });
                      if (method === "closeSession") released = true;
                      const result = yield* (
                        method === "closeSession"
                          ? Effect.forEach([...discovered.values()], (target) =>
                              cleanup(target).pipe(Effect.result),
                            ).pipe(
                              Effect.map((results): Browser.BrowserExecuteResult =>
                                results.some(Result.isFailure)
                                  ? unavailable(
                                      "cancelled",
                                      "Browser cleanup outcome is uncertain",
                                      true,
                                    )
                                  : { ok: true, elapsedMs: 0 },
                              ),
                            )
                          : cleanup(host).pipe(
                              Effect.as<Browser.BrowserExecuteResult>({ ok: true, elapsedMs: 0 }),
                            )
                      ).pipe(
                        Effect.uninterruptible,
                        Effect.orElseSucceed(() =>
                          unavailable("cancelled", "Browser cleanup outcome is uncertain", true),
                        ),
                      );
                      yield* Deferred.succeed(completion, result);
                      return result;
                    }).pipe(Effect.uninterruptible);
                  if (!translation)
                    return unavailable(
                      "capability_unsupported",
                      "Native browser command has no supported T3 equivalent",
                    );
                  let tabId: PreviewTabId | undefined;
                  if (params.command.tabId !== undefined) {
                    const decoded = decodeTabId(params.command.tabId);
                    if (decoded._tag === "None")
                      return unavailable("capability_unsupported", "Invalid tab identity");
                    tabId = decoded.value;
                  }
                  inFlight.add(params.requestId);
                  return yield* Effect.gen(function* () {
                    const result = yield* broker.invoke({
                      scope,
                      host,
                      operation: translation.operation,
                      input: translation.input,
                      ...(tabId === undefined ? {} : { tabId }),
                      nativeRequestId: params.requestId,
                      nativeTurnId: params.turnId,
                      beforeDispatch: validate(params, !translation.read).pipe(
                        Effect.map(
                          (current) =>
                            current !== undefined &&
                            !closed &&
                            !canceled.has(params.requestId) &&
                            (params.turnId === undefined || !endedTurns.has(params.turnId)),
                        ),
                      ),
                    });
                    if (translation.operation === "evaluate")
                      return { ok: true, value: result, elapsedMs: 0 };
                    if (method === "screenshot") {
                      const snapshot = decodeSnapshot(result);
                      return snapshot._tag === "Some"
                        ? {
                            ok: true,
                            image: {
                              base64: snapshot.value.screenshot.data,
                              mimeType: snapshot.value.screenshot.mimeType,
                            },
                            elapsedMs: 0,
                          }
                        : unavailable("execution_error", "Invalid preview screenshot");
                    }
                    if (method === "playwright" && translation.read) {
                      const snapshot = decodeSnapshot(result);
                      return snapshot._tag === "Some" &&
                        typeof snapshot.value.accessibilityTree === "string"
                        ? {
                            ok: true,
                            value: snapshot.value.accessibilityTree.replace(
                              /\s*\[ref=t3-[^\]]+\]/g,
                              "",
                            ),
                            elapsedMs: 0,
                          }
                        : unavailable("execution_error", "Invalid preview DOM snapshot");
                    }
                    if (method === "list") {
                      const tabs = decodeTabs(result, { onExcessProperty: "error" });
                      return tabs._tag === "Some"
                        ? { ok: true, tabs: tabs.value, elapsedMs: 0 }
                        : unavailable("execution_error", "Invalid preview tab summaries");
                    }
                    const decodedStatus = decodeStatus(result);
                    if (method === "getState") {
                      if (decodedStatus._tag === "None")
                        return unavailable("execution_error", "Invalid preview status");
                      const status = decodedStatus.value;
                      if (!status.navigationHistory)
                        return unavailable(
                          "capability_unsupported",
                          "Preview host cannot report navigation history",
                        );
                      return {
                        ok: true,
                        state: {
                          url: status.url ?? "about:blank",
                          title: status.title ?? "",
                          ...status.navigationHistory,
                          ...(status.viewport
                            ? {
                                viewportWidth: status.viewport.width,
                                viewportHeight: status.viewport.height,
                              }
                            : {}),
                        },
                        elapsedMs: 0,
                      };
                    }
                    if (method === "newTab" || method === "activateTab") {
                      if (decodedStatus._tag === "None")
                        return unavailable(
                          "execution_error",
                          "Invalid preview status",
                          method === "newTab",
                        );
                      const status = decodedStatus.value;
                      if (!status.tabId || !status.viewport)
                        return unavailable(
                          "execution_error",
                          "Preview host did not return a native tab summary",
                          true,
                        );
                      return {
                        ok: true,
                        tab: {
                          tabId: status.tabId,
                          url: status.url ?? "about:blank",
                          title: status.title ?? "",
                          viewport: status.viewport,
                        },
                        elapsedMs: 0,
                      };
                    }
                    if (method === "getDialog") {
                      if (decodedStatus._tag === "None")
                        return unavailable("execution_error", "Invalid preview status");
                      const dialog = decodedStatus.value.dialog;
                      if (!dialog) return { ok: true, dialog: null, elapsedMs: 0 };
                      if (!["alert", "confirm", "prompt", "beforeunload"].includes(dialog.type))
                        return unavailable("execution_error", "Unsupported browser dialog type");
                      return {
                        ok: true,
                        dialog: {
                          type: dialog.type as "alert" | "confirm" | "prompt" | "beforeunload",
                          message: dialog.message,
                          ...(dialog.defaultValue === undefined
                            ? {}
                            : { defaultPrompt: dialog.defaultValue }),
                        },
                        elapsedMs: 0,
                      };
                    }
                    return { ok: true, elapsedMs: 0 };
                  }).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(params.requestId))));
                });
                const result = yield* execute.pipe(
                  Effect.catch((error) =>
                    Effect.succeed(
                      unavailable(
                        error._tag === "PreviewAutomationNoAvailableHostError"
                          ? "backend_unavailable"
                          : error._tag === "PreviewAutomationControlInterruptedError"
                            ? "cancelled"
                            : "execution_error",
                        "Browser operation failed or was interrupted; refresh browser facts before continuing",
                        error._tag !== "PreviewAutomationNoAvailableHostError",
                      ),
                    ),
                  ),
                );
                return { ...result, elapsedMs: (yield* Clock.currentTimeMillis) - startedAt };
              }),
          };
        }),
    });
  }),
);
