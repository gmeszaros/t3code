// @effect-diagnostics-next-line nodeBuiltinImport:off -- The vendor credential store decrypts with node's AES-GCM ciphers, which Effect's Crypto does not provide.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { resolveZCodeEnvironmentPaths } from "./ZCodeEnvironmentPaths.ts";
import type * as ZCodeSchema from "./ZCodeWireSchema.ts";

const providerId = "account:zai-individual-coding-plan";
const decodeStore = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeCatalog = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ revision: Schema.Int })),
);
const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeOAuthProfile = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      user_id: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    }),
  ),
);
const decodeSelection = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      config: Schema.Struct({
        defaultModelSelection: Schema.optional(Schema.Struct({ providerId: Schema.String })),
      }),
    }),
  ),
);
const DEFAULT_ZCODE_ORIGIN = "https://zcode.z.ai";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeHttpsOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

const isTrustedOfficialOrigin = (target: string, expected: string, devOrigins: string) => {
  const normalizeLoopback = (value: string): string | undefined => {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "http:" || url.username || url.password) return undefined;
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  };
  const loopback = normalizeLoopback(target);
  if (
    loopback &&
    devOrigins.split(",").some((candidate) => normalizeLoopback(candidate) === loopback)
  )
    return true;
  const normalizedExpected = normalizeHttpsOrigin(expected);
  return normalizedExpected !== undefined && normalizeHttpsOrigin(target) === normalizedExpected;
};

const accountAuthFailure = (
  reason:
    | "official_auth_unavailable"
    | "official_mcp_origin_untrusted"
    | "official_auth_plan_required",
): ZCodeSchema.RequestOfficialMcpAuthHeadersResult => ({ ok: false, reason });

const decodeProfileId = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  try {
    const profile = decodeOAuthProfile(raw);
    const id = profile.user_id ?? profile.id;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
};

/** Native 0.16.9 enc:v1 format. Decrypted values stay in memory and are never persisted. */
export const decryptZCodeCredential = (value: string, secret: string): string => {
  if (!value.startsWith("enc:")) return value;
  if (!value.startsWith("enc:v1:")) throw new Error("Unsupported native credential format");
  const parts = value.slice(7).split(".");
  if (parts.length !== 3) throw new Error("Invalid native credential format");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv?.length !== 12 || tag?.length !== 16 || ciphertext === undefined) {
    throw new Error("Invalid native credential format");
  }
  const key = NodeCrypto.createHash("sha256").update(secret).digest();
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
};

export const readZCodeAccountProfile = Effect.fn("readZCodeAccountProfile")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  return yield* Effect.gen(function* () {
    const { home, credentialsPath } = yield* resolveZCodeEnvironmentPaths(environment);
    const store = yield* decodeStore(yield* fs.readFileString(credentialsPath));
    const secret =
      environment.ZCODE_CREDENTIAL_SECRET?.trim() ||
      `zcode-credential-fallback:${platform}:${home}:${NodeOS.userInfo().username}`;
    return yield* Effect.try(() => {
      const read = (key: string) =>
        store[key] === undefined ? undefined : decryptZCodeCredential(store[key]!, secret).trim();
      if (read("oauth:active_provider") !== "zai") return undefined;
      const raw = read("oauth:zai:user_info");
      if (!raw) return undefined;
      const profile = decodeOAuthProfile(raw);
      const profileId = (profile.user_id ?? profile.id)?.trim();
      const email = profile.email?.trim();
      return { ...(email ? { email } : {}), ...(profileId ? { profileId } : {}) };
    });
  }).pipe(Effect.orElseSucceed(() => undefined));
});

/** Captures the environment boundary; credentials are re-read for each native request. */
export const makeZCodeNativeAccountReader = Effect.fn("makeZCodeNativeAccountReader")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const { home, credentialsPath, personalConfigPath, settingsPath } =
    yield* resolveZCodeEnvironmentPaths(environment);
  const credentialSecret =
    environment.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${platform}:${home}:${NodeOS.userInfo().username}`;
  const readCredentialValues = Effect.fn("ZCodeNativeAccount.readCredentialValues")(function* (
    names: readonly string[],
  ) {
    const store = yield* decodeStore(yield* fs.readFileString(credentialsPath));
    return yield* Effect.try(
      () =>
        Object.fromEntries(
          names.map((name) => [
            name,
            store[name] === undefined
              ? undefined
              : decryptZCodeCredential(store[name]!, credentialSecret).trim(),
          ]),
        ) as Record<string, string | undefined>,
    );
  });
  const readKey = Effect.gen(function* () {
    const store = yield* decodeStore(yield* fs.readFileString(credentialsPath));
    return yield* Effect.try(() => {
      const read = (name: string) =>
        store[name] === undefined
          ? undefined
          : decryptZCodeCredential(store[name]!, credentialSecret).trim();
      const identity = read(`account-provider:${providerId}:identity`);
      const value = identity
        ? read(
            `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`,
          )
        : undefined;
      return value ? Redacted.make(value) : undefined;
    });
  }).pipe(Effect.orElseSucceed(() => undefined));
  const requestAuthHeaders = Effect.fn("ZCodeNativeAccount.requestAuthHeaders")(function* (
    destinationOrigin: string,
    mode: "mcp" | "reset" = "mcp",
    expectedProfileId?: string,
  ): Effect.fn.Return<ZCodeSchema.RequestOfficialMcpAuthHeadersResult> {
    return yield* Effect.gen(function* () {
      const readSnapshot = Effect.fn("ZCodeNativeAccount.readSnapshot")(function* () {
        return yield* Effect.gen(function* () {
          const [rawSettings, values, rawSelection] = yield* Effect.all(
            [
              fs.readFileString(settingsPath),
              readCredentialValues([
                "oauth:active_provider",
                "zcodejwttoken",
                "oauth:zai:access_token",
                "oauth:zai:user_info",
              ]),
              fs.readFileString(personalConfigPath),
            ],
            { concurrency: "unbounded" },
          );
          const settings: unknown = yield* decodeSettings(rawSettings);
          const selection = yield* decodeSelection(rawSelection);
          const defaultProvider = selection.config.defaultModelSelection?.providerId;
          const endpointOrigin =
            isRecord(settings) && typeof settings.zcodeEndpointOrigin === "string"
              ? settings.zcodeEndpointOrigin.trim()
              : undefined;
          const profileId = decodeProfileId(values["oauth:zai:user_info"]);
          const jwt = values.zcodejwttoken;
          const maasJwt = values["oauth:zai:access_token"];
          const validSettings =
            isRecord(settings) &&
            settings.providerFamilyDomain === "zai" &&
            isRecord(settings.providerFamilyConnectionSelections) &&
            isRecord(settings.providerFamilyConnectionSelections.zai) &&
            settings.providerFamilyConnectionSelections.zai.kind === "individual-coding-plan";
          return {
            domain: isRecord(settings) ? settings.providerFamilyDomain : undefined,
            selectionKind:
              isRecord(settings) &&
              isRecord(settings.providerFamilyConnectionSelections) &&
              isRecord(settings.providerFamilyConnectionSelections.zai)
                ? settings.providerFamilyConnectionSelections.zai.kind
                : undefined,
            active: values["oauth:active_provider"],
            defaultProvider,
            profileId,
            selected: validSettings && defaultProvider === providerId && Boolean(profileId),
            loggedIn: values["oauth:active_provider"] === "zai" && Boolean(jwt),
            hasMaasJwt: Boolean(maasJwt),
            endpointOrigin,
            jwt,
            maasJwt,
          };
        }).pipe(Effect.orElseSucceed(() => undefined));
      });

      const current = yield* readSnapshot();
      if (!current) return accountAuthFailure("official_auth_unavailable");
      if (expectedProfileId !== undefined && current.profileId !== expectedProfileId)
        return accountAuthFailure("official_auth_unavailable");
      const target = yield* Effect.try({
        try: () => new URL(destinationOrigin.trim()),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (!target || target.username || target.password)
        return accountAuthFailure("official_mcp_origin_untrusted");
      const targetOrigin = target.origin;
      // The origin is captured with the same settings snapshot as the selected
      // account, then checked again below before credentials are returned.
      if (
        !isTrustedOfficialOrigin(
          targetOrigin,
          current.endpointOrigin ||
            environment.ZCODE_BASE_URL?.trim() ||
            environment.ZCODE_ENDPOINT_ORIGIN?.trim() ||
            (environment.ZCODE_ENV?.trim().toLowerCase() === "test"
              ? environment.ZCODE_TEST_BASE_URL?.trim()
              : environment.ZCODE_PRODUCTION_BASE_URL?.trim()) ||
            DEFAULT_ZCODE_ORIGIN,
          environment.ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS ?? "",
        )
      )
        return accountAuthFailure("official_mcp_origin_untrusted");
      if (!current.selected) return accountAuthFailure("official_auth_plan_required");
      if (!current.loggedIn || !current.hasMaasJwt || !current.jwt || !current.maasJwt)
        return accountAuthFailure("official_auth_unavailable");
      const latest = yield* readSnapshot();
      if (
        !latest?.selected ||
        !latest.loggedIn ||
        !latest.hasMaasJwt ||
        current.endpointOrigin !== latest.endpointOrigin ||
        current.domain !== latest.domain ||
        current.selectionKind !== latest.selectionKind ||
        current.defaultProvider !== latest.defaultProvider ||
        current.active !== latest.active ||
        current.profileId !== latest.profileId ||
        current.jwt !== latest.jwt ||
        current.maasJwt !== latest.maasJwt
      )
        return accountAuthFailure("official_auth_unavailable");
      return {
        ok: true as const,
        headers: {
          Authorization: /^Bearer\s/i.test(current.jwt) ? current.jwt : `Bearer ${current.jwt}`,
          "X-Bigmodel-Authorization":
            mode === "reset" ? current.maasJwt : `Bearer ${current.maasJwt}`,
          "Bigmodel-Target-Type": "PERSONAL",
        },
      };
    }).pipe(Effect.orElseSucceed(() => accountAuthFailure("official_auth_unavailable")));
  });

  const officialMcpAuthHeaders = (params: ZCodeSchema.RequestOfficialMcpAuthHeadersParams) =>
    requestAuthHeaders(params.targetOrigin);
  const resetAuthHeaders = (profileId: string) =>
    requestAuthHeaders(DEFAULT_ZCODE_ORIGIN, "reset", profileId);

  const readAccount = Effect.fn("ZCodeNativeAccount.readAccount")(function* (catalogPath: string) {
    return yield* Effect.gen(function* () {
      const selected = yield* decodeSelection(yield* fs.readFileString(personalConfigPath));
      if (selected.config.defaultModelSelection?.providerId !== providerId || !(yield* readKey))
        return undefined;
      const catalog = yield* decodeCatalog(yield* fs.readFileString(catalogPath));
      // Native 0.16.9 binds the revision to the absolute catalog path, not its contents.
      const basedOnZCodeBuiltinRevision = `zcode-builtin:${catalog.revision}:${NodeCrypto.createHash("sha256").update(path.resolve(catalogPath)).digest("hex")}`;
      return {
        personalConfigPath,
        snapshot: {
          revision: `t3:${basedOnZCodeBuiltinRevision}:${providerId}`,
          basedOnZCodeBuiltinRevision,
          providers: { [providerId]: { access: { type: "zhipu-account", entitled: true } } },
          states: { [providerId]: { availability: "available", entitled: true, current: true } },
        },
        runtimeHeaders: Effect.fn("ZCodeNativeAccount.runtimeHeaders")(function* (
          params: Record<string, unknown>,
        ) {
          const access = params.accountAccess as { mode?: unknown } | undefined;
          const selection = params.modelSelection as { providerId?: unknown } | undefined;
          if (
            params.providerId !== providerId ||
            selection?.providerId !== providerId ||
            access?.mode !== "individual-coding-plan"
          ) {
            return {
              headersApplied: false,
              errorMessage: "Native account request does not match the configured account",
            };
          }
          const key = yield* readKey;
          return key
            ? { headersApplied: true, requestAuth: { apiKey: Redacted.value(key) } }
            : { headersApplied: false, errorMessage: "Native account credential is unavailable" };
        }),
        officialMcpAuthHeaders,
      };
    }).pipe(Effect.orElseSucceed(() => undefined));
  });
  return Object.assign(readAccount, { officialMcpAuthHeaders, resetAuthHeaders });
});

export type ZCodeNativeAccount = NonNullable<
  Effect.Success<ReturnType<Effect.Success<ReturnType<typeof makeZCodeNativeAccountReader>>>>
>;
