import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as ZCodeError from "./ZCodeProtocolErrors.ts";

const MAX_BUFFERED_RAW_MESSAGES = 64;
const encodeJsonMessage = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodeJsonLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export interface ZCodeProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decode_failed";
  readonly payload: unknown;
}

export interface ZCodeIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface ZCodeIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface ZCodeProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<ZCodeError.ZCodeAppServerError>;
  readonly logger?: (event: ZCodeProtocolLogEvent) => Effect.Effect<void, never>;
  /** Invoked for every notification; failures are ignored. */
  readonly onNotification?: (notification: ZCodeIncomingNotification) => Effect.Effect<void, never>;
  /** Answers a server-initiated request; the reply is sent automatically. */
  readonly onRequest?: (
    request: ZCodeIncomingRequest,
  ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
  readonly onTermination?: (error: ZCodeError.ZCodeAppServerError) => Effect.Effect<void, never>;
}

export interface ZCodeProtocol {
  /** Every notification, including `session/event` envelopes. */
  readonly incomingNotifications: Stream.Stream<ZCodeIncomingNotification>;
  /** Server-initiated requests the client must answer. */
  readonly incomingRequests: Stream.Stream<ZCodeIncomingRequest>;
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
  /** Answer a server-initiated request later (e.g. after user approval). */
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>;
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<unknown, ZCodeError.ZCodeAppServerError>;
  readonly method: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWireId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

export const makeZCodeProtocol = Effect.fn("effect-zcode-app-server/makeZCodeProtocol")(function* (
  options: ZCodeProtocolOptions,
): Effect.fn.Return<ZCodeProtocol, never, Scope.Scope> {
  const protocolScope = yield* Scope.Scope;
  const requestHandlerScope = yield* Scope.fork(protocolScope, "parallel");
  const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
  const incomingNotifications =
    yield* Queue.sliding<ZCodeIncomingNotification>(MAX_BUFFERED_RAW_MESSAGES);
  const incomingRequests = yield* Queue.sliding<ZCodeIncomingRequest>(MAX_BUFFERED_RAW_MESSAGES);
  const pending = yield* Ref.make(new Map<number, PendingRequest>());
  const nextRequestId = yield* Ref.make(1);
  const remainder: Array<string> = [];
  const terminationHandled = yield* Ref.make(false);
  const terminationFailure = yield* Ref.make(Option.none<ZCodeError.ZCodeAppServerError>());
  const terminationSignal = yield* Deferred.make<void>();

  const logProtocol = (event: ZCodeProtocolLogEvent) => options.logger?.(event) ?? Effect.void;

  const failAllPending = (error: ZCodeError.ZCodeAppServerError) =>
    Ref.get(pending).pipe(
      Effect.flatMap((current) =>
        Effect.forEach([...current.values()], ({ deferred }) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
      Effect.andThen(Ref.set(pending, new Map())),
    );

  const handleTermination = (classify: () => Effect.Effect<ZCodeError.ZCodeAppServerError>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) return [Effect.void, true] as const;
      return [
        Effect.gen(function* () {
          const error = yield* classify();
          yield* Ref.set(terminationFailure, Option.some(error));
          // Invalidate the owning session before failed RPCs can run turn cleanup.
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
          yield* failAllPending(error);
          yield* Queue.end(outgoing);
          yield* Deferred.succeed(terminationSignal, undefined);
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten, Effect.uninterruptible);

  const offerOutgoing = Effect.fn("ZCodeProtocolConnection.offerOutgoing")(function* (
    message: Record<string, unknown>,
  ): Effect.fn.Return<void, ZCodeError.ZCodeAppServerError> {
    const failure = yield* Ref.get(terminationFailure);
    if (Option.isSome(failure)) return yield* failure.value;
    const result = message.result;
    const authentication = isObject(result) && ("requestAuth" in result || "headers" in result);
    const mcpConfiguration = isObject(message.params) && "mcpServers" in message.params;
    const sensitive = authentication || mcpConfiguration;
    yield* logProtocol({
      direction: "outgoing",
      stage: "raw",
      payload: authentication
        ? { ...message, result: "[REDACTED native authentication response]" }
        : mcpConfiguration
          ? { ...message, params: "[REDACTED MCP session configuration]" }
          : message,
    });
    const encoded = yield* encodeJsonMessage(message).pipe(
      Effect.mapError(
        (cause): ZCodeError.ZCodeAppServerError =>
          new ZCodeError.ZCodeAppServerProtocolParseError({
            operation: "encode-wire-message",
            ...(typeof message.method === "string" ? { method: message.method } : {}),
            detail: "Message is not JSON-serializable",
            cause: sensitive
              ? new Error("Sensitive native protocol message could not be encoded")
              : cause,
          }),
      ),
    );
    const accepted = yield* Queue.offer(outgoing, `${encoded}\n`);
    if (!accepted) {
      const closed = yield* Ref.get(terminationFailure);
      return yield* Option.getOrElse(
        closed,
        (): ZCodeError.ZCodeAppServerError => new ZCodeError.ZCodeAppServerProcessExitedError({}),
      );
    }
  });

  const removePending = (requestId: number) =>
    Ref.update(pending, (current) => {
      if (!current.has(requestId)) return current;
      const next = new Map(current);
      next.delete(requestId);
      return next;
    });

  const resolvePending = (
    requestId: number,
    handler: (pending: PendingRequest) => Effect.Effect<void>,
  ) =>
    Ref.modify(pending, (current) => {
      const entry = current.get(requestId);
      if (!entry) return [Effect.void, current] as const;
      const next = new Map(current);
      next.delete(requestId);
      return [handler(entry), next] as const;
    }).pipe(Effect.flatten);

  const respond = (requestId: string | number, result: unknown) =>
    offerOutgoing({ id: requestId, result });

  const respondError = (requestId: string | number, error: ZCodeError.ZCodeAppServerError) =>
    offerOutgoing({ id: requestId, error: { code: -32000, message: error.message } });

  const handleResponse = (
    message: Record<string, unknown>,
  ): Effect.Effect<void, ZCodeError.ZCodeAppServerError> => {
    const requestId = message.id;
    if (typeof requestId !== "number" || !Number.isInteger(requestId)) return Effect.void;
    if (message.error !== undefined) {
      return resolvePending(requestId, ({ deferred }) =>
        Deferred.fail(
          deferred,
          ZCodeError.ZCodeAppServerRequestError.fromServerError(requestId, message.error),
        ),
      );
    }
    return resolvePending(requestId, ({ deferred }) => Deferred.succeed(deferred, message.result));
  };

  const handleRequest = (
    request: ZCodeIncomingRequest,
  ): Effect.Effect<void, ZCodeError.ZCodeAppServerError> =>
    Queue.offer(incomingRequests, request).pipe(
      Effect.flatMap(() => {
        const handler = options.onRequest;
        if (handler === undefined) {
          return respondError(
            request.id,
            new ZCodeError.ZCodeAppServerRequestError({
              method: request.method,
              detail: "No handler registered for this server request",
            }),
          );
        }
        return handler(request).pipe(
          Effect.matchEffect({
            onFailure: (error) => respondError(request.id, error),
            onSuccess: (result) => respond(request.id, result),
          }),
          Effect.catch((error) =>
            handleTermination(() => Effect.succeed(error)).pipe(
              Effect.forkIn(protocolScope),
              Effect.asVoid,
            ),
          ),
          Effect.forkIn(requestHandlerScope, { startImmediately: true }),
          Effect.asVoid,
        );
      }),
      Effect.asVoid,
    );

  const handleNotification = (
    notification: ZCodeIncomingNotification,
  ): Effect.Effect<void, ZCodeError.ZCodeAppServerError> =>
    Queue.offer(incomingNotifications, notification).pipe(
      Effect.andThen(options.onNotification ? options.onNotification(notification) : Effect.void),
      Effect.ignore,
      Effect.asVoid,
    );

  const routeMessage = (message: unknown): Effect.Effect<void, ZCodeError.ZCodeAppServerError> => {
    if (!isObject(message)) {
      return Effect.fail(
        new ZCodeError.ZCodeAppServerProtocolParseError({
          operation: "route-wire-message",
          detail: "Expected a JSON object per line",
        }),
      );
    }
    if (typeof message.method === "string" && isWireId(message.id)) {
      return handleRequest({
        id: message.id,
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
    }
    if (typeof message.method === "string") {
      return handleNotification({
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
    }
    if (message.id !== undefined) return handleResponse(message);
    return Effect.fail(
      new ZCodeError.ZCodeAppServerProtocolParseError({
        operation: "route-wire-message",
        detail: "Message has neither method nor id",
      }),
    );
  };

  const handleLine = (line: string): Effect.Effect<void, ZCodeError.ZCodeAppServerError> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return Effect.void;
    return decodeJsonLine(trimmed).pipe(
      Effect.mapError(
        (cause): ZCodeError.ZCodeAppServerError =>
          new ZCodeError.ZCodeAppServerProtocolParseError({
            operation: "decode-wire-message",
            detail: "Line is not valid JSON",
            cause,
          }),
      ),
      Effect.tap((decoded) =>
        logProtocol({ direction: "incoming", stage: "raw", payload: decoded }),
      ),
      Effect.flatMap(routeMessage),
      Effect.catchTags({
        ZCodeAppServerProtocolParseError: (error) =>
          logProtocol({ direction: "incoming", stage: "decode_failed", payload: error }).pipe(
            Effect.asVoid,
          ),
      }),
    );
  };

  yield* options.stdio.stdin.pipe(
    Stream.interruptWhen(Deferred.await(terminationSignal)),
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        const lines: Array<string> = [];
        let start = 0;
        for (
          let newline = chunk.indexOf("\n");
          newline !== -1;
          newline = chunk.indexOf("\n", start)
        ) {
          remainder.push(chunk.slice(start, newline));
          lines.push(remainder.join("").replace(/\r$/, ""));
          remainder.length = 0;
          start = newline + 1;
        }
        if (start < chunk.length) {
          remainder.push(chunk.slice(start));
        }
        return lines;
      }).pipe(Effect.flatMap((lines) => Effect.forEach(lines, handleLine, { discard: true }))),
    ),
    Effect.catchCause((cause) =>
      handleTermination(() =>
        Effect.succeed(
          new ZCodeError.ZCodeAppServerProcessExitedError({ cause: Cause.squash(cause) }),
        ),
      ),
    ),
    Effect.andThen(
      handleTermination(
        () =>
          options.terminationError ??
          Effect.succeed(new ZCodeError.ZCodeAppServerProcessExitedError({})),
      ),
    ),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(options.stdio.stdout()),
    Effect.catchCause((cause) =>
      handleTermination(() =>
        Effect.succeed(
          new ZCodeError.ZCodeAppServerProcessExitedError({ cause: Cause.squash(cause) }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  const request = Effect.fn("ZCodeProtocolConnection.request")(function* (
    method: string,
    params?: unknown,
  ) {
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1] as const,
    );
    const deferred = yield* Deferred.make<unknown, ZCodeError.ZCodeAppServerError>();
    yield* Ref.update(pending, (current) => new Map(current).set(requestId, { deferred, method }));
    yield* offerOutgoing({
      id: requestId,
      method,
      ...(params !== undefined ? { params } : {}),
    }).pipe(Effect.tapError(() => removePending(requestId)));
    return yield* Deferred.await(deferred).pipe(Effect.onInterrupt(() => removePending(requestId)));
  });

  return {
    incomingNotifications: Stream.fromQueue(incomingNotifications),
    incomingRequests: Stream.fromQueue(incomingRequests),
    request,
    respond,
  };
});
