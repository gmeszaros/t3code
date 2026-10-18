// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test encrypts fixtures with the same node AES-GCM ciphers the reader consumes.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { DateTime, Effect, FileSystem, Path, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse, HttpClientError } from "effect/http";
import {
  decryptZCodeCredential,
  consumeZCodeResetCredit,
  readZCodeUsageLimits,
  zcodeQuotaWindows,
  zcodeResetWindows,
} from "./ZCodeUsageLimits.ts";
import { makeZCodeResetCreditConsumer } from "../Drivers/ZCodeDriver.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { ProviderInstanceId } from "@t3tools/contracts";
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

it.effect.each([
  ["five_hour", 200, 0, "fixture-user", true, "normal"],
  ["five_hour", 200, 0, "fixture-user", true, "lost"],
  ["five_hour", 200, 0, "fixture-user", true, "timeout"],
  ["five_hour", 200, 0, "other-user", false, "normal"],
  ["five_hour", 200, 0, "fixture-user", true, "refresh-failed"],
  ["five_hour", 200, 0, "fixture-user", false, "account-changed"],
  ["weekly", 200, 0, "fixture-user", true, "normal"],
  ["weekly", 403, 0, "fixture-user", false, "normal"],
  ["five_hour", 200, 12, "fixture-user", false, "normal"],
] as const)(
  "uses only the confirmed native reset window: %s/%s/%s/%s",
  ([resetWindowId, status, code, profileId, succeeds, mode]) =>
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
      const redeemed = new Set<string>();
      const postStarted = yield* Deferred.make<void>();
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
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
          if (status === 200 && code === 0) redeemed.add("stable-reset-key");
          if (mode === "timeout" && calls === 1) {
            yield* Deferred.succeed(postStarted, undefined);
            return yield* Effect.never;
          }
          if (mode === "lost" && calls === 1)
            return yield* new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: "synthetic credential-bearing failure",
              }),
            });
          return HttpClientResponse.fromWeb(
            request,
            Response.json(code === 0 ? { code, data: { used: true } } : { code }, { status }),
          );
        }),
      );
      if (profileId !== "fixture-user") {
        const refused = yield* consumeZCodeResetCredit({
          environment,
          resetWindowId,
          idempotencyKey: "stable-reset-key",
          profileId,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result);
        expect(refused._tag).toBe("Failure");
        expect(calls).toBe(0);
        return;
      }
      const result = yield* Effect.gen(function* () {
        // This is the consumer installed on the real driver, including account
        // coordinator, native credentials, network decoding and refresh boundary.
        const consume = yield* makeZCodeResetCreditConsumer({
          instanceId: ProviderInstanceId.make("zcode"),
          environment,
          refreshUsage:
            mode === "refresh-failed" ? Effect.fail("synthetic refresh failure") : Effect.void,
        });
        const expectedAccountIdentity = yield* consume.accountIdentity;
        expect(expectedAccountIdentity).toMatch(/^[a-f0-9]{64}$/);
        expect(expectedAccountIdentity).not.toContain("fixture-user");
        if (mode === "account-changed") {
          const stored = JSON.parse(yield* fs.readFileString(`${root}/credentials.json`));
          stored["oauth:zai:user_info"] = encrypt(JSON.stringify({ user_id: "changed-user" }));
          yield* fs.writeFileString(`${root}/credentials.json`, JSON.stringify(stored));
        }
        const attempt = consume(resetWindowId, {
          idempotencyKey: "stable-reset-key",
          expectedAccountIdentity,
        }).pipe(Effect.result);
        const first = yield* mode === "timeout"
          ? Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(attempt);
              yield* Deferred.await(postStarted);
              yield* TestClock.adjust("20 seconds");
              return yield* Fiber.join(fiber);
            })
          : attempt;
        if (mode === "lost" || mode === "timeout") {
          expect(first._tag).toBe("Failure");
          if (first._tag === "Failure") {
            expect(first.failure.redemption).toBe("unconfirmed");
            expect(JSON.stringify(first.failure)).not.toContain("credential-bearing");
          }
          expect(calls).toBe(1);
        }
        return first;
      }).pipe(
        Effect.provide(ResetCreditCoordinator.layerTest),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result._tag).toBe(
        mode === "lost" || mode === "timeout" ? "Failure" : succeeds ? "Success" : "Failure",
      );
      if (mode !== "lost" && mode !== "timeout")
        expect(calls).toBe(profileId === "fixture-user" && mode !== "account-changed" ? 1 : 0);
      if (result._tag === "Success") expect(result.success).toBe("reset");
      if (result._tag === "Failure" && code !== 0)
        expect(result.failure.redemption).toBe("refused");
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
      if (resetStatus === 200) {
        expect(limits.resetCreditWindowsUnavailable).toBeUndefined();
      } else {
        // An HTTP refusal is bounded fixed text; the raw response and its
        // error text never reach the snapshot.
        expect(limits.resetCreditWindowsUnavailable).toEqual({
          reason: "probeFailed",
          message: "Banked resets could not be read.",
        });
      }
      expect(yield* fs.readFileString(`${home}/.zcode/v2/credentials.json`)).toBe(
        yield* encodeStore(store),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("marks banked resets unreadable without the native sign-in, not as a failed probe", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-limits-test-" });
    yield* fs.makeDirectory(`${home}/.zcode/v2`, { recursive: true });
    yield* fs.writeFileString(
      `${home}/.zcode/v2/provider_config.json`,
      '{"config":{"defaultModelSelection":{"providerId":"account:zai-individual-coding-plan","modelId":"GLM-5.3"}}}',
    );
    yield* fs.writeFileString(
      `${home}/.zcode/v2/credentials.json`,
      yield* encodeStore({
        [`account-provider:${providerId}:identity`]: encrypt("synthetic-account"),
        [`account-provider:coding-plan:${providerId}:account:synthetic-account:api-key`]:
          encrypt("synthetic-api-token"),
      }),
    );
    const calls: string[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        calls.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ code: 200, data: { limits: [] } }),
        );
      }),
    );
    const limits = yield* readZCodeUsageLimits({
      enabled: true,
      environment: { HOME: home, ZCODE_CREDENTIAL_SECRET: secret },
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    // No native sign-in, so only the quota endpoint is probed and the reset
    // inventory is reported as invisible to this environment.
    expect(calls).toEqual(["https://api.z.ai/api/monitor/usage/quota/limit"]);
    expect(limits.resetCreditWindowsUnavailable?.reason).toBe("notSignedIn");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reports a provider business refusal for banked resets as a bounded probe failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-limits-test-" });
    yield* fs.makeDirectory(`${home}/.zcode/v2`, { recursive: true });
    yield* fs.writeFileString(
      `${home}/.zcode/v2/provider_config.json`,
      '{"config":{"defaultModelSelection":{"providerId":"account:zai-individual-coding-plan","modelId":"GLM-5.3"}}}',
    );
    yield* fs.writeFileString(
      `${home}/.zcode/v2/credentials.json`,
      yield* encodeStore({
        [`account-provider:${providerId}:identity`]: encrypt("synthetic-account"),
        [`account-provider:coding-plan:${providerId}:account:synthetic-account:api-key`]:
          encrypt("synthetic-api-token"),
        "oauth:active_provider": encrypt("zai"),
        "oauth:zai:access_token": encrypt("synthetic-account-token"),
        zcodejwttoken: encrypt("synthetic-zcode-token"),
      }),
    );
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url === "https://api.z.ai/api/monitor/usage/quota/limit") {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ code: 200, data: { limits: [] } }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ code: 3101, detail: "internal stack evidence" }, { status: 200 }),
        );
      }),
    );
    const limits = yield* readZCodeUsageLimits({
      enabled: true,
      environment: { HOME: home, ZCODE_CREDENTIAL_SECRET: secret },
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(limits.resetCreditWindows?.map((window) => window.availableCount)).toEqual([null, null]);
    expect(limits.resetCreditWindowsUnavailable).toEqual({
      reason: "probeFailed",
      message: "The provider refused to report banked resets.",
    });
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
