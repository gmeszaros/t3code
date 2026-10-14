import { createModelCapabilities } from "@t3tools/shared/model";
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveZCodeEnvironmentPaths } from "./ZCodeEnvironmentPaths.ts";
import { readZCodeAccountProfile } from "./ZCodeNativeAccount.ts";

import type { ZCodeResolvedRuntime, ZCodeRuntimeSettings } from "./ZCodeRuntime.ts";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import {
  makeZCodeChildArguments,
  makeZCodeChildEnvironment,
  resolveZCodeRuntime,
} from "./ZCodeRuntime.ts";

export const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  reportsContextWindow: true,
  supportsConversationRollback: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 15_000;

/** Credential-store keys that indicate a standalone (headless-capable) sign-in. */
const STANDALONE_IDENTITY_MARKER = ":identity";
const STANDALONE_API_KEY_MARKER = "account-provider:";
const SHARED_OAUTH_MARKER = "oauth:";

export interface ZCodeLoginState {
  /** A standalone login exists, so headless turns can resolve account models. */
  readonly standaloneLogin: boolean;
  /** Any sign-in artifacts exist (desktop OAuth session). */
  readonly sharedSignIn: boolean;
}

const CredentialFileSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeCredentialFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CredentialFileSchema),
);

/**
 * Reads only the key names of the shared ZCode credential store. Values are
 * never surfaced; presence of the standalone-account keys tells the driver
 * whether headless turns can resolve Coding Plan models.
 */
export const readZCodeLoginState = Effect.fn("t3-provider-zcode/readLoginState")(function* (
  environment: NodeJS.ProcessEnv | string,
): Effect.fn.Return<ZCodeLoginState, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const { credentialsPath } = yield* resolveZCodeEnvironmentPaths(
    typeof environment === "string" ? { HOME: environment } : environment,
  );
  const exists = yield* fileSystem
    .exists(credentialsPath)
    .pipe(Effect.catch(() => Effect.succeed(false)));
  if (!exists) {
    return { standaloneLogin: false, sharedSignIn: false };
  }
  const keys = yield* fileSystem.readFileString(credentialsPath).pipe(
    Effect.flatMap((raw) => decodeCredentialFile(raw)),
    Effect.map((decoded) => Object.keys(decoded)),
    Effect.catch(() => Effect.succeed([] as Array<string>)),
  );
  return {
    standaloneLogin: keys.some(
      (key) =>
        key.startsWith(STANDALONE_API_KEY_MARKER) && key.endsWith(STANDALONE_IDENTITY_MARKER),
    ),
    sharedSignIn: keys.some((key) => key.startsWith(SHARED_OAUTH_MARKER)),
  };
});

const DEFAULT_MODEL_IDS = ["GLM-5.3", "GLM-5.3-Flash"] as const;

export interface ZCodeDefaultModel {
  readonly providerId: string;
  readonly modelId: string;
}

const ProviderConfigSchema = Schema.Struct({
  config: Schema.optional(
    Schema.Struct({
      defaultModelSelection: Schema.optional(
        Schema.Struct({
          providerId: Schema.String,
          modelId: Schema.String,
        }),
      ),
    }),
  ),
});

const decodeProviderConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderConfigSchema),
);

/**
 * Reads the login-selected provider family for the subscription usage lookup.
 */
export const readDefaultModelSelection = (
  environment: NodeJS.ProcessEnv | string,
): Effect.Effect<ZCodeDefaultModel | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { personalConfigPath: configPath } = yield* resolveZCodeEnvironmentPaths(
      typeof environment === "string" ? { HOME: environment } : environment,
    );
    const exists = yield* fileSystem
      .exists(configPath)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (!exists) return undefined;
    const decoded = yield* fileSystem.readFileString(configPath).pipe(
      Effect.flatMap((raw) => decodeProviderConfig(raw)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const selection = decoded?.config?.defaultModelSelection;
    if (
      selection === undefined ||
      selection.providerId.length === 0 ||
      selection.modelId.length === 0
    ) {
      return undefined;
    }
    return { providerId: selection.providerId, modelId: selection.modelId };
  });

const ZCODE_MODEL_PROVIDER_ID = "account:zai-individual-coding-plan";

export const zcodeModelSlug = (modelId: string): string => `${ZCODE_MODEL_PROVIDER_ID}/${modelId}`;

const REASONING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningLevel",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
        { id: "max", label: "Max", isDefault: true },
      ],
      currentValue: "max",
    },
  ],
});

export const buildZCodeModels = (): ReadonlyArray<ServerProviderModel> =>
  DEFAULT_MODEL_IDS.map((modelId): ServerProviderModel => ({
    slug: zcodeModelSlug(modelId),
    name: modelId,
    isCustom: false,
    capabilities: REASONING_CAPABILITIES,
  }));

const parseZcodeVersion = (output: string): string | null =>
  output.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1] ?? null;

const probeRuntimeVersion = (
  runtime: ZCodeResolvedRuntime,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  string | null,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const args = makeZCodeChildArguments(runtime, environment);
    args.push("--version");
    const child = yield* spawner.spawn(
      ChildProcess.make(runtime.command, args, {
        env: Object.fromEntries(
          Object.entries(makeZCodeChildEnvironment(runtime, environment)).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        extendEnv: false,
      }),
    );
    const stdout = yield* collectStreamAsString(child.stdout);
    const exitCode = yield* child.exitCode.pipe(Effect.map(Number));
    return exitCode === 0 ? parseZcodeVersion(stdout) : null;
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.map(OptionGetOrNull));

const OptionGetOrNull = <A>(
  value: { readonly _tag: "None" } | { readonly _tag: "Some"; readonly value: A },
): A | null => (value._tag === "Some" ? value.value : null);

const snapshotDraft = (input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error" | "disabled";
  readonly auth: ServerProviderDraft["auth"];
  readonly message?: string;
  readonly nativeGoals?: boolean;
}): ServerProviderDraft => ({
  displayName: ZCODE_PRESENTATION.displayName,
  reportsContextWindow: ZCODE_PRESENTATION.reportsContextWindow,
  supportsConversationRollback: ZCODE_PRESENTATION.supportsConversationRollback,
  enabled: input.enabled,
  installed: input.installed,
  version: input.version,
  status: input.status,
  auth: input.auth,
  checkedAt: input.checkedAt,
  models: input.models,
  slashCommands: input.nativeGoals
    ? [
        {
          name: "goal",
          description: "Manage the native ZCode goal",
          input: { hint: "Objective, or show, pause, resume, clear" },
        },
      ]
    : [],
  skills: [],
  ...(input.message !== undefined ? { message: input.message } : {}),
});

export const buildInitialZCodeProviderSnapshot = (
  settings: ZCodeRuntimeSettings & { readonly enabled: boolean },
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  ServerProviderDraft,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = buildZCodeModels();

    if (!settings.enabled) {
      return snapshotDraft({
        nativeGoals: true,
        enabled: false,
        checkedAt,
        models,
        installed: false,
        version: null,
        status: "disabled",
        auth: { status: "unknown" },
        message: "ZCode is disabled in T3 Code settings.",
      });
    }

    const runtime = yield* resolveZCodeRuntime(settings);
    const version = yield* probeRuntimeVersion(runtime, environment).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => null),
    );
    const runtimeUsable = version !== null;

    const login = yield* readZCodeLoginState(environment);

    if (!runtimeUsable) {
      return snapshotDraft({
        nativeGoals: true,
        enabled: settings.enabled,
        checkedAt,
        models,
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Official ZCode runtime not found. Install the ZCode app or set a binary path in provider settings.",
      });
    }

    if (!login.standaloneLogin) {
      return snapshotDraft({
        nativeGoals: true,
        enabled: settings.enabled,
        checkedAt,
        models,
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated", type: "zai-oauth", label: "Z.AI account" },
        message: login.sharedSignIn
          ? "ZCode is signed in through the desktop app, but headless (CLI) turns need a one-time `zcode login` in a terminal."
          : "Run `zcode login` once in a terminal so T3 can start ZCode sessions headless.",
      });
    }

    const profile = yield* readZCodeAccountProfile(environment);
    return snapshotDraft({
      nativeGoals: true,
      enabled: settings.enabled,
      checkedAt,
      models,
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated", type: "zai-oauth", label: "Z.AI Coding Plan", ...profile },
    });
  });
