// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test encrypts fixtures with the same node AES-GCM ciphers the reader consumes.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Path, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  decryptZCodeCredential,
  consumeZCodeResetCredit,
  readZCodeUsageLimits,
  zcodeQuotaWindows,
  zcodeResetWindows,
} from "./ZCodeUsageLimits.ts";
import { readZCodeAccountProfile } from "./ZCodeNativeAccount.ts";

const secret = "synthetic-native-cipher-secret";
const providerId = "account:zai-individual-coding-plan";
const encodeStore = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
function encrypt(value: string): string {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv(
    "aes-256-gcm",
    NodeCrypto.createHash("sha256").update(secret).digest(),
    iv,
  );
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

it.live.each([
  ["five_hour", 200, 0, "fixture-user", true],
  ["weekly", 200, 0, "fixture-user", true],
  ["weekly", 403, 0, "fixture-user", false],
  ["five_hour", 200, 12, "fixture-user", false],
  ["five_hour", 200, 0, "other-user", false],
] as const)(
  "uses only the confirmed native reset window: %s/%s/%s/%s",
  ([resetWindowId, status, code, profileId, succeeds]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-reset-fixture-" });
      const root = `${home}/.zcode/v2`;
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.writeFileString(
        `${root}/provider_config.json`,
        JSON.stringify({ config: { defaultModelSelection: { providerId } } }),
      );
      yield* fs.writeFileString(
        `${root}/setting.json`,
        JSON.stringify({
          providerFamilyDomain: "zai",
          providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
        }),
      );
      yield* fs.writeFileString(
        `${root}/credentials.json`,
        yield* encodeStore({
          "oauth:active_provider": encrypt("zai"),
          "oauth:zai:user_info": encrypt(
            JSON.stringify({ user_id: "fixture-user", email: "person@example.test" }),
          ),
          "oauth:zai:access_token": encrypt("synthetic-maas-jwt"),
          zcodejwttoken: encrypt("synthetic-zcode-jwt"),
        }),
      );
      const environment = { HOME: home, ZCODE_CREDENTIAL_SECRET: secret };
      expect(yield* readZCodeAccountProfile(environment)).toEqual({
        profileId: "fixture-user",
        email: "person@example.test",
      });
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;
          expect(request.method).toBe("POST");
          expect(request.url).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/use");
          expect(request.headers.authorization).toBe("Bearer synthetic-zcode-jwt");
          expect(request.headers["x-bigmodel-authorization"]).toBe("synthetic-maas-jwt");
          expect(request.headers["bigmodel-target-type"]).toBe("PERSONAL");
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag === "Uint8Array")
            expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
              idempotency_key: "stable-reset-key",
              reset_type: resetWindowId === "weekly" ? "WEEK" : "FIVE_HOUR",
            });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ code, data: { used: true } }, { status }),
          );
        }),
      );
      const result = yield* consumeZCodeResetCredit({
        environment,
        resetWindowId,
        idempotencyKey: "stable-reset-key",
        profileId,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result);
      expect(result._tag).toBe(succeeds ? "Success" : "Failure");
      expect(calls).toBe(profileId === "fixture-user" ? 1 : 0);
      if (result._tag === "Success") expect(result.success).toBe("reset");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  [
    { HOME: "/home/native", ZCODE_DATA_BASE_DIR: " /isolated " },
    "/isolated/.zcode/v2/provider_config.json",
    "/isolated/.zcode/v2/credentials.json",
  ],
  [
    { HOME: "/home/native", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: " /selection/custom.json " },
    "/selection/custom.json",
    "/home/native/.zcode/v2/credentials.json",
  ],
  [
    {
      HOME: "/home/native",
      ZCODE_DATA_BASE_DIR: "/isolated",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/selection/custom.json",
    },
    "/selection/custom.json",
    "/isolated/.zcode/v2/credentials.json",
  ],
] as const)(
  "reads quota selection and credentials from the same environment: %j",
  ([environment, configPath, credentialsPath]) =>
    Effect.gen(function* () {
      const reads: string[] = [];
      const store = yield* encodeStore({
        [`account-provider:${providerId}:identity`]: encrypt("synthetic-account"),
        [`account-provider:coding-plan:${providerId}:account:synthetic-account:api-key`]:
          encrypt("synthetic-api-token"),
      });
      const fileSystem = FileSystem.makeNoop({
        exists: (file) => Effect.succeed(file === configPath),
        readFileString: (file) => {
          reads.push(file);
          if (file === configPath)
            return Effect.succeed(
              JSON.stringify({
                config: { defaultModelSelection: { providerId, modelId: "GLM-5.3" } },
              }),
            );
          if (file === credentialsPath) return Effect.succeed(store);
          return Effect.die("Unexpected quota environment read");
        },
      });
      let calls = 0;
      const client = HttpClient.make((request) => {
        calls++;
        expect(request.method).toBe("GET");
        expect(request.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
        expect(request.headers.authorization).toBe("synthetic-api-token");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              code: 200,
              data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 42 }] },
            }),
          ),
        );
      });
      const limits = yield* readZCodeUsageLimits({
        enabled: true,
        environment: { ...environment, ZCODE_CREDENTIAL_SECRET: secret },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(reads).toEqual([configPath, credentialsPath]);
      expect(calls).toBe(1);
      expect(limits.windows.map((window) => window.usedPercent)).toEqual([42]);
      expect(JSON.stringify(limits)).not.toContain("synthetic-");
    }).pipe(Effect.provide(Path.layer)),
);

it.effect("does not use HOME selection to authorize quota for an isolated credential store", () =>
  readZCodeUsageLimits({
    enabled: true,
    environment: { HOME: "/home/native", ZCODE_DATA_BASE_DIR: "/isolated" },
  }).pipe(
    Effect.map((limits) => {
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
    Effect.provide(
      FileSystem.layerNoop({
        exists: (file) => Effect.succeed(file.startsWith("/home/native/")),
        readFileString: () =>
          Effect.die("Must not borrow HOME selection or read isolated credentials"),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not request quota without an isolated selection")),
    ),
    Effect.provide(Path.layer),
  ),
);

it("reads the native authenticated ciphertext format and rejects wrong keys or versions", () => {
  const value = encrypt("synthetic-api-token");
  expect(decryptZCodeCredential(value, secret)).toBe("synthetic-api-token");
  expect(() => decryptZCodeCredential(value, "wrong-key")).toThrow();
  expect(() => decryptZCodeCredential("enc:v2:unknown", secret)).toThrow("Unsupported");
});

it("maps only documented five-hour and weekly windows and preserves unknown percentages", () => {
  expect(
    zcodeQuotaWindows([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 23, nextResetTime: 3000 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 81 },
      { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 50 },
      { type: "CREDIT_LIMIT", unit: 3, number: 5 },
    ]),
  ).toEqual([
    {
      id: "five_hour",
      kind: "session",
      label: "5-hour limit",
      windowDurationMins: 300,
      usedPercent: 23,
      resetsAt: "1970-01-01T00:00:03.000Z",
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly limit",
      windowDurationMins: 10080,
      usedPercent: 81,
    },
  ]);
  expect(
    zcodeResetWindows(
      {
        available_five_hour_resets: [{ expire_at: 999 }, { expire_at: 5000 }, { expire_at: 3000 }],
        available_week_resets: [],
      },
      1000,
    ),
  ).toEqual([
    {
      id: "five_hour",
      label: "5-hour resets",
      availableCount: 2,
      canRedeem: true,
      nextExpiresAt: "1970-01-01T00:00:03.000Z",
    },
    { id: "weekly", label: "Weekly resets", availableCount: 0, canRedeem: true },
  ]);
});

it.live.each([200, 403])(
  "uses only native read-only GET endpoints and handles reset HTTP %s without redeeming",
  (resetStatus) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-limits-test-" });
      yield* fs.makeDirectory(`${home}/.zcode/v2`, { recursive: true });
      yield* fs.writeFileString(
        `${home}/.zcode/v2/provider_config.json`,
        '{"config":{"defaultModelSelection":{"providerId":"account:zai-individual-coding-plan","modelId":"GLM-5.3"}}}',
      );
      const store = {
        [`account-provider:${providerId}:identity`]: encrypt("synthetic-account"),
        [`account-provider:coding-plan:${providerId}:account:synthetic-account:api-key`]:
          encrypt("synthetic-api-token"),
        "oauth:active_provider": encrypt("zai"),
        "oauth:zai:access_token": encrypt("synthetic-account-token"),
        zcodejwttoken: encrypt("synthetic-zcode-token"),
      };
      yield* fs.writeFileString(`${home}/.zcode/v2/credentials.json`, yield* encodeStore(store));
      const expires = Date.parse(DateTime.formatIso(yield* DateTime.now)) + 60_000;
      const calls: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.method).toBe("GET");
          calls.push(request.url);
          if (request.url === "https://api.z.ai/api/monitor/usage/quota/limit") {
            expect(request.headers.authorization).toBe("synthetic-api-token");
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                code: 200,
                data: {
                  limits: [
                    {
                      type: "CREDIT_LIMIT",
                      unit: 3,
                      number: 5,
                      percentage: 23,
                      nextResetTime: expires,
                    },
                    {
                      type: "CREDIT_LIMIT",
                      unit: 6,
                      number: 1,
                      percentage: 81,
                      nextResetTime: expires,
                    },
                  ],
                },
              }),
            );
          }
          expect(request.url).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/status");
          expect(request.headers.authorization).toBe("Bearer synthetic-zcode-token");
          expect(request.headers["x-bigmodel-authorization"]).toBe("synthetic-account-token");
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              resetStatus === 200
                ? {
                    code: 0,
                    data: {
                      available_five_hour_resets: [{ expire_at: expires }],
                      available_week_resets: [],
                    },
                  }
                : { code: 3101 },
              { status: resetStatus },
            ),
          );
        }),
      );
      const limits = yield* readZCodeUsageLimits({
        enabled: true,
        environment: { HOME: home, ZCODE_CREDENTIAL_SECRET: secret },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(calls).toHaveLength(2);
      expect(limits.windows.map((window) => window.usedPercent)).toEqual([23, 81]);
      expect(limits.resetCredits).toBeUndefined();
      expect(limits.resetCreditWindows?.map((window) => window.availableCount)).toEqual(
        resetStatus === 200 ? [1, 0] : [null, null],
      );
      expect(yield* fs.readFileString(`${home}/.zcode/v2/credentials.json`)).toBe(
        yield* encodeStore(store),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["{invalid-json", "enc:v1:invalid", ""])(
  "omits unreadable native account metadata: %s",
  (rawProfile) =>
    readZCodeAccountProfile({ HOME: "/synthetic" }).pipe(
      Effect.map((profile) => expect(profile).toBeUndefined()),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () =>
            Effect.succeed(
              JSON.stringify({ "oauth:active_provider": "zai", "oauth:zai:user_info": rawProfile }),
            ),
        }),
      ),
      Effect.provide(Path.layer),
    ),
);
