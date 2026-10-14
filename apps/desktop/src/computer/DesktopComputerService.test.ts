import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Electron from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ComputerDesktopRequest, ComputerDesktopResponse } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

const nativeDialog = vi.hoisted(() => vi.fn());
const nativeWorker = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ dialog: { showMessageBox: nativeDialog } }));
vi.mock("./ComputerProcess.ts", () => ({ startComputerProcess: nativeWorker }));

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DesktopComputerService, layer } from "./DesktopComputerService.ts";

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(ComputerDesktopRequest));
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(ComputerDesktopResponse));

it.effect(
  "parents native consent so pending reaches the backend before a decision and Stop aborts it",
  () =>
    Effect.gen(function* () {
      const parent = { isDestroyed: () => false } as Electron.BrowserWindow;
      const decision = Promise.withResolvers<Electron.MessageBoxReturnValue>();
      nativeDialog.mockReset().mockReturnValue(decision.promise);
      nativeWorker.mockReset().mockImplementation(() => ({
        resolveApplication: async () => ({ processId: 42, application: "Fixture App" }),
        close: () => undefined,
      }));
      const testLayer = layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            DesktopEnvironment.layer({
              dirname: "/fixture/apps/desktop/dist-electron",
              homeDirectory: "/fixture",
              platform: "darwin",
              processArch: "arm64",
              appVersion: "0.0.0",
              appPath: "/fixture",
              isPackaged: false,
              resourcesPath: "/fixture/resources",
              runningUnderArm64Translation: false,
            }).pipe(Layer.provide(DesktopConfig.layerTest({}))),
            Layer.mock(ElectronWindow.ElectronWindow)({
              main: Effect.succeed(Option.some(parent)),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* DesktopComputerService;
        const bridge = yield* service.connect;
        const response = yield* Deferred.make<Uint8Array>();
        yield* bridge.responses.pipe(
          Stream.runForEach((bytes) => Deferred.succeed(response, bytes)),
          Effect.forkScoped({ startImmediately: true }),
        );
        bridge.receive(
          new TextEncoder().encode(
            encodeRequest({
              id: "request",
              invocation: { owner: "fixture", threadTitle: "Fixture", readOnly: true },
              command: { kind: "requestAccess", application: "Fixture App" },
            }) + "\n",
          ),
        );
        const result = decodeResponse(new TextDecoder().decode(yield* Deferred.await(response)));
        assert.equal(result.result.kind, "pending");
        assert.strictEqual(nativeDialog.mock.calls[0]?.[0], parent);
        const options = nativeDialog.mock.calls[0]?.[1] as Electron.MessageBoxOptions;
        assert.isFalse(options.signal?.aborted);
        yield* service.stop;
        assert.isTrue(options.signal?.aborted);
        decision.resolve({ response: 1, checkboxChecked: false });
        yield* Effect.promise(() => decision.promise);
        assert.equal(nativeWorker.mock.calls.length, 1);
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
