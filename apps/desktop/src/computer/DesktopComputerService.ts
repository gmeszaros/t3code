import * as Electron from "electron";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { createDesktopComputerAccess } from "./DesktopComputerAccess.ts";
import { ComputerDesktopBridge } from "./ComputerDesktopBridge.ts";
import type { ComputerGrant } from "./ComputerSession.ts";

export class DesktopComputerService extends Context.Service<
  DesktopComputerService,
  {
    readonly stop: Effect.Effect<void>;
    readonly status: Effect.Effect<ComputerGrant | undefined>;
    readonly connect: Effect.Effect<
      {
        readonly responses: Stream.Stream<Uint8Array>;
        readonly receive: (bytes: Uint8Array) => void;
        readonly close: () => void;
      },
      never,
      Scope.Scope
    >;
  }
>()("@t3tools/desktop/computer/DesktopComputerService") {}

export const layer = Layer.effect(
  DesktopComputerService,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const windows = yield* ElectronWindow.ElectronWindow;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    let current: ReturnType<typeof createDesktopComputerAccess> | undefined;
    let activeGrant: ComputerGrant | undefined;
    const connect = Effect.gen(function* () {
      current?.close();
      const responses = yield* Queue.bounded<Uint8Array>(8);
      const host = createDesktopComputerAccess({
        workerPath: environment.path.join(environment.dirname, "computer", "ComputerWorker.cjs"),
        dialog: {
          async showMessageBox(options) {
            const parent = await runPromise(windows.main);
            if (Option.isNone(parent) || parent.value.isDestroyed()) {
              return { response: 0, checkboxChecked: false };
            }
            // Unparented macOS dialogs run synchronously and ignore AbortSignal.
            return Electron.dialog.showMessageBox(parent.value, options);
          },
        },
        changed: (grant) => {
          if (current === host) activeGrant = grant;
        },
      });
      current = host;
      const bridge = new ComputerDesktopBridge(host, async (bytes) => {
        await runPromise(Queue.offer(responses, bytes));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          bridge.close();
          if (current === host) current = undefined;
        }).pipe(Effect.andThen(Queue.shutdown(responses))),
      );
      return {
        responses: Stream.fromQueue(responses),
        receive: (bytes: Uint8Array) => bridge.receive(bytes),
        close: () => bridge.close(),
      };
    });
    return DesktopComputerService.of({
      connect,
      stop: Effect.sync(() => current?.stop()),
      status: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (activeGrant && now >= activeGrant.expiresAt) current?.stop();
        return activeGrant;
      }),
    });
  }),
);
