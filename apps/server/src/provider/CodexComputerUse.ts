import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { buildCodexInitializeParams } from "./CodexProvider.ts";

const NativeClientConfig = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
});
const McpConfig = Schema.Record(Schema.String, Schema.Unknown);
const NotifyConfig = Schema.Array(Schema.String);
const isNotifyConfig = Schema.is(NotifyConfig);
const isMcpConfig = Schema.is(McpConfig);
const isNativeClientConfig = Schema.is(NativeClientConfig);
const encodeCompletion = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("agent-turn-complete"),
      "thread-id": Schema.String,
      "turn-id": Schema.String,
      cwd: Schema.String,
      client: Schema.String,
      "input-messages": Schema.Array(Schema.String),
      "last-assistant-message": Schema.Null,
    }),
  ),
);
const ownerKey = (threadId: string, turnId: string) => `${threadId.length}:${threadId}${turnId}`;
const isNativeClient = (command: string) =>
  command.startsWith("/") && command.endsWith("/SkyComputerUseClient");

function nativeClientCommand(config: Readonly<Record<string, unknown>>) {
  if (
    isNotifyConfig(config.notify) &&
    isNativeClient(config.notify[0] ?? "") &&
    config.notify[1] === "turn-ended"
  ) {
    return config.notify[0];
  }
  if (isMcpConfig(config.mcp_servers)) {
    for (const entry of Object.values(config.mcp_servers)) {
      if (
        isNativeClientConfig(entry) &&
        entry.enabled !== false &&
        isNativeClient(entry.command) &&
        entry.args.length === 1 &&
        entry.args[0] === "mcp"
      ) {
        return entry.command;
      }
    }
  }
}

/** Notify native CUA when its Codex turn ends, including abnormal exits. */
export const watchCodexComputerUse = Effect.fn("watchCodexComputerUse")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly disconnected: Effect.Effect<unknown>;
}) {
  const scope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pending = new Map<string, { readonly threadId: string; readonly turnId: string }>();
  const closing = new Set<string>();
  let stopped = false;
  const command = yield* Effect.cached(
    input.client.request("config/read", { cwd: input.cwd, includeLayers: false }).pipe(
      Effect.map((response) => nativeClientCommand(response.config)),
      Effect.timeout("2 seconds"),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  );

  const closeOwner = (key: string) =>
    Effect.gen(function* () {
      const owner = pending.get(key);
      if (!owner) return;
      const executable = yield* command;
      if (!executable) {
        pending.delete(key);
        return;
      }
      // Do not replay --previous-notify: this is native session cleanup, not another
      // user notification. Preserve the exact native thread and turn identity.
      const payload = encodeCompletion({
        type: "agent-turn-complete",
        "thread-id": owner.threadId,
        "turn-id": owner.turnId,
        cwd: input.cwd,
        client: buildCodexInitializeParams().clientInfo.name,
        "input-messages": [],
        "last-assistant-message": null,
      });
      const delivered = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(executable, ["turn-ended", payload], {
              env: input.environment,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              forceKillAfter: "1 second",
            }),
          );
          return (yield* child.exitCode) === 0;
        }).pipe(Effect.timeout("2 seconds")),
      ).pipe(Effect.catch(() => Effect.succeed(false)));
      if (delivered) pending.delete(key);
      else yield* Effect.logWarning("Native Codex computer-use cleanup failed.", owner);
    });

  const closeAll = Effect.gen(function* () {
    stopped = true;
    yield* Effect.forEach([...pending.keys()], closeOwner, { concurrency: 4, discard: true });
  });
  yield* input.client.handleServerNotification("turn/started", (payload) =>
    Effect.gen(function* () {
      if (stopped) return;
      // Code-mode tools can hide native CUA calls inside an exec item. Like
      // Codex's notify hook, notify for every turn when the native client is configured.
      pending.set(ownerKey(payload.threadId, payload.turn.id), {
        threadId: payload.threadId,
        turnId: payload.turn.id,
      });
      // Notification handlers run on the protocol reader; a config request must
      // run separately so that reader can deliver its response.
      yield* command.pipe(Effect.forkIn(scope), Effect.asVoid);
    }),
  );
  yield* input.client.handleServerNotification("turn/completed", (payload) =>
    Effect.gen(function* () {
      const key = ownerKey(payload.threadId, payload.turn.id);
      if (!pending.has(key) || closing.has(key)) return;
      closing.add(key);
      yield* closeOwner(key).pipe(
        Effect.ensuring(Effect.sync(() => closing.delete(key))),
        Effect.forkIn(scope),
      );
    }),
  );
  yield* input.disconnected.pipe(Effect.ignore, Effect.andThen(closeAll), Effect.forkIn(scope));
  // Registered after the monitor, and before per-turn fibers: closing the
  // scope interrupts those fibers first, then retries any unfinished cleanup.
  yield* Effect.addFinalizer(() => closeAll);
});
