import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { expect, it } from "@effect/vitest";

import * as ZCodeRuntime from "./ZCodeRuntime.ts";

// Live tests require explicit opt-in because they use the native account and quota.
// Vitest collects this module without an Effect runtime, so the skip decision
// does a plain probe of the well-known app-bundle locations.
function probeExists(candidate: string): boolean {
  const fs = require("node:fs") as { existsSync(path: string): boolean };
  return fs.existsSync(candidate);
}

const runtimeBundlePresent = (): boolean =>
  [
    `${process.env.HOME}/Applications/ZCode.app/Contents/MacOS/ZCode`,
    "/Applications/ZCode.app/Contents/MacOS/ZCode",
    `${process.env.HOME}/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`,
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  ].some(probeExists);

const runtimeInstalled = runtimeBundlePresent();

it.layer(NodeServices.layer)("ZCode app-server client (live runtime)", (it) => {
  it.effect.skipIf(process.env.T3CODE_ZCODE_LIVE_TESTS !== "1")(
    "handshakes, creates a session, subscribes, sends, and closes",
    () =>
      Effect.gen(function* () {
        if (!runtimeInstalled) {
          return;
        }
        const runtime = yield* ZCodeRuntime.resolveZCodeRuntime({});
        expect(runtime.kind).toBe("app-bundle");

        const fileSystem = yield* FileSystem.FileSystem;
        const runtimeCwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-zcode-live-" });
        const workspaceDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-zcode-live-",
        });

        const scope = yield* Scope.fork(yield* Scope.Scope);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawned = yield* ZCodeRuntime.spawnZCodeAppServer({
          runtime,
          cwd: runtimeCwd,
          environment: process.env,
          spawner,
          scope,
        });

        const capabilities = yield* spawned.client.runtimeCapabilities();
        expect(capabilities).toBeDefined();

        const create = yield* spawned.client.sessionCreate({
          workspace: { workspacePath: workspaceDir, workspaceKey: workspaceDir },
          mode: "build",
          persistence: "immediate",
          titleGenerationEnabled: false,
        });
        const sessionId = create.session?.sessionId;
        expect(sessionId).toBeDefined();
        expect(sessionId).toMatch(/^sess_/);

        yield* spawned.client.sessionSubscribe({
          sessionId: sessionId!,
          deliveryKind: "desktop-continuous",
        });

        const sent = yield* spawned.client.sessionSend({
          sessionId: sessionId!,
          content: "Reply with exactly: T3-PROBE-OK",
        });
        expect(sent.accepted).toBe(true);

        // A terminal event proves the protocol boundary even if this runtime
        // cannot resolve an account model; it does not prove a successful turn.
        const terminalEvent = yield* spawned.client.sessionEvents.pipe(
          Stream.filter((event) => event.sessionId === sessionId),
          Stream.filter((event) => event.type === "turn.completed" || event.type === "turn.failed"),
          Stream.runHead,
          Effect.timeoutOption("60 seconds"),
        );
        expect(Option.isSome(terminalEvent)).toBe(true);

        const list = yield* spawned.client.sessionList({
          workspace: { workspacePath: workspaceDir, workspaceKey: workspaceDir },
        });
        expect(list.sessions.some((session) => session.sessionId === sessionId)).toBe(true);

        yield* spawned.terminate;
      }).pipe(Effect.scoped),
    { timeout: 120_000 },
  );
});
