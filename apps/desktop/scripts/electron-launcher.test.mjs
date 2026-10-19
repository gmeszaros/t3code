import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import {
  makeDevelopmentEnvironmentScript,
  desktopDir,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveLauncherIdentity,
  resolveMacBundleInfoPlistStrings,
  resolveMacCodeSignArguments,
  resolveMacLauncherIconPaths,
  resolveMacLauncherPaths,
  writeDevelopmentLauncherScript,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone test compiles platform-native code.
  it.runIf(NodeOS.platform() === "darwin")(
    "forwards protocol and quoted arguments through the native macOS launcher",
    () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-launcher-"));
      try {
        const paths = resolveMacLauncherPaths(NodePath.join(directory, "Test App.app"));
        NodeFS.mkdirSync(NodePath.dirname(paths.launcherBinaryPath), { recursive: true });
        NodeFS.mkdirSync(NodePath.dirname(paths.launcherScriptPath), { recursive: true });
        NodeFS.writeFileSync(paths.launcherScriptPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
        const compiled = NodeChildProcess.spawnSync(
          "xcrun",
          [
            "clang",
            "-Wall",
            "-Wextra",
            "-Werror",
            NodePath.join(desktopDir, "scripts", "macos-launcher.c"),
            "-o",
            paths.launcherBinaryPath,
          ],
          { encoding: "utf8" },
        );
        assert.equal(compiled.status, 0, compiled.stderr);
        const argumentsToForward = ["t3code-local://open/project", "space 'quote' $literal"];
        const launched = NodeChildProcess.spawnSync(paths.launcherBinaryPath, argumentsToForward, {
          cwd: directory,
          encoding: "utf8",
        });
        assert.equal(launched.status, 0, launched.stderr);
        assert.equal(launched.stdout, argumentsToForward.join("\n") + "\n");
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("isolates local builds from production app identity and protocol handling", () => {
    const local = resolveLauncherIdentity({ T3_LOCAL_BUILD: "1" });
    const production = resolveLauncherIdentity({});
    assert.equal(local.displayName, "T3 Code (Local)");
    assert.notEqual(local.bundleId, production.bundleId);
    assert.deepEqual(local.protocolSchemes, ["t3code-local"]);
    assert.deepEqual(production.protocolSchemes, ["t3code"]);
    assert.equal(
      resolveLauncherIdentity(
        { T3_LOCAL_BUILD: "1", VITE_DEV_SERVER_URL: "http://localhost" },
        "repo",
      ).bundleId,
      "com.t3tools.t3code.dev.repo",
    );
  });
  it("uses captured values only as fallbacks for a live runner environment", () => {
    const environmentScript = makeDevelopmentEnvironmentScript({
      VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
      T3CODE_PORT: "16566",
      T3CODE_HOME: "/tmp/t3",
      T3CODE_OTLP_PROTOCOL: "http/protobuf",
    });

    assert.include(
      environmentScript,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.include(
      environmentScript,
      "if [ -z \"${T3CODE_OTLP_PROTOCOL:-}\" ]; then export T3CODE_OTLP_PROTOCOL='http/protobuf'; fi",
    );
    assert.notInclude(environmentScript, "\nexport VITE_DEV_SERVER_URL=");
  });

  it("preserves local profile and data home for launches from Finder", () => {
    const environmentScript = makeDevelopmentEnvironmentScript({
      T3_LOCAL_BUILD: "1",
      T3CODE_HOME: "/tmp/local-t3-home",
    });
    assert.include(environmentScript, "export T3_LOCAL_BUILD='1'");
    assert.include(environmentScript, "export T3CODE_HOME='/tmp/local-t3-home'");
    assert.notInclude(environmentScript, "export VITE_DEV_SERVER_URL=");
  });

  it("keeps the launcher script free of volatile environment values", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });

    assert.include(
      script,
      "if [ -f '/repo/apps/desktop/.electron-runtime/dev-environment.sh' ]; then . '/repo/apps/desktop/.electron-runtime/dev-environment.sh'; fi",
    );
    assert.notInclude(script, "VITE_DEV_SERVER_URL");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app",
      "T3 Code (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "T3 Code (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/T3 Code (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });

  it("declares why the macOS app needs protected access", () => {
    const values = resolveMacBundleInfoPlistStrings("T3 Code (Dev) Launcher");

    assert.equal(
      values.NSAppleEventsUsageDescription,
      "T3 Code allows agent tools to connect to and control applications you approve.",
    );

    assert.equal(
      values.NSScreenCaptureUsageDescription,
      "T3 Code captures the active window when you use the snapshot shortcut.",
    );
    assert.equal(
      values.NSDocumentsFolderUsageDescription,
      "T3 Code reads project files you open in the desktop app.",
    );
  });

  it("ad-hoc signs the complete development app bundle", () => {
    assert.deepEqual(resolveMacCodeSignArguments("/runtime/T3 Code (Dev).app"), [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      NodePath.join(desktopDir, "resources", "entitlements.local.mac.plist"),
      "--timestamp=none",
      "/runtime/T3 Code (Dev).app",
    ]);
  });

  it("restores execute permissions on an unchanged launcher", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-launcher-"));
    const launcherPath = NodePath.join(directory, "launcher");
    try {
      writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron");
      NodeFS.chmodSync(launcherPath, 0o644);

      assert.isFalse(writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron"));
      assert.equal(NodeFS.statSync(launcherPath).mode & 0o777, 0o755);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives launcher icons from canonical development and production assets", () => {
    const development = resolveMacLauncherIconPaths("/runtime", true);
    const production = resolveMacLauncherIconPaths("/runtime", false);

    assert.match(development.sourceIconPath, /assets[\\/]dev[\\/]blueprint-macos-1024\.png$/);
    assert.equal(development.generatedIconPath, "/runtime/icon-dev.icns");
    assert.match(production.sourceIconPath, /assets[\\/]prod[\\/]black-macos-1024\.png$/);
    assert.equal(production.generatedIconPath, "/runtime/icon-prod.icns");
  });
});
