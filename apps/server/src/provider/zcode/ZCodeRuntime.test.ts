import { assert, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  makeZCodeChildArguments,
  makeZCodeChildEnvironment,
  resolveZCodeRuntime,
  type ZCodeResolvedRuntime,
} from "./ZCodeRuntime.ts";

const runtime: ZCodeResolvedRuntime = {
  kind: "app-bundle",
  command:
    "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper",
  entryScript: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  prefixArgs: [],
  builtinProviderConfigFile:
    "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json",
};

it("isolates CLI session and artifact storage when the native data root is relocated", () => {
  const parent = { ZCODE_DATA_BASE_DIR: "/isolated/native-data" };
  const child = makeZCodeChildEnvironment(runtime, parent);
  assert.equal(child.ZCODE_STORAGE_DIR, "/isolated/native-data/.zcode");
  assert.equal(child.ZCODE_SESSION_DB_PATH, "/isolated/native-data/.zcode/cli/db/db.sqlite");
  assert.equal(child.ZCODE_DESKTOP_HOME_DIR, "/isolated/native-data");
  assert.deepEqual(parent, { ZCODE_DATA_BASE_DIR: "/isolated/native-data" });
  assert.equal(makeZCodeChildEnvironment(runtime, {}).ZCODE_STORAGE_DIR, undefined);
  assert.equal(makeZCodeChildEnvironment(runtime, {}).ZCODE_SESSION_DB_PATH, undefined);
  const standalone = makeZCodeChildEnvironment({ ...runtime, kind: "custom" }, parent);
  assert.equal(standalone.ZCODE_STORAGE_DIR, child.ZCODE_STORAGE_DIR);
  assert.equal(standalone.ZCODE_SESSION_DB_PATH, child.ZCODE_SESSION_DB_PATH);
  assert.equal(standalone.ELECTRON_RUN_AS_NODE, undefined);
});

it("preserves explicit native storage overrides", () => {
  for (const explicit of [
    { ZCODE_SESSION_DB_PATH: "/separate/session.sqlite" },
    { ZCODE_SESSION_DB: "/separate/session.sqlite" },
  ]) {
    const child = makeZCodeChildEnvironment(runtime, {
      ZCODE_DATA_BASE_DIR: "/isolated/native-data",
      ZCODE_STORAGE_DIR: "/separate/artifacts",
      ...explicit,
    });
    assert.equal(child.ZCODE_STORAGE_DIR, "/separate/artifacts");
    assert.equal(child.ZCODE_DESKTOP_HOME_DIR, "/isolated/native-data");
    for (const [key, value] of Object.entries(explicit)) assert.equal(child[key], value);
    if ("ZCODE_SESSION_DB" in explicit) assert.equal(child.ZCODE_SESSION_DB_PATH, undefined);
  }
});

it("forwards the desktop preload to bundled runtime helpers without changing the parent environment", () => {
  const parent = {
    T3CODE_ZCODE_NODE_PRELOAD: "/T3 Code/zcode/HeadlessPreload.cjs",
    NODE_OPTIONS: "--max-old-space-size=4096",
  };
  const child = makeZCodeChildEnvironment(runtime, parent);
  assert.equal(child.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(child.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, runtime.builtinProviderConfigFile);
  assert.equal(
    child.NODE_OPTIONS,
    '--max-old-space-size=4096 --require "/T3 Code/zcode/HeadlessPreload.cjs"',
  );
  assert.equal(parent.NODE_OPTIONS, "--max-old-space-size=4096");
});

const localBundle: ZCodeResolvedRuntime = {
  ...runtime,
  command: `${NodeOS.homedir()}${runtime.command}`,
  entryScript: `${NodeOS.homedir()}${runtime.entryScript}`,
  builtinProviderConfigFile: `${NodeOS.homedir()}${runtime.builtinProviderConfigFile}`,
};
const bundleFiles = (bundle: ZCodeResolvedRuntime) => [
  bundle.command,
  bundle.entryScript!,
  bundle.builtinProviderConfigFile!,
];

it.effect.each([
  [
    "prefers the complete local bundle",
    [...bundleFiles(localBundle), ...bundleFiles(runtime)],
    localBundle,
  ],
  ["skips a local executable-only bundle", [localBundle.command, ...bundleFiles(runtime)], runtime],
  [
    "skips a local script-only bundle",
    [localBundle.entryScript!, ...bundleFiles(runtime)],
    runtime,
  ],
  [
    "skips a local bundle missing its catalog",
    [localBundle.command, localBundle.entryScript!, ...bundleFiles(runtime)],
    runtime,
  ],
] as const)("%s", ([_name, files, expected]) =>
  resolveZCodeRuntime({ binaryPath: "zcode" }).pipe(
    Effect.map((resolved) => {
      assert.deepEqual(resolved, expected);
      assert.equal(makeZCodeChildEnvironment(resolved, {}).ELECTRON_RUN_AS_NODE, "1");
      assert.deepEqual(makeZCodeChildArguments(resolved, {}), [expected.entryScript]);
    }),
    Effect.provide([
      FileSystem.layerNoop({ exists: (file) => Effect.succeed(files.includes(file)) }),
      Path.layer,
    ]),
  ),
);

it.effect.each([
  ["an executable alone", [localBundle.command]],
  [
    "a main-app executable without a background helper",
    [
      "/Applications/ZCode.app/Contents/MacOS/ZCode",
      runtime.entryScript!,
      runtime.builtinProviderConfigFile!,
    ],
  ],
  ["a script alone", [runtime.entryScript!]],
  ["a bundle missing its catalog", [localBundle.command, localBundle.entryScript!]],
  [
    "files split across bundles",
    [localBundle.command, runtime.entryScript!, runtime.builtinProviderConfigFile!],
  ],
  ["no installed bundle", []],
] as const)("falls back to the CLI for %s without launching the GUI", ([_name, files]) =>
  resolveZCodeRuntime({}).pipe(
    Effect.map((resolved) => {
      assert.deepEqual(resolved, {
        command: "zcode",
        prefixArgs: [],
        entryScript: undefined,
        builtinProviderConfigFile: undefined,
        kind: "custom",
      });
      assert.deepEqual(makeZCodeChildArguments(resolved, {}), []);
      assert.deepEqual(makeZCodeChildEnvironment(resolved, {}), {});
    }),
    Effect.provide([
      FileSystem.layerNoop({
        exists: (file) => Effect.succeed(files.some((existing) => existing === file)),
      }),
      Path.layer,
    ]),
  ),
);

it.effect.each([
  ["remote-zcode", "remote-zcode"],
  [" ~/bin/zcode ", `${NodeOS.homedir()}/bin/zcode`],
  ["/custom/zcode", "/custom/zcode"],
] as const)("preserves the explicit custom executable %s", ([binaryPath, command]) =>
  resolveZCodeRuntime({ binaryPath }).pipe(
    Effect.map((resolved) => {
      assert.deepEqual(resolved, {
        command,
        prefixArgs: [],
        entryScript: undefined,
        builtinProviderConfigFile: runtime.builtinProviderConfigFile,
        kind: "custom",
      });
      assert.deepEqual(makeZCodeChildArguments(resolved, {}), []);
      assert.deepEqual(makeZCodeChildEnvironment(resolved, {}), {});
    }),
    Effect.provide([
      FileSystem.layerNoop({
        exists: (file) => Effect.succeed(bundleFiles(runtime).includes(file)),
      }),
      Path.layer,
    ]),
  ),
);

it("preserves standalone and remote runtimes without a desktop preload", () => {
  const parent = { NODE_OPTIONS: "--max-old-space-size=4096" };
  assert.equal(makeZCodeChildEnvironment(runtime, parent).NODE_OPTIONS, parent.NODE_OPTIONS);
  assert.deepEqual(
    makeZCodeChildEnvironment(
      { ...runtime, kind: "custom" },
      { ...parent, T3CODE_ZCODE_NODE_PRELOAD: "/preload.cjs" },
    ),
    { ...parent, T3CODE_ZCODE_NODE_PRELOAD: "/preload.cjs" },
  );
});

it("preloads before the vendor entry script even when Electron ignores NODE_OPTIONS", () => {
  assert.deepEqual(
    makeZCodeChildArguments(runtime, { T3CODE_ZCODE_NODE_PRELOAD: "/T3 Code/preload.cjs" }),
    ["--require", "/T3 Code/preload.cjs", runtime.entryScript],
  );
  assert.deepEqual(makeZCodeChildArguments(runtime, {}), [runtime.entryScript]);
  assert.deepEqual(
    makeZCodeChildArguments(
      { ...runtime, kind: "custom", prefixArgs: ["--custom"] },
      { T3CODE_ZCODE_NODE_PRELOAD: "/preload.cjs" },
    ),
    ["--custom"],
  );
});
