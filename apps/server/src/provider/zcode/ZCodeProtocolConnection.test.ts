import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { makeZCodeProtocol } from "./ZCodeProtocolConnection.ts";

it.effect.each(["failure", "defect"] as const)(
  "fails pending and future RPCs once on writer %s with input still open",
  (mode) =>
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      const writing = yield* Deferred.make<void>();
      const failWrite = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<void>();
      let exits = 0;
      const protocol = yield* makeZCodeProtocol({
        stdio: Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(input),
          stdout: () =>
            Sink.forEach(() =>
              Deferred.succeed(writing, undefined).pipe(
                Effect.andThen(Deferred.await(failWrite)),
                Effect.andThen(
                  mode === "defect"
                    ? Effect.die(new Error("Fixture broken pipe"))
                    : Effect.fail(
                        PlatformError.systemError({
                          _tag: "Unknown",
                          module: "Stdio",
                          method: "stdout",
                          cause: new Error("EPIPE"),
                        }),
                      ),
                ),
              ),
            ),
          stderr: () => Sink.drain,
        }),
        onTermination: () =>
          Effect.sync(() => {
            exits++;
          }).pipe(Effect.andThen(Deferred.succeed(terminated, undefined)), Effect.asVoid),
      });
      const first = yield* Effect.exit(protocol.request("first")).pipe(Effect.forkScoped);
      yield* Deferred.await(writing);
      const second = yield* Effect.exit(protocol.request("second")).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(failWrite, undefined);
      yield* Deferred.await(terminated);
      for (const result of [
        yield* Fiber.join(first),
        yield* Fiber.join(second),
        yield* Effect.exit(protocol.request("after")),
      ]) {
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(result.cause.reasons[0]).toMatchObject({
            error: { _tag: "ZCodeAppServerProcessExitedError" },
          });
      }
      yield* Queue.end(input);
      expect(exits).toBe(1);
    }).pipe(Effect.scoped),
);
