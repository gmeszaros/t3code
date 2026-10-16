import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { watchCodexComputerUse } from "./CodexComputerUse.ts";

const executable = "/native/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient";
const readRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number, method: Schema.String })),
);
const readPayload = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const makeHarness = Effect.fn(function* (options?: {
  readonly config?: CodexSchema.V2ConfigReadResponse__Config;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly spawn?: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"];
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const processed = yield* Queue.unbounded<void>();
  const spawned = yield* Queue.unbounded<ChildProcess.StandardCommand>();
  const released = yield* Queue.unbounded<void>();
  const disconnected = yield* Deferred.make<void>();
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const commands: Array<ChildProcess.StandardCommand> = [];
  let configReads = 0;
  const emit = (method: string, params: unknown) =>
    Queue.offer(input, new TextEncoder().encode(`${JSON.stringify({ method, params })}\n`));
  const client = yield* CodexClient.make(
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.gen(function* () {
            const request = readRequest(
              typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
            );
            assert.equal(request.method, "config/read");
            configReads++;
            yield* Queue.offer(
              input,
              new TextEncoder().encode(
                `${JSON.stringify({
                  id: request.id,
                  result: {
                    config: options?.config ?? {
                      notify: [executable, "turn-ended", "--previous-notify", "unused"],
                    },
                    origins: {},
                  },
                })}\n`,
              ),
            );
          }),
        ),
      stderr: () => Sink.drain,
    }),
  );
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert(ChildProcess.isStandardCommand(command));
      commands.push(command);
      yield* Effect.addFinalizer(() => Queue.offer(released, undefined));
      yield* Queue.offer(spawned, command);
      if (options?.spawn) return yield* options.spawn(command);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  yield* watchCodexComputerUse({
    client,
    cwd: "/project",
    environment: { CODEX_HOME: "/profile", ...options?.environment },
    disconnected: Deferred.await(disconnected),
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  yield* client.handleServerNotification("turn/started", () => Queue.offer(processed, undefined));
  yield* client.handleServerNotification("turn/completed", () => Queue.offer(processed, undefined));
  return {
    commands,
    spawned,
    released,
    configReads: () => configReads,
    disconnect: Deferred.succeed(disconnected, undefined),
    close: Scope.close(scope, Exit.void),
    start: (threadId: string, turnId: string) =>
      emit("turn/started", {
        threadId,
        turn: { id: turnId, status: "inProgress", items: [] },
      }).pipe(Effect.andThen(Queue.take(processed))),
    end: (threadId: string, turnId: string, status = "completed") =>
      emit("turn/completed", { threadId, turn: { id: turnId, status, items: [] } }).pipe(
        Effect.andThen(Queue.take(processed)),
      ),
  };
});

it.effect.each(["completed", "interrupted", "failed"])(
  "notifies only the CUA owner on a %s turn, leaving concurrent work active",
  (status) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.start("parent", "turn");
      yield* h.start("child", "turn");
      yield* h.end("parent", "turn", status);
      const command = yield* Queue.take(h.spawned);
      yield* Queue.take(h.released);
      assert.equal(command.command, executable);
      assert.equal(command.args.length, 2);
      assert.equal(command.args[0], "turn-ended");
      assert.deepEqual(readPayload(command.args[1]!), {
        type: "agent-turn-complete",
        "thread-id": "parent",
        "turn-id": "turn",
        cwd: "/project",
        client: "T3 Code",
        "input-messages": [],
        "last-assistant-message": null,
      });
      yield* h.end("parent", "turn", status);
      assert.equal(h.commands.length, 1);
      assert.equal(h.configReads(), 1);
      yield* h.end("child", "turn");
      const childCommand = yield* Queue.take(h.spawned);
      assert.equal(readPayload(childCommand.args[1]!)["thread-id"], "child");
      yield* Queue.take(h.released);
    }).pipe(Effect.scoped),
);

it.effect("does not notify an active owner on inactivity, and handles the next turn again", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.start("thread", "first");
    yield* TestClock.adjust("1 hour");
    assert.equal(h.commands.length, 0);
    yield* h.end("thread", "first");
    yield* Queue.take(h.spawned);
    yield* Queue.take(h.released);
    yield* h.start("thread", "second");
    yield* h.end("thread", "second");
    const next = yield* Queue.take(h.spawned);
    assert.equal(readPayload(next.args[1]!)["turn-id"], "second");
    yield* Queue.take(h.released);
  }).pipe(Effect.scoped),
);

it.effect.each(["disconnect", "close"] as const)("notifies abandoned owners on %s", (action) =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.start("parent", "a");
    yield* h.start("child", "b");
    yield* h[action];
    yield* Queue.take(h.spawned);
    yield* Queue.take(h.spawned);
    yield* Queue.take(h.released);
    yield* Queue.take(h.released);
    assert.deepEqual(h.commands.map((c) => readPayload(c.args[1]!)["thread-id"]).sort(), [
      "child",
      "parent",
    ]);
    yield* h.close;
    assert.equal(h.commands.length, 2);
  }).pipe(Effect.scoped),
);

it.effect("bounds a hung cleanup and releases its process scope", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ exitCode: Effect.never });
    yield* h.start("thread", "turn");
    yield* h.end("thread", "turn");
    const command = yield* Queue.take(h.spawned);
    assert.equal(command.options.forceKillAfter, "1 second");
    yield* TestClock.adjust("2 seconds");
    yield* Queue.take(h.released);
    // A failed cleanup gets one more bounded attempt when its session closes.
    yield* h.close.pipe(Effect.forkScoped);
    yield* Queue.take(h.spawned);
    yield* TestClock.adjust("2 seconds");
    yield* Queue.take(h.released);
    assert.equal(h.commands.length, 2);
  }).pipe(Effect.scoped),
);

it.effect("finds the native MCP client when no completion hook is configured", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      config: { mcp_servers: { "computer-use": { command: executable, args: ["mcp"] } } },
    });
    yield* h.start("thread", "turn");
    yield* h.end("thread", "turn");
    assert.equal((yield* Queue.take(h.spawned)).command, executable);
    yield* Queue.take(h.released);
  }).pipe(Effect.scoped),
);

it.effect("retries a rejected cleanup on disposal without replaying successful owners", () =>
  Effect.gen(function* () {
    let exits = 0;
    const h = yield* makeHarness({
      exitCode: Effect.sync(() => ChildProcessSpawner.ExitCode(exits++ === 0 ? 1 : 0)),
    });
    yield* h.start("thread", "turn");
    yield* h.end("thread", "turn", "failed");
    yield* Queue.take(h.spawned);
    yield* Queue.take(h.released);
    yield* h.close;
    assert.equal(h.commands.length, 2);
    assert.deepEqual(h.commands[0]!.args, h.commands[1]!.args);
  }).pipe(Effect.scoped),
);

it.effect("does not execute an arbitrary notify hook for native tool activity", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ config: { notify: ["/usr/bin/some-other-helper"] } });
    yield* h.start("thread", "turn");
    yield* h.end("thread", "turn");
    yield* h.close;
    assert.equal(h.commands.length, 0);
  }).pipe(Effect.scoped),
);

it.effect("leaves arbitrary notification commands alone", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ config: { notify: ["notify-send", "finished"] } });
    yield* h.start("thread", "turn");
    yield* h.end("thread", "turn");
    yield* h.close;
    assert.equal(h.commands.length, 0);
    assert.equal(h.configReads(), 1);
  }).pipe(Effect.scoped),
);

it.effect("delivers cleanup as literal arguments to an isolated executable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cua-lifecycle-" });
    const clientPath = `${directory}/SkyComputerUseClient`;
    const output = `${directory}/notification`;
    yield* fs.writeFileString(
      clientPath,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$T3_CUA_TEST_OUTPUT"\n',
      { mode: 0o755 },
    );
    const h = yield* makeHarness({
      config: { notify: [clientPath, "turn-ended"] },
      spawn: spawner.spawn,
      environment: { T3_CUA_TEST_OUTPUT: output },
    });
    yield* h.start("thread", "turn-with-$()-and-spaces");
    yield* h.end("thread", "turn-with-$()-and-spaces");
    yield* Queue.take(h.released);
    const [action, payload] = (yield* fs.readFileString(output)).trim().split("\n");
    assert.equal(action, "turn-ended");
    assert.equal(readPayload(payload!)["turn-id"], "turn-with-$()-and-spaces");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
