import { ProviderDriverKind, ZCodeSettings } from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, Headers } from "effect/http";
import { readZCodeUsageLimits, consumeZCodeResetCredit } from "../zcode/ZCodeUsageLimits.ts";

import { readZCodeAccountProfile } from "../zcode/ZCodeNativeAccount.ts";
import { resolveZCodeEnvironmentPaths } from "../zcode/ZCodeEnvironmentPaths.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";

import { ServerConfig } from "../../config.ts";
import { makeZCodeTextGeneration } from "../../textGeneration/ZCodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeZCodeAdapterV2 } from "../zcode/ZCodeAdapterV2.ts";
import * as ZCodeSessionRuntime from "../zcode/ZCodeSessionRuntime.ts";
import { buildInitialZCodeProviderSnapshot } from "../zcode/ZCodeProviderStatus.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

const decodeZCodeSettings = Schema.decodeSync(ZCodeSettings);

type ZCodeSettingsType = Schema.Schema.Type<typeof ZCodeSettings>;

const DRIVER_KIND = ProviderDriverKind.make("zcode");

// The official runtime updates through the ZCode app itself, so T3 never
// offers a one-click update for it.
const MANUAL_MAINTENANCE: ProviderMaintenanceCapabilities =
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: "zcode",
  });

export type ZCodeDriverEnv =
  | Crypto.Crypto
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost
  | McpProviderSessions
  | ServerConfig
  | ResetCreditCoordinator.ResetCreditCoordinator;

export const ZCodeDriver: ProviderDriver<ZCodeSettingsType, ZCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ZCode",
    supportsMultipleInstances: true,
  },
  configSchema: ZCodeSettings,
  defaultConfig: (): ZCodeSettingsType => decodeZCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const resetCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const httpClient = yield* HttpClient.HttpClient;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, attachmentsDir } = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies ZCodeSettings;

      const adapter = yield* Effect.mapError(
        makeZCodeAdapterV2(instanceId).pipe(
          Effect.provide(
            ZCodeSessionRuntime.layer(effectiveConfig, {
              environment: processEnv,
              instanceId,
              attachmentsDir,
            }),
          ),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the ZCode adapter",
            cause,
          }),
      );
      const textGeneration = yield* Effect.mapError(
        makeZCodeTextGeneration(effectiveConfig, processEnv).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build ZCode text generation",
            cause,
          }),
      );

      const probe = Effect.all(
        {
          provider: buildInitialZCodeProviderSnapshot(effectiveConfig, processEnv),
          usageLimits: readZCodeUsageLimits({ enabled, environment: processEnv }),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ provider, usageLimits }) => ({ ...provider, usageLimits })),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ZCodeSettings>>({
        resolveMaintenance: () => Effect.succeed(MANUAL_MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => probe.pipe(Effect.map(stampIdentity)),
        checkProvider: probe.pipe(Effect.map(stampIdentity)),
        refreshOnInterval: true,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the ZCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = (
        resetWindowId,
      ) =>
        Effect.gen(function* () {
          if (resetWindowId === undefined)
            return yield* new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Choose a ZCode reset window.",
            });
          const profile = yield* readZCodeAccountProfile(processEnv);
          const profileId = profile?.profileId;
          if (!profileId)
            return yield* new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "ZCode account unavailable.",
            });
          const { credentialsPath } = yield* resolveZCodeEnvironmentPaths(processEnv);
          const outcome = yield* resetCoordinator.redeem(
            `zcode:${credentialsPath}:${profileId}:${resetWindowId}`,
            (idempotencyKey) =>
              consumeZCodeResetCredit({
                environment: processEnv,
                resetWindowId,
                idempotencyKey,
                profileId,
              }),
          );
          yield* snapshot.refresh;
          return outcome;
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Headers.CurrentRedactedNames, [
            "authorization",
            "x-bigmodel-authorization",
          ]),
          Effect.mapError(
            () =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  "ZCode could not confirm the reset. Refresh usage and retry the same window.",
              }),
          ),
        );

      void cwd;
      void eventLoggers;

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter: adapter,
        textGeneration,
        consumeResetCredit,
      } satisfies ProviderInstance;
    }),
};
