import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BrowserSchema from "./ZCodeBrowserSchema.ts";

import * as ZCodeError from "./ZCodeProtocolErrors.ts";
import * as ZCodeProtocol from "./ZCodeProtocolConnection.ts";
import * as ZCodeResult from "./ZCodeResultSchemas.ts";
import * as ZCodeSchema from "./ZCodeWireSchema.ts";

const decodeBrowserList = Schema.decodeUnknownEffect(BrowserSchema.BrowserListParams);
const decodeBrowserExecute = Schema.decodeUnknownEffect(BrowserSchema.BrowserExecuteParams);
const decodeOfficialMcpAuth = Schema.decodeUnknownEffect(
  ZCodeSchema.RequestOfficialMcpAuthHeadersParams,
);

export interface ZCodeAppServerClientOptions {
  readonly onBrowserTermination?: () => Effect.Effect<void>;
  readonly onBrowserList?: (
    params: BrowserSchema.BrowserListParams,
  ) => Effect.Effect<BrowserSchema.BrowserListResult, ZCodeError.ZCodeAppServerError>;
  readonly onBrowserExecute?: (
    params: BrowserSchema.BrowserExecuteParams,
  ) => Effect.Effect<BrowserSchema.BrowserExecuteResult, ZCodeError.ZCodeAppServerError>;
  readonly logger?: (event: ZCodeProtocol.ZCodeProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onTermination?: ZCodeProtocol.ZCodeProtocolOptions["onTermination"];
  /**
   * Runtime preferences returned to `session/requestRuntimePreferences`.
   * The runtime asks once per session materialization and again with scope
   * `user-execution` when a turn starts; a timeout there fails the session.
   */
  readonly runtimePreferences?: ZCodeSchema.RequestRuntimePreferencesResult;
  readonly onProviderRuntimeHeaders?: (
    params: Record<string, unknown>,
  ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
  readonly onOfficialMcpAuthHeaders?: (
    params: ZCodeSchema.RequestOfficialMcpAuthHeadersParams,
  ) => Effect.Effect<
    ZCodeSchema.RequestOfficialMcpAuthHeadersResult,
    ZCodeError.ZCodeAppServerError
  >;
  /**
   * Answers `interaction/requestPermission`. The default denies requests when no interactive handler is installed.
   */
  readonly onPermissionRequest?: (
    params: ZCodeSchema.RequestPermissionParams,
    serverRequestId: string | number,
  ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
  /**
   * Answers `interaction/requestUserInput`. The default cancels the prompt
   * so the turn fails instead of blocking forever.
   */
  readonly onUserInputRequest?: (
    params: ZCodeSchema.RequestUserInputParams,
    serverRequestId: string | number,
  ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
  /** Invoked for every `session/event` envelope. Failures are ignored. */
  readonly onSessionEvent?: (event: ZCodeSchema.SessionEventEnvelope) => Effect.Effect<void, never>;
}

export interface ZCodeAppServerClientService {
  readonly protocol: ZCodeProtocol.ZCodeProtocol;
  /** Answer a server-initiated request that a handler deferred. */
  readonly respondServerRequest: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>;
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
  readonly runtimeCapabilities: () => Effect.Effect<
    ZCodeResult.RuntimeCapabilitiesResult,
    ZCodeError.ZCodeAppServerError
  >;
  readonly sessionCreate: (
    params: ZCodeSchema.SessionCreateParams,
  ) => Effect.Effect<ZCodeSchema.SessionCreateResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionResume: (
    params: ZCodeSchema.SessionResumeParams,
  ) => Effect.Effect<ZCodeResult.SessionResumeResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionList: (
    params: ZCodeSchema.SessionListParams,
  ) => Effect.Effect<ZCodeSchema.SessionListResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionSubscribe: (
    params: ZCodeSchema.SessionSubscribeParams,
  ) => Effect.Effect<ZCodeSchema.SessionSubscribeResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionSend: (
    params: ZCodeSchema.SessionSendParams,
  ) => Effect.Effect<ZCodeSchema.SessionSendResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionGoal: (
    params: ZCodeSchema.SessionGoalParams,
  ) => Effect.Effect<ZCodeResult.SessionGoalResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionStop: (
    params: ZCodeSchema.SessionStopParams,
  ) => Effect.Effect<ZCodeResult.SessionStopResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionSetModel: (
    params: ZCodeSchema.SessionSetModelParams,
  ) => Effect.Effect<ZCodeResult.SessionSetModelResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionSetMode: (
    params: ZCodeSchema.SessionSetModeParams,
  ) => Effect.Effect<ZCodeResult.SessionSetModeResult, ZCodeError.ZCodeAppServerError>;
  readonly sessionClose: (
    params: ZCodeSchema.SessionCloseParams,
  ) => Effect.Effect<ZCodeSchema.SessionCloseResult, ZCodeError.ZCodeAppServerError>;
  /** Typed stream of `session/event` envelopes. */
  readonly sessionEvents: Stream.Stream<ZCodeSchema.SessionEventEnvelope>;
  readonly pid: number | undefined;
}

const decodeSessionEvent = Schema.decodeUnknownSync(ZCodeSchema.SessionEventEnvelope);
const decodeStateUpdated = Schema.decodeUnknownSync(ZCodeSchema.StateUpdatedNotification);

const defaultRuntimePreferences: ZCodeSchema.RequestRuntimePreferencesResult = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
  modelContextBudgetStrategy: "preflight-v1",
};

/**
 * The runtime sends each permission option with its full suggested response
 * (`{decision, ...}`). Replying with that exact object keeps the applied
 * permission identical to what the runtime itself proposed for the option.
 */
const defaultPermissionResponse = (params: Record<string, unknown> | undefined): unknown => {
  const options = Array.isArray(params?.options)
    ? (params?.options as Array<Record<string, unknown>>)
    : [];
  for (const option of options) {
    const response = option?.response;
    if (
      typeof response === "object" &&
      response !== null &&
      (response as Record<string, unknown>).decision === "deny"
    ) {
      return response;
    }
  }
  return { decision: "deny" };
};

export const makeClientFromHandle = Effect.fn("t3-provider-zcode-makeClient")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle | undefined,
  options: ZCodeAppServerClientOptions = {},
): Effect.fn.Return<ZCodeAppServerClientService, never, Scope.Scope> {
  const terminationError = handle
    ? Effect.match(handle.exitCode, {
        onFailure: (cause) =>
          new ZCodeError.ZCodeAppServerProcessExitedError({ pid: handle.pid, cause }),
        onSuccess: (code) =>
          new ZCodeError.ZCodeAppServerProcessExitedError({ code, pid: handle.pid }),
      })
    : Effect.succeed(new ZCodeError.ZCodeAppServerProcessExitedError({}));

  const protocol = yield* ZCodeProtocol.makeZCodeProtocol({
    stdio: handle
      ? Stdio.make({
          args: Effect.succeed([]),
          stdin: handle.stdout,
          stdout: () =>
            Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
              typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
            ) as never,
          stderr: () => Stream.drain as never,
        })
      : Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.empty as never,
          stdout: () => Stream.drain as never,
          stderr: () => Stream.drain as never,
        }),
    terminationError,
    onTermination: (error) =>
      Effect.gen(function* () {
        if (options.onBrowserTermination) yield* options.onBrowserTermination();
        if (options.onTermination) yield* options.onTermination(error);
      }),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: (notification) => {
      if (options.onSessionEvent === undefined) {
        return Effect.void;
      }
      if (notification.method === "state.updated") {
        const state = decodeStateUpdated(notification.params);
        if (state.scope !== "session" || !state.sessionId) return Effect.void;
        return options
          .onSessionEvent({
            type: "state.updated",
            sessionId: state.sessionId,
            payload: { reason: state.reason },
          })
          .pipe(Effect.ignore);
      }
      if (notification.method !== "session/event") return Effect.void;
      const decoded = decodeSessionEvent(notification.params ?? {});
      return options.onSessionEvent(decoded).pipe(Effect.ignore);
    },
    onRequest: (request): Effect.Effect<unknown, ZCodeError.ZCodeAppServerError> => {
      const params = (request.params ?? {}) as Record<string, unknown>;
      switch (request.method) {
        case "session/requestRuntimePreferences": {
          const prefs = options.runtimePreferences ?? defaultRuntimePreferences;
          return Effect.succeed({
            nativeSearchEnhancementsEnabled: prefs.nativeSearchEnhancementsEnabled,
            memoryEnabled: prefs.memoryEnabled ?? false,
            askUserQuestionAutoResolutionEnabled:
              prefs.askUserQuestionAutoResolutionEnabled ?? false,
            ...(prefs.integratedTerminalShell !== undefined
              ? { integratedTerminalShell: prefs.integratedTerminalShell }
              : {}),
            ...(prefs.modelContextBudgetStrategy !== undefined
              ? { modelContextBudgetStrategy: prefs.modelContextBudgetStrategy }
              : { modelContextBudgetStrategy: "preflight-v1" }),
          });
        }
        case "interaction/requestProviderRuntimeHeaders":
          return (
            options.onProviderRuntimeHeaders?.(params) ??
            Effect.succeed({
              headersApplied: false,
              errorMessage: "No native account authentication handler",
            })
          );
        case "interaction/browserList":
          return decodeBrowserList(params, {
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ZCodeError.ZCodeAppServerProtocolParseError({
                  operation: "decode-response-payload",
                  method: request.method,
                  detail: "Invalid native browser request",
                  cause,
                }),
            ),
            Effect.flatMap(
              (decoded) => options.onBrowserList?.(decoded) ?? Effect.succeed({ browsers: [] }),
            ),
          );
        case "interaction/browserExecute":
          return decodeBrowserExecute(params, {
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ZCodeError.ZCodeAppServerProtocolParseError({
                  operation: "decode-response-payload",
                  method: request.method,
                  detail: "Invalid native browser request",
                  cause,
                }),
            ),
            Effect.flatMap(
              (decoded) =>
                options.onBrowserExecute?.(decoded) ??
                Effect.succeed<BrowserSchema.BrowserExecuteResult>({
                  ok: false,
                  elapsedMs: 0,
                  error: {
                    code: "backend_unavailable",
                    message: "Native browser bridge unavailable",
                    sideEffect: "none",
                  },
                }),
            ),
          );
        case "interaction/requestPermission": {
          if (options.onPermissionRequest !== undefined) {
            return options.onPermissionRequest(params as never, request.id);
          }
          return Effect.succeed(defaultPermissionResponse(params));
        }
        case "interaction/requestUserInput": {
          if (options.onUserInputRequest !== undefined) {
            return options.onUserInputRequest(params as never, request.id);
          }
          return Effect.succeed(
            Array.isArray(params.questions)
              ? { action: "cancel" }
              : {
                  requestId: typeof params.requestId === "string" ? params.requestId : "",
                  cancelled: true,
                },
          );
        }
        case "interaction/requestOfficialMcpAuthHeaders":
          return decodeOfficialMcpAuth(params).pipe(
            Effect.flatMap(
              (decoded) =>
                options.onOfficialMcpAuthHeaders?.(decoded) ??
                Effect.succeed<ZCodeSchema.RequestOfficialMcpAuthHeadersResult>({
                  ok: false,
                  reason: "official_auth_unavailable",
                }),
            ),
            Effect.catch(() =>
              Effect.succeed<ZCodeSchema.RequestOfficialMcpAuthHeadersResult>({
                ok: false,
                reason: "official_auth_unavailable",
              }),
            ),
          );
        default:
          return Effect.fail(
            new ZCodeError.ZCodeAppServerRequestError({
              method: request.method,
              detail: "No handler registered for this server request",
            }),
          );
      }
    },
  });

  const request = (method: string, params?: unknown) => protocol.request(method, params);

  const typed = <A>(method: string, resultSchema: Schema.Codec<A, unknown>, params?: unknown) =>
    request(method, params).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeUnknownEffect(resultSchema)(raw).pipe(
          Effect.mapError(
            (cause) =>
              new ZCodeError.ZCodeAppServerProtocolParseError({
                operation: "decode-response-payload",
                method,
                detail: "Response did not match the expected schema",
                cause,
              }),
          ),
        ),
      ),
    );

  return {
    protocol,
    request,
    respondServerRequest: protocol.respond,
    runtimeCapabilities: () =>
      typed("runtime/capabilities", ZCodeResult.RuntimeCapabilitiesResult, {}),
    sessionCreate: (params) => typed("session/create", ZCodeSchema.SessionCreateResult, params),
    sessionResume: (params) => typed("session/resume", ZCodeResult.SessionResumeResult, params),
    sessionList: (params) => typed("session/list", ZCodeSchema.SessionListResult, params),
    sessionSubscribe: (params) =>
      typed("session/subscribe", ZCodeSchema.SessionSubscribeResult, params),
    sessionSend: (params) => typed("session/send", ZCodeSchema.SessionSendResult, params),
    sessionGoal: (params) => typed("session/goal", ZCodeResult.SessionGoalResult, params),
    sessionStop: (params) => typed("session/stop", ZCodeResult.SessionStopResult, params),
    sessionSetModel: (params) =>
      typed("session/setModel", ZCodeResult.SessionSetModelResult, params),
    sessionSetMode: (params) => typed("session/setMode", ZCodeResult.SessionSetModeResult, params),
    sessionClose: (params) => typed("session/close", ZCodeSchema.SessionCloseResult, params),
    sessionEvents: protocol.incomingNotifications.pipe(
      Stream.filter(
        (notification) =>
          notification.method === "session/event" || notification.method === "state.updated",
      ),
      Stream.map((notification) => {
        if (notification.method === "session/event")
          return decodeSessionEvent(notification.params ?? {});
        const state = decodeStateUpdated(notification.params);
        return {
          type: "state.updated",
          ...(state.scope === "session" && state.sessionId ? { sessionId: state.sessionId } : {}),
          payload: { reason: state.reason },
        };
      }),
    ),
    pid: handle?.pid,
  } satisfies ZCodeAppServerClientService;
});
