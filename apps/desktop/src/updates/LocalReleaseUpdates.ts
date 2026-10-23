import type { DesktopUpdateChannel, DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { DesktopUpdates } from "./DesktopUpdates.ts";

export class LocalUpdatePreparationError extends Schema.TaggedError<LocalUpdatePreparationError>()(
  "LocalUpdatePreparationError",
  { cause: Schema.Defect() },
) {}

const RELEASE_API = "https://api.github.com/repos/gmeszaros/t3code/releases/latest";
const LOCAL_VERSION = /^(\d+)\.(\d+)\.(\d+)-local\.(\d+)\.(\d+)$/;

export function newerLocalRelease(payload: unknown, currentVersion: string): string | null {
  if (!payload || typeof payload !== "object") throw new Error("Invalid release response");
  const release = payload as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false) return null;
  const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
  const next = LOCAL_VERSION.exec(version);
  const current = LOCAL_VERSION.exec(currentVersion);
  if (!next || !current || release.tag_name !== `v${version}`) return null;
  const nextParts = next.slice(1).map(Number);
  const currentParts = current.slice(1).map(Number);
  const different = nextParts.findIndex((part, index) => part !== currentParts[index]);
  if (different < 0 || nextParts[different]! <= currentParts[different]!) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const names = new Set(
    assets.map((asset: unknown) =>
      asset && typeof asset === "object" ? (asset as Record<string, unknown>).name : null,
    ),
  );
  const stem = `T3-Code-Local-${version}-arm64`;
  return names.has(`${stem}.zip`) && names.has(`${stem}.build.json`) ? version : null;
}

export const make = Effect.fn("LocalReleaseUpdates.make")(function* (
  initial: DesktopUpdateState,
  send: (state: DesktopUpdateState) => Effect.Effect<void>,
  staging?: {
    readonly pendingVersion: string | null;
    readonly pendingError?: string | undefined;
    readonly stage: (version: string) => Effect.Effect<void, LocalUpdatePreparationError>;
  },
) {
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const state = yield* Ref.make<DesktopUpdateState>(
      staging?.pendingVersion
        ? {
            ...initial,
            status: staging.pendingError ? "error" : "downloaded",
            downloadedVersion: staging.pendingVersion,
            availableVersion: staging.pendingVersion,
            message:
              staging.pendingError ?? "Update prepared. Quit and reopen the app to install it.",
            errorContext: staging.pendingError ? "install" : null,
            canRetry: !!staging.pendingError,
          }
        : initial,
    );
    const changes = yield* PubSub.sliding<DesktopUpdateState>(16);
    const mutex = yield* Semaphore.make(1);
    const busy = yield* Ref.make(false);
    const publish = (next: DesktopUpdateState) =>
      mutex.withPermits(1)(
        Ref.set(state, next).pipe(
          Effect.andThen(PubSub.publish(changes, next)),
          Effect.andThen(send(next)),
        ),
      );
    const check = Effect.fn("LocalReleaseUpdates.check")(function* (_reason: string) {
      if (!initial.enabled || (yield* Ref.get(state)).downloadedVersion)
        return { checked: false, state: yield* Ref.get(state) };
      const reserved = yield* Ref.getAndSet(busy, true);
      if (reserved) return { checked: false, state: yield* Ref.get(state) };
      return yield* Effect.gen(function* () {
        const previous = yield* Ref.get(state);
        const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* publish({ ...previous, status: "checking", checkedAt, message: null });
        const result = yield* Effect.gen(function* () {
          const response = yield* client.get(RELEASE_API, {
            headers: { Accept: "application/vnd.github+json" },
          });
          if (response.status === 404) return null;
          if (response.status !== 200) return yield* Effect.fail("Release check failed");
          const payload = yield* response.json;
          return yield* Effect.try(() => newerLocalRelease(payload, initial.currentVersion));
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.match({
            onFailure: () => ({
              message: "Could not check Local releases. Try again later.",
              version: null,
            }),
            onSuccess: (version) => ({ message: null, version }),
          }),
        );
        const next: DesktopUpdateState = {
          ...previous,
          checkedAt,
          status: result.message ? "error" : result.version ? "available" : "up-to-date",
          availableVersion: result.message ? previous.availableVersion : result.version,
          message: result.message,
          errorContext: result.message ? "check" : null,
          canRetry: result.message !== null,
        };
        yield* publish(next);
        return { checked: result.message === null, state: next };
      }).pipe(Effect.ensuring(Ref.set(busy, false)));
    });
    const download = Effect.gen(function* () {
      const previous = yield* Ref.get(state);
      if (
        !initial.enabled ||
        !staging ||
        !previous.availableVersion ||
        previous.downloadedVersion ||
        (yield* Ref.getAndSet(busy, true))
      ) {
        return { accepted: false, completed: false, state: previous };
      }
      return yield* Effect.gen(function* () {
        yield* publish({
          ...previous,
          status: "downloading",
          message: null,
          errorContext: null,
          canRetry: false,
        });
        const result = yield* staging.stage(previous.availableVersion!).pipe(Effect.exit);
        const success = result._tag === "Success";
        const next: DesktopUpdateState = {
          ...previous,
          status: success ? "downloaded" : "error",
          downloadedVersion: success ? previous.availableVersion : null,
          downloadPercent: success ? 100 : null,
          message: success
            ? "Update prepared. Quit and reopen the app to install it."
            : "Could not prepare Local update. Try again.",
          errorContext: success ? null : "download",
          canRetry: !success,
        };
        yield* publish(next);
        return { accepted: true, completed: success, state: next };
      }).pipe(
        Effect.onInterrupt(() =>
          publish({
            ...previous,
            status: "error",
            message: "Local update preparation was cancelled. Click to retry.",
            errorContext: "download",
            canRetry: true,
          }),
        ),
        Effect.ensuring(Ref.set(busy, false)),
      );
    });
    const refuseInstall = Ref.get(state).pipe(
      Effect.map((state) => ({
        accepted: false,
        completed: false,
        state,
      })),
    );
    return {
      getState: Ref.get(state),
      isActionActive: Ref.get(busy),
      isInstallActive: Effect.succeed(false),
      subscribe: mutex.withPermits(1)(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return { latest: yield* Ref.get(state), changes: Stream.fromSubscription(subscription) };
        }),
      ),
      emitState: Ref.get(state).pipe(Effect.flatMap(send)),
      disabledReason: Effect.succeed(
        initial.enabled
          ? Option.none()
          : Option.some(initial.message ?? "Local release checks are disabled."),
      ),
      configure: Effect.gen(function* () {
        if (!initial.enabled) return;
        yield* Effect.sleep("15 seconds").pipe(Effect.andThen(check("startup")), Effect.forkScoped);
        yield* Effect.sleep("1 hour").pipe(
          Effect.andThen(check("poll")),
          Effect.forever,
          Effect.forkScoped,
        );
      }),
      setChannel: (_channel: DesktopUpdateChannel) => Ref.get(state),
      check,
      download,
      install: refuseInstall,
      installPrepared: (_version: string) =>
        refuseInstall.pipe(Effect.map((result) => ({ ...result, failed: true }))),
    } satisfies DesktopUpdates["Service"];
  }).pipe(Effect.provide(FetchHttpClient.layer));
});
