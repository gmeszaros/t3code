import { decryptZCodeCredential, makeZCodeNativeAccountReader } from "./ZCodeNativeAccount.ts";
export { decryptZCodeCredential } from "./ZCodeNativeAccount.ts";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type {
  ServerProviderResetCreditWindow,
  ServerProviderResetCreditWindowsUnavailable,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { DateTime, Effect, FileSystem, Redacted, Schema } from "effect";
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { readDefaultModelSelection } from "./ZCodeProviderStatus.ts";
import { resolveZCodeEnvironmentPaths } from "./ZCodeEnvironmentPaths.ts";

const PROVIDER_ID = "account:zai-individual-coding-plan";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const RESET_STATUS_URL = "https://zcode.z.ai/api/v1/coding-plan/reset/status";
const decodeStore = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const EpochMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }),
);
const QuotaEnvelope = Schema.Struct({
  code: Schema.Number,
  data: Schema.Struct({
    limits: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        unit: Schema.optional(Schema.Number),
        number: Schema.optional(Schema.Number),
        percentage: Schema.optional(Schema.Finite),
        nextResetTime: Schema.optional(EpochMillis),
      }),
    ),
  }),
});
const ResetEnvelope = Schema.Struct({
  code: Schema.Number,
  // A refusal carries no data; only an acceptance names the banked resets.
  data: Schema.optional(
    Schema.Struct({
      available_five_hour_resets: Schema.Array(Schema.Struct({ expire_at: EpochMillis })),
      available_week_resets: Schema.Array(Schema.Struct({ expire_at: EpochMillis })),
    }),
  ),
});
const decodeQuota = HttpClientResponse.schemaBodyJson(QuotaEnvelope);
const decodeResets = HttpClientResponse.schemaBodyJson(ResetEnvelope);
const unknownResetWindows: ReadonlyArray<ServerProviderResetCreditWindow> = [
  { id: "five_hour", label: "5-hour resets", availableCount: null },
  { id: "weekly", label: "Weekly resets", availableCount: null },
];
/** A reset-status read that could not say how many resets are banked. */
interface ResetStatusRead {
  readonly windows: ReadonlyArray<ServerProviderResetCreditWindow>;
  readonly unavailable?: ServerProviderResetCreditWindowsUnavailable;
}
const unsignedResetStatus = (): ResetStatusRead => ({
  windows: unknownResetWindows,
  unavailable: {
    reason: "notSignedIn",
    message: "Sign in with the native Z.AI Coding Plan account to see banked resets.",
  },
});
// The reason is fixed text: the raw HTTP or transport error can carry
// credentials, so it never reaches the snapshot.
const failedResetStatus = (message: string): ResetStatusRead => ({
  windows: unknownResetWindows,
  unavailable: { reason: "probeFailed", message },
});

export const zcodeQuotaWindows = (
  limits: (typeof QuotaEnvelope.Type)["data"]["limits"],
): ReadonlyArray<ServerProviderUsageWindow> =>
  limits.flatMap((limit): ServerProviderUsageWindow[] => {
    if (!["TOKENS_LIMIT", "CREDIT_LIMIT"].includes(limit.type) || limit.percentage === undefined)
      return [];
    const fiveHour = limit.unit === 3 && limit.number === 5;
    const weekly = limit.unit === 6 && limit.number === 1;
    if (!fiveHour && !weekly) return [];
    return [
      {
        id: fiveHour ? "five_hour" : "weekly",
        kind: fiveHour ? "session" : "weekly",
        label: fiveHour ? "5-hour limit" : "Weekly limit",
        windowDurationMins: fiveHour ? 300 : 10080,
        usedPercent: clampPercent(limit.percentage),
        ...(limit.nextResetTime !== undefined && limit.nextResetTime > 0
          ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(limit.nextResetTime)) }
          : {}),
      },
    ];
  });

export const zcodeResetWindows = (
  data: NonNullable<(typeof ResetEnvelope.Type)["data"]>,
  now: number,
): ReadonlyArray<ServerProviderResetCreditWindow> =>
  unknownResetWindows.map((window) => {
    const source =
      window.id === "five_hour" ? data.available_five_hour_resets : data.available_week_resets;
    const expiries = source
      .map((entry) => entry.expire_at)
      .filter((expiry) => expiry > now)
      .toSorted((a, b) => a - b);
    return {
      ...window,
      availableCount: expiries.length,
      ...(expiries[0] !== undefined
        ? { nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiries[0])) }
        : {}),
      canRedeem: true,
    };
  });

export const readZCodeUsageLimits = Effect.fn("readZCodeUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled) return unsupported;
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { home, credentialsPath } = yield* resolveZCodeEnvironmentPaths(input.environment);
    const model = yield* readDefaultModelSelection(input.environment);
    if (model?.providerId !== PROVIDER_ID) return unsupported;
    const store = yield* decodeStore(yield* fs.readFileString(credentialsPath));
    const platform = yield* HostProcess.Platform;
    const credentials = yield* Effect.try(() => {
      const secret =
        input.environment.ZCODE_CREDENTIAL_SECRET?.trim() ||
        `zcode-credential-fallback:${platform}:${home}:${NodeOS.userInfo().username}`;
      const load = (key: string) => {
        const value = store[key];
        return value === undefined ? undefined : decryptZCodeCredential(value, secret).trim();
      };
      const identity = load(`account-provider:${PROVIDER_ID}:identity`);
      const apiKey = identity
        ? load(
            `account-provider:coding-plan:${PROVIDER_ID}:account:${encodeURIComponent(identity)}:api-key`,
          )
        : undefined;
      const activeProvider = load("oauth:active_provider");
      const zcodeToken = activeProvider === "zai" ? load("zcodejwttoken") : undefined;
      const accountToken = activeProvider === "zai" ? load("oauth:zai:access_token") : undefined;
      return {
        apiKey: apiKey ? Redacted.make(apiKey) : undefined,
        zcodeToken: zcodeToken ? Redacted.make(zcodeToken) : undefined,
        accountToken: accountToken ? Redacted.make(accountToken) : undefined,
      };
    });
    const client = yield* HttpClient.HttpClient;
    const quota =
      credentials.apiKey === undefined
        ? Effect.succeed(
            makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: "ZCode quota is unavailable.",
            }),
          )
        : client
            .execute(
              HttpClientRequest.get(QUOTA_URL).pipe(
                HttpClientRequest.setHeader("authorization", Redacted.value(credentials.apiKey)),
              ),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(decodeQuota),
              Effect.map((body) => {
                const windows =
                  body.code === 200 || body.code === 0 ? zcodeQuotaWindows(body.data.limits) : [];
                return windows.length > 0
                  ? makeUsageLimits({ checkedAt, windows })
                  : makeUnavailableUsageLimits({
                      checkedAt,
                      reason: "probeFailed",
                      message: "ZCode quota is unavailable.",
                    });
              }),
              Effect.timeout("5 seconds"),
              Effect.orElseSucceed(() =>
                makeUnavailableUsageLimits({
                  checkedAt,
                  reason: "probeFailed",
                  message: "ZCode quota is unavailable.",
                }),
              ),
            );
    const resets =
      credentials.zcodeToken === undefined || credentials.accountToken === undefined
        ? Effect.succeed(unsignedResetStatus())
        : client
            .execute(
              HttpClientRequest.get(RESET_STATUS_URL).pipe(
                HttpClientRequest.setHeaders({
                  authorization: /^Bearer\s/i.test(Redacted.value(credentials.zcodeToken))
                    ? Redacted.value(credentials.zcodeToken)
                    : `Bearer ${Redacted.value(credentials.zcodeToken)}`,
                  "x-bigmodel-authorization": Redacted.value(credentials.accountToken),
                  "bigmodel-target-type": "PERSONAL",
                }),
              ),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(decodeResets),
              Effect.map((body) => {
                if (body.code !== 0)
                  return failedResetStatus("The provider refused to report banked resets.");
                return body.data === undefined
                  ? failedResetStatus("Banked resets could not be read.")
                  : { windows: zcodeResetWindows(body.data, Date.parse(checkedAt)) };
              }),
              Effect.timeout("5 seconds"),
              // Every failure path — transport, status, timeout, decode — lands
              // here with the same fixed text; zero and unknown stay distinct
              // through the window counts above.
              Effect.catch(() =>
                Effect.succeed(failedResetStatus("Banked resets could not be read.")),
              ),
            );
    const result = yield* Effect.all({ limits: quota, resets }, { concurrency: "unbounded" });
    return {
      ...result.limits,
      resetCreditWindows: result.resets.windows,
      ...(result.resets.unavailable === undefined
        ? {}
        : { resetCreditWindowsUnavailable: result.resets.unavailable }),
    };
  }).pipe(
    Effect.scoped,
    Effect.provideService(Headers.CurrentRedactedNames, [
      "authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "x-bigmodel-authorization",
    ]),
    // Native credential and HTTP errors may contain sensitive input: do not retain their causes.
    Effect.orElseSucceed(() => ({
      ...makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "ZCode usage could not be read from the native sign-in.",
      }),
      resetCreditWindows: unknownResetWindows,
      resetCreditWindowsUnavailable: failedResetStatus("Banked resets could not be read.")
        .unavailable,
    })),
  );
});

const ResetUseEnvelope = Schema.Struct({
  code: Schema.Number,
  data: Schema.optional(Schema.Struct({ used: Schema.Literal(true) })),
});
const decodeResetUse = HttpClientResponse.schemaBodyJson(ResetUseEnvelope);
export class ZCodeResetError extends Schema.TaggedError<ZCodeResetError>()("ZCodeResetError", {
  detail: Schema.String,
}) {}

class ZCodeResetUnconfirmedError extends Schema.TaggedError<ZCodeResetUnconfirmedError>()(
  "ZCodeResetUnconfirmedError",
  {},
) {}

export const consumeZCodeResetCredit = Effect.fn("consumeZCodeResetCredit")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly resetWindowId: "five_hour" | "weekly";
  readonly idempotencyKey: string;
  readonly profileId: string;
}) {
  const reader = yield* makeZCodeNativeAccountReader(input.environment);
  const auth = yield* reader.resetAuthHeaders(input.profileId);
  if (!auth.ok)
    return yield* Effect.fail(
      new ZCodeResetError({ detail: "ZCode reset requires the current Z.AI Coding Plan sign-in." }),
    );
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(
    "https://zcode.z.ai/api/v1/coding-plan/reset/use",
  ).pipe(
    HttpClientRequest.setHeaders(auth.headers),
    HttpClientRequest.bodyJson({
      idempotency_key: input.idempotencyKey,
      reset_type: input.resetWindowId === "weekly" ? "WEEK" : "FIVE_HOUR",
    }),
  );
  const response = yield* client.execute(request);
  const body = yield* decodeResetUse(yield* HttpClientResponse.filterStatusOk(response));
  if (body.code !== 0)
    return yield* new ZCodeResetError({ detail: "ZCode did not confirm the reset." });
  if (body.data?.used !== true) return yield* new ZCodeResetUnconfirmedError();
  return "reset" as const;
});
