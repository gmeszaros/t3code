// @effect-diagnostics nodeBuiltinImport:off -- Desktop-owned inherited pipes, never network addresses.
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import type { ComputerDesktopRequest, ComputerDesktopResponse } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { ComputerConnection } from "./ComputerConnection.ts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

export function computerOwner(
  scope: Pick<
    McpProviderSessionConfig,
    "environmentId" | "threadId" | "providerInstanceId" | "providerSessionId"
  >,
): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        scope.environmentId,
        scope.threadId,
        scope.providerInstanceId,
        scope.providerSessionId,
      ]),
    )
    .digest("hex");
}

export class ComputerUnavailable extends Schema.TaggedError<ComputerUnavailable>()(
  "ComputerUnavailable",
  {
    message: Schema.String,
  },
) {}

export class DesktopComputerClient extends Context.Service<
  DesktopComputerClient,
  {
    readonly available: boolean;
    readonly invoke: (
      input: Omit<ComputerDesktopRequest, "id">,
    ) => Effect.Effect<ComputerDesktopResponse["result"], ComputerUnavailable>;
  }
>()("t3/mcp/DesktopComputerClient") {}

export const layer = Layer.effect(
  DesktopComputerClient,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const mcpSessions = yield* McpProviderSessions;
    const inputFd = config.desktopComputerResponseFd;
    const outputFd = config.desktopComputerRequestFd;
    if (config.mode !== "desktop" || inputFd === undefined || outputFd === undefined) {
      return DesktopComputerClient.of({
        available: false,
        invoke: () =>
          Effect.fail(
            new ComputerUnavailable({
              message: "Computer access requires this environment's local T3 desktop.",
            }),
          ),
      });
    }
    // fs streams can leave a blocking read alive after destroy; pipe sockets close immediately.
    const input = new NodeNet.Socket({ fd: inputFd, readable: true, writable: false });
    const output = new NodeNet.Socket({ fd: outputFd, readable: false, writable: true });
    const connection = new ComputerConnection(
      (bytes) =>
        new Promise<void>((resolve, reject) => {
          output.write(bytes, (error) => (error ? reject(error) : resolve()));
        }),
    );
    let disconnected = false;
    const close = () => {
      disconnected = true;
      connection.close();
      input.destroy();
      output.destroy();
    };
    const unsubscribe = yield* mcpSessions.subscribeRevocations((session) => {
      void connection.stopOwner(computerOwner(session));
    });
    input.on("data", (chunk) =>
      connection.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    input.once("end", close);
    input.once("error", close);
    output.once("error", close);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribe();
        close();
      }),
    );
    return DesktopComputerClient.of({
      get available() {
        return !disconnected;
      },
      invoke: (request) =>
        Effect.tryPromise({
          try: (signal) => connection.request({ ...request, id: NodeCrypto.randomUUID() }, signal),
          catch: () =>
            new ComputerUnavailable({
              message: "Computer access stopped or the local desktop disconnected.",
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "90 seconds",
            orElse: () =>
              Effect.fail(
                new ComputerUnavailable({
                  message: "Computer request timed out and access was revoked.",
                }),
              ),
          }),
        ),
    });
  }),
);
