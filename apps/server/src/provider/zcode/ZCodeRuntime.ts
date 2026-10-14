import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import type { ZCodeNativeAccount } from "./ZCodeNativeAccount.ts";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The pure synchronous spawn-environment builder uses host path semantics.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ZCodeAppServerClient from "./ZCodeAppServerClient.ts";
import * as ZCodeError from "./ZCodeProtocolErrors.ts";

export interface ZCodeRuntimeSettings {
  readonly binaryPath?: string | undefined;
  readonly launchArgs?: string | undefined;
}

export interface ZCodeResolvedRuntime {
  /** Executable that hosts the runtime (Electron binary or node). */
  readonly command: string;
  /** Arguments before the runtime entry script. */
  readonly prefixArgs: ReadonlyArray<string>;
  /** ZCode runtime entry script (zcode.cjs). */
  readonly entryScript: string | undefined;
  /** Bundled provider catalog shipped with the official app, when found. */
  readonly builtinProviderConfigFile: string | undefined;
  readonly kind: "app-bundle" | "custom";
}

export function makeZCodeChildEnvironment(
  runtime: ZCodeResolvedRuntime,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...environment };
  const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim();
  if (dataBaseDir) {
    // The vendor data root relocates account config, but CLI storage has separate defaults.
    if (!env.ZCODE_DESKTOP_HOME_DIR?.trim()) env.ZCODE_DESKTOP_HOME_DIR = dataBaseDir;
    if (!env.ZCODE_STORAGE_DIR?.trim())
      env.ZCODE_STORAGE_DIR = NodePath.join(dataBaseDir, ".zcode");
    if (!env.ZCODE_SESSION_DB_PATH?.trim() && !env.ZCODE_SESSION_DB?.trim())
      env.ZCODE_SESSION_DB_PATH = NodePath.join(dataBaseDir, ".zcode", "cli", "db", "db.sqlite");
  }
  if (runtime.kind !== "app-bundle") return env;
  env.ELECTRON_RUN_AS_NODE = "1";
  if (runtime.builtinProviderConfigFile !== undefined)
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = runtime.builtinProviderConfigFile;
  const preload = environment.T3CODE_ZCODE_NODE_PRELOAD;
  if (preload) {
    // NODE_OPTIONS also reaches the runtime's Node REPL helper children.
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require ${JSON.stringify(preload)}`]
      .filter(Boolean)
      .join(" ");
  }
  return env;
}

export function makeZCodeChildArguments(
  runtime: ZCodeResolvedRuntime,
  environment: NodeJS.ProcessEnv,
): Array<string> {
  const preload = runtime.kind === "app-bundle" ? environment.T3CODE_ZCODE_NODE_PRELOAD : undefined;
  return [
    ...runtime.prefixArgs,
    // Packaged Electron may ignore NODE_OPTIONS; its Node CLI accepts --require.
    ...(preload ? ["--require", preload] : []),
    ...(runtime.kind === "app-bundle" && runtime.entryScript !== undefined
      ? [runtime.entryScript]
      : []),
  ];
}

const APP_BUNDLE_CANDIDATES = [
  "~/Applications/ZCode.app/Contents",
  "/Applications/ZCode.app/Contents",
];

const APP_BUILTIN_CATALOG_CANDIDATES = [
  "~/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json",
  "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json",
];

const expandHome = (candidate: string, home: string): string =>
  candidate === "~"
    ? home
    : candidate.startsWith("~/")
      ? `${home}/${candidate.slice(2)}`
      : candidate;

const firstExisting = Effect.fn("t3-provider-zcode/firstExisting")(function* (
  fileSystem: FileSystem.FileSystem,
  candidates: ReadonlyArray<string>,
  home: string,
): Effect.fn.Return<string | undefined> {
  for (const candidate of candidates) {
    const expanded = expandHome(candidate, home);
    if (yield* fileSystem.exists(expanded).pipe(Effect.catch(() => Effect.succeed(false)))) {
      return expanded;
    }
  }
  return undefined;
});

/**
 * Resolves the official ZCode runtime. The installed desktop app bundle is
 * the default (its Electron binary runs `zcode.cjs` in node mode), keeping
 * the signed vendor runtime untouched; a configured `binaryPath` overrides
 * it for custom installs.
 */
export const resolveZCodeRuntime = Effect.fn("t3-provider-zcode/resolveZCodeRuntime")(function* (
  settings: ZCodeRuntimeSettings,
): Effect.fn.Return<ZCodeResolvedRuntime, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The desktop backend sanitizes env; homedir() is stable there.
  const home = NodeOS.homedir();

  // The contract's bare default requests bundle discovery. Other configured
  // names may be executables on PATH and must not silently select the bundle.
  const configuredBinary = settings.binaryPath?.trim();
  const isCustomBinary =
    configuredBinary !== undefined && configuredBinary.length > 0 && configuredBinary !== "zcode";
  if (isCustomBinary) {
    const binaryPath = expandHome(configuredBinary, home);
    return {
      command: binaryPath,
      prefixArgs: [],
      entryScript: undefined,
      builtinProviderConfigFile: yield* firstExisting(
        fileSystem,
        APP_BUILTIN_CATALOG_CANDIDATES,
        home,
      ),
      kind: "custom",
    };
  }

  for (const candidate of APP_BUNDLE_CANDIDATES) {
    const contents = expandHome(candidate, home);
    const command = path.join(contents, "MacOS", "ZCode");
    const entryScript = path.join(contents, "Resources", "glm", "zcode.cjs");
    const builtinProviderConfigFile = path.join(
      contents,
      "Resources",
      "config",
      "provider",
      "zcode-builtin.json",
    );
    const complete = yield* Effect.forEach(
      [command, entryScript, builtinProviderConfigFile],
      (file) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false)),
    );
    if (complete.every(Boolean)) {
      return {
        command,
        prefixArgs: [],
        entryScript,
        builtinProviderConfigFile,
        kind: "app-bundle",
      };
    }
  }

  // An incomplete app must never become a custom command: that launches its GUI.
  return {
    command: "zcode",
    prefixArgs: [],
    entryScript: undefined,
    builtinProviderConfigFile: undefined,
    kind: "custom",
  };
});

export interface ZCodeSpawnedSession {
  readonly client: ZCodeAppServerClient.ZCodeAppServerClientService;
  /** Terminates the app-server child (idempotent per child lifetime). */
  readonly terminate: Effect.Effect<void>;
}

export interface ZCodeSpawnInput {
  readonly runtime: ZCodeResolvedRuntime;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly launchArgs?: string | undefined;
  readonly clientOptions?: ZCodeAppServerClient.ZCodeAppServerClientOptions;
  readonly nativeAccount?: ZCodeNativeAccount | undefined;
  /** Spawner passed explicitly so this effect keeps an empty service channel. */
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Scope that owns the spawned child's lifetime; closed by the caller. */
  readonly scope: Scope.Closeable;
}

export const ZCODE_APP_SERVER_ARGS = ["app-server", "--stdio"] as const;

/**
 * Spawns `zcode app-server --stdio` from the official runtime and returns a
 * typed protocol client. Native storage uses the configured data root; account
 * material is supplied by the read-only native account reader when available.
 */
export const spawnZCodeAppServer = Effect.fn("t3-provider-zcode/spawnZCodeAppServer")(function* (
  input: ZCodeSpawnInput,
): Effect.fn.Return<ZCodeSpawnedSession, ZCodeError.ZCodeAppServerError> {
  const { runtime, cwd, environment, spawner, scope } = input;

  const extraArgs = tokenizeCliArgs(input.launchArgs);

  const args = makeZCodeChildArguments(runtime, environment);
  args.push(...ZCODE_APP_SERVER_ARGS, ...extraArgs, "--cwd", cwd);

  const env = makeZCodeChildEnvironment(runtime, environment);
  if (runtime.kind === "app-bundle" && input.nativeAccount)
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = input.nativeAccount.personalConfigPath;

  const command = ChildProcess.make(runtime.command, args, {
    cwd,
    env: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    extendEnv: false,
  });
  const handle = yield* spawner.spawn(command).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.mapError(
      (cause) => new ZCodeError.ZCodeAppServerSpawnError({ command: runtime.command, cause }),
    ),
  );

  // The protocol client drains stderr itself; keep this handle's stderr from
  // backpressuring the child.
  yield* Stream.runDrain(handle.stderr).pipe(
    Effect.ignore,
    Effect.forkScoped,
    Effect.provideService(Scope.Scope, scope),
  );

  const client = yield* ZCodeAppServerClient.makeClientFromHandle(handle, {
    ...input.clientOptions,
    ...(input.nativeAccount
      ? { onProviderRuntimeHeaders: input.nativeAccount.runtimeHeaders }
      : {}),
  }).pipe(Effect.provideService(Scope.Scope, scope));
  if (input.nativeAccount)
    yield* client.request("provider/updateAccountConfig", input.nativeAccount.snapshot);
  return {
    client,
    terminate: handle.kill().pipe(Effect.ignore),
  };
});
