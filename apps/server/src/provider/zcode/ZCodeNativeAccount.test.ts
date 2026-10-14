import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schema } from "effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeZCodeNativeAccountReader } from "./ZCodeNativeAccount.ts";
import { resolveZCodeEnvironmentPaths } from "./ZCodeEnvironmentPaths.ts";
import {
  buildInitialZCodeProviderSnapshot,
  readDefaultModelSelection,
  readZCodeLoginState,
} from "./ZCodeProviderStatus.ts";

const providerId = "account:zai-individual-coding-plan";
const encodeStore = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

it.effect("exposes app-server models and the native goal without probing a disabled runtime", () =>
  buildInitialZCodeProviderSnapshot(
    { enabled: false },
    {
      HOME: "/home/native",
      ZCODE_DATA_BASE_DIR: "/isolated",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/selection/custom.json",
    },
  ).pipe(
    Effect.map((snapshot) => {
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        `${providerId}/GLM-5.3`,
        `${providerId}/GLM-5.3-Flash`,
      ]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["goal"]);
      expect(snapshot.auth).toEqual({ status: "unknown" });
    }),
    Effect.provide([
      FileSystem.layerNoop({
        exists: (file) => Effect.succeed(file === "/selection/custom.json"),
        readFileString: (file) => {
          expect(file).toBe("/selection/custom.json");
          return Effect.succeed(
            JSON.stringify({
              config: { defaultModelSelection: { providerId, modelId: "GLM-5.3-Flash" } },
            }),
          );
        },
      }),
      Path.layer,
    ]),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Must not probe a disabled runtime")),
    ),
  ),
);

it.effect.each([
  [
    {
      HOME: "/home/native",
      ZCODE_DATA_BASE_DIR: "/isolated",
      T3CODE_ZCODE_CREDENTIALS_FILE: " /account/credentials.json ",
    },
    "/account/credentials.json",
    "/isolated/.zcode/v2/provider_config.json",
  ],
  [
    { HOME: " /home/native " },
    "/home/native/.zcode/v2/credentials.json",
    "/home/native/.zcode/v2/provider_config.json",
  ],
  [
    { HOME: "/home/native", ZCODE_DATA_BASE_DIR: " /isolated " },
    "/isolated/.zcode/v2/credentials.json",
    "/isolated/.zcode/v2/provider_config.json",
  ],
  [
    { HOME: "/home/native", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: " /selection/custom.json " },
    "/home/native/.zcode/v2/credentials.json",
    "/selection/custom.json",
  ],
  [
    {
      HOME: "/home/native",
      ZCODE_DATA_BASE_DIR: "/isolated",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/selection/custom.json",
    },
    "/isolated/.zcode/v2/credentials.json",
    "/selection/custom.json",
  ],
  [
    { HOME: " ", ZCODE_DATA_BASE_DIR: " ", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: " " },
    "/fallback/.zcode/v2/credentials.json",
    "/fallback/.zcode/v2/provider_config.json",
  ],
] as const)(
  "uses one native environment for paths, account, login and model selection: %j",
  ([environment, credentialsPath, personalConfigPath]) =>
    Effect.gen(function* () {
      const reads: string[] = [];
      const store = yield* encodeStore({
        [`account-provider:${providerId}:identity`]: "synthetic-isolated-identity",
        [`account-provider:coding-plan:${providerId}:account:synthetic-isolated-identity:api-key`]:
          "synthetic-isolated-key",
      });
      const fileSystem = FileSystem.makeNoop({
        exists: (file) => Effect.succeed(file === credentialsPath || file === personalConfigPath),
        readFileString: (file) => {
          reads.push(file);
          if (file === credentialsPath) return Effect.succeed(store);
          if (file === personalConfigPath)
            return Effect.succeed(
              JSON.stringify({
                config: { defaultModelSelection: { providerId, modelId: "GLM-5.3" } },
              }),
            );
          if (file === "/vendor/catalog.json") return Effect.succeed('{"revision":30}');
          return Effect.die("Unexpected native environment read");
        },
      });
      yield* Effect.gen(function* () {
        expect(yield* resolveZCodeEnvironmentPaths(environment)).toMatchObject({
          credentialsPath,
          personalConfigPath,
        });
        const read = yield* makeZCodeNativeAccountReader(environment);
        const account = yield* read("/vendor/catalog.json");
        expect(account?.personalConfigPath).toBe(personalConfigPath);
        expect(account).toBeDefined();
        expect(JSON.stringify(account?.snapshot)).not.toContain("synthetic-isolated");
        expect(yield* readZCodeLoginState(environment)).toEqual({
          standaloneLogin: true,
          sharedSignIn: false,
        });
        expect(yield* readDefaultModelSelection(environment)).toEqual({
          providerId,
          modelId: "GLM-5.3",
        });
        expect(reads).toEqual([
          personalConfigPath,
          credentialsPath,
          "/vendor/catalog.json",
          credentialsPath,
          personalConfigPath,
        ]);
      }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
    }).pipe(
      Effect.provide(Path.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/fallback"),
    ),
);

it.effect("uses the native settings home and mirrors explicit isolated data roots", () =>
  Effect.gen(function* () {
    const explicitHome = yield* resolveZCodeEnvironmentPaths({
      HOME: "/home/native",
      ZCODE_DATA_BASE_DIR: "/isolated/data",
      ZCODE_DESKTOP_HOME_DIR: "/separate/settings-home",
    });
    expect(explicitHome.settingsPath).toBe("/separate/settings-home/.zcode/v2/setting.json");
    const isolatedHome = yield* resolveZCodeEnvironmentPaths({
      HOME: "/home/native",
      ZCODE_DATA_BASE_DIR: "/isolated/data",
    });
    expect(isolatedHome.settingsPath).toBe("/isolated/data/.zcode/v2/setting.json");
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("does not borrow HOME sign-in or selection when the isolated files are missing", () =>
  Effect.gen(function* () {
    const environment = { HOME: "/home/native", ZCODE_DATA_BASE_DIR: "/missing" };
    expect(yield* readZCodeLoginState(environment)).toEqual({
      standaloneLogin: false,
      sharedSignIn: false,
    });
    expect(yield* readDefaultModelSelection(environment)).toBeUndefined();
  }).pipe(
    Effect.provide([
      FileSystem.layerNoop({
        exists: (file) => Effect.succeed(file.startsWith("/home/native/")),
        readFileString: () => Effect.die("Must not read HOME account data"),
      }),
      Path.layer,
    ]),
  ),
);

it.live(
  "keeps credentials out of account snapshots, restricts requests, and follows credential rotation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-native-account-" });
      const root = `${home}/.zcode/v2`;
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.writeFileString(
        `${root}/provider_config.json`,
        '{"config":{"defaultModelSelection":{"providerId":"account:zai-individual-coding-plan"}}}',
      );
      yield* fs.writeFileString(`${home}/catalog.json`, '{"revision":30}');
      const identityKey = `account-provider:${providerId}:identity`;
      const apiKeyKey = `account-provider:coding-plan:${providerId}:account:synthetic:api-key`;
      const writeKey = (key: string) =>
        encodeStore({ [identityKey]: "synthetic", [apiKeyKey]: key }).pipe(
          Effect.flatMap((body) => fs.writeFileString(`${root}/credentials.json`, body)),
        );
      yield* writeKey("first-test-key");
      const read = yield* makeZCodeNativeAccountReader({ HOME: home });
      const account = yield* read(`${home}/catalog.json`);
      expect(account).toBeDefined();
      if (!account) return;
      expect(account.snapshot.providers[providerId]).toEqual({
        access: { type: "zhipu-account", entitled: true },
      });
      const request = {
        providerId,
        modelSelection: { providerId },
        accountAccess: { mode: "individual-coding-plan" },
      };
      expect(yield* account.runtimeHeaders({ ...request, providerId: "other" })).toMatchObject({
        headersApplied: false,
      });
      expect(
        yield* account.runtimeHeaders({ ...request, modelSelection: { providerId: "other" } }),
      ).toMatchObject({ headersApplied: false });
      expect(yield* account.runtimeHeaders(request)).toEqual({
        headersApplied: true,
        requestAuth: { apiKey: "first-test-key" },
      });
      yield* writeKey("rotated-test-key");
      expect(yield* account.runtimeHeaders(request)).toEqual({
        headersApplied: true,
        requestAuth: { apiKey: "rotated-test-key" },
      });
      yield* fs.writeFileString(`${root}/credentials.json`, "invalid-test-store");
      expect(yield* account.runtimeHeaders(request)).toMatchObject({ headersApplied: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("resolves official MCP auth only for the selected account and trusted endpoint", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-official-mcp-auth-" });
    const root = `${home}/.zcode/v2`;
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.writeFileString(
      `${root}/provider_config.json`,
      JSON.stringify({
        config: { defaultModelSelection: { providerId } },
      }),
    );
    yield* fs.writeFileString(`${home}/catalog.json`, '{"revision":30}');
    yield* fs.writeFileString(
      `${root}/setting.json`,
      JSON.stringify({
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
      }),
    );
    const store = yield* encodeStore({
      [`account-provider:${providerId}:identity`]: "fixture-account",
      [`account-provider:coding-plan:${providerId}:account:fixture-account:api-key`]:
        "fixture-api-key",
      "oauth:active_provider": "zai",
      "oauth:zai:user_info": JSON.stringify({ user_id: "fixture-user" }),
      "oauth:zai:access_token": "fixture-maas-jwt",
      zcodejwttoken: "fixture-zcode-jwt",
    });
    yield* fs.writeFileString(`${root}/credentials.json`, store);
    const account = yield* (yield* makeZCodeNativeAccountReader({ HOME: home }))(
      `${home}/catalog.json`,
    );
    expect(account).toBeDefined();
    if (!account) return;
    const params = {
      requestId: "request",
      workspace: { workspacePath: home, workspaceKey: home },
      pluginId: "plugin",
      mcpKey: "official",
      targetOrigin: "https://zcode.z.ai/mcp",
    };
    expect(yield* account.officialMcpAuthHeaders(params)).toEqual({
      ok: true,
      headers: {
        Authorization: "Bearer fixture-zcode-jwt",
        "X-Bigmodel-Authorization": "Bearer fixture-maas-jwt",
        "Bigmodel-Target-Type": "PERSONAL",
      },
    });
    expect(
      yield* account.officialMcpAuthHeaders({ ...params, targetOrigin: "https://evil.example" }),
    ).toEqual({
      ok: false,
      reason: "official_mcp_origin_untrusted",
    });
    yield* fs.writeFileString(
      `${root}/setting.json`,
      JSON.stringify({
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
      }),
    );
    expect(yield* account.officialMcpAuthHeaders(params)).toEqual({
      ok: false,
      reason: "official_auth_plan_required",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
