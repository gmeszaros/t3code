import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { applyPackagedLocalBuildEnvironment } from "./PackagedLocalBuild.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("starts a packaged Local build in its own backend and Chromium home", () =>
  Effect.gen(function* () {
    const env = { T3_LOCAL_BUILD: "0" };
    applyPackagedLocalBuildEnvironment(env, "/Users/alice");
    const local = yield* DesktopEnvironment.DesktopEnvironment.pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname:
            "/Applications/T3 Code (Local).app/Contents/Resources/app.asar/apps/desktop/dist-electron",
          homeDirectory: "/Users/alice",
          platform: "darwin",
          processArch: "arm64",
          appVersion: "0.0.45-local.1",
          appPath: "/Applications/T3 Code (Local).app/Contents/Resources/app.asar",
          isPackaged: true,
          resourcesPath: "/Applications/T3 Code (Local).app/Contents/Resources",
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env)))),
      ),
    );
    assert.equal(local.baseDir, "/Users/alice/.t3-zcode-test");
    assert.equal(local.appUserModelId, "com.t3tools.t3code.local");
    assert.equal(
      yield* resolveUserDataPath(local),
      "/Users/alice/.t3-zcode-test/electron/t3code-local",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("preserves an explicit test home and port", () => {
  const env = { T3CODE_HOME: "/tmp/acceptance", T3CODE_PORT: "49983" };
  applyPackagedLocalBuildEnvironment(env, "/Users/alice");
  assert.equal(env.T3CODE_HOME, "/tmp/acceptance");
  assert.equal(env.T3CODE_PORT, "49983");
});
