import { afterEach, describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { make, newerLocalRelease, LocalUpdatePreparationError } from "./LocalReleaseUpdates.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const release = (version: string) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    { name: `T3-Code-Local-${version}-arm64.zip` },
    { name: `T3-Code-Local-${version}-arm64.build.json` },
  ],
});
const initial = {
  ...createInitialDesktopUpdateState(
    "0.0.46-local.3.1",
    {
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
    },
    "latest",
  ),
  enabled: true,
  status: "idle" as const,
};

afterEach(() => vi.unstubAllGlobals());

describe("Local release preparation", () => {
  it("orders date-and-time builds after legacy builds and across midnight", () => {
    expect(newerLocalRelease(release("0.0.46-local.20261014.172500"), initial.currentVersion)).toBe(
      "0.0.46-local.20261014.172500",
    );
    expect(
      newerLocalRelease(release("0.0.46-local.20261015.5"), "0.0.46-local.20261014.235959"),
    ).toBe("0.0.46-local.20261015.5");
    expect(
      newerLocalRelease(release("0.0.46-local.20261014.172500"), "0.0.46-local.20261014.172501"),
    ).toBeNull();
  });

  it("compares numeric builds and excludes older, incomplete and preview releases", () => {
    expect(newerLocalRelease(release("0.0.46-local.10.1"), initial.currentVersion)).toBe(
      "0.0.46-local.10.1",
    );
    expect(newerLocalRelease(release("0.0.46-local.3.1"), initial.currentVersion)).toBeNull();
    expect(newerLocalRelease(release("0.0.45-local.99.1"), initial.currentVersion)).toBeNull();
    expect(
      newerLocalRelease({ ...release("0.0.46-local.4.1"), draft: true }, initial.currentVersion),
    ).toBeNull();
    expect(
      newerLocalRelease(
        { ...release("0.0.46-local.4.1"), prerelease: true },
        initial.currentVersion,
      ),
    ).toBeNull();
    expect(
      newerLocalRelease({ ...release("0.0.46-local.4.1"), assets: [] }, initial.currentVersion),
    ).toBeNull();
    expect(
      newerLocalRelease(release("0.0.46-nightly.20261014.1"), initial.currentVersion),
    ).toBeNull();
  });

  it.effect("advertises releases but refuses download when staging is unsupported", () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(release("0.0.46-local.4.1"))));
    vi.stubGlobal("fetch", fetch);
    return Effect.gen(function* () {
      const updates = yield* make(initial, () => Effect.void);
      const result = yield* updates.check("manual");
      expect(result.checked).toBe(true);
      expect(String(fetch.mock.calls[0]?.[0])).toBe(
        "https://api.github.com/repos/gmeszaros/t3code/releases/latest",
      );
      expect(result.state.status).toBe("available");
      expect(result.state.availableVersion).toBe("0.0.46-local.4.1");
      expect(result.state.downloadedVersion).toBeNull();
      expect((yield* updates.download).accepted).toBe(false);
      expect((yield* updates.installPrepared("0.0.46-local.4.1")).accepted).toBe(false);
      expect(yield* updates.isInstallActive).toBe(false);
      expect((yield* updates.setChannel("nightly")).channel).toBe("latest");
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
  });

  it.effect(
    "stages a verified update without quitting and preserves it across release checks",
    () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify(release("0.0.46-local.4.1")))),
      );
      return Effect.gen(function* () {
        const staged: string[] = [];
        const updates = yield* make(initial, () => Effect.void, {
          pendingVersion: null,
          stage: (version) =>
            Effect.sync(() => {
              staged.push(version);
            }),
        });
        yield* updates.check("manual");
        expect((yield* updates.download).completed).toBe(true);
        expect(staged).toEqual(["0.0.46-local.4.1"]);
        expect((yield* updates.getState).status).toBe("downloaded");
        expect((yield* updates.check("poll")).state.downloadedVersion).toBe("0.0.46-local.4.1");
        expect((yield* updates.download).accepted).toBe(false);
        expect((yield* updates.install).accepted).toBe(false);
        expect(yield* updates.isActionActive).toBe(false);
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
    },
  );

  it.effect("restarts only the prepared revision and refuses duplicate install requests", () =>
    Effect.gen(function* () {
      let restarts = 0;
      const updates = yield* make(initial, () => Effect.void, {
        pendingVersion: "0.0.46-local.4.1",
        stage: () => Effect.die("must not download again"),
        restart: Effect.sync(() => {
          restarts++;
        }),
      });
      expect((yield* updates.installPrepared("0.0.46-local.5.1")).accepted).toBe(false);
      expect(restarts).toBe(0);
      expect((yield* updates.install).accepted).toBe(true);
      expect(restarts).toBe(1);
      expect(yield* updates.isInstallActive).toBe(true);
      expect((yield* updates.install).accepted).toBe(false);
      expect(restarts).toBe(1);
    }),
  );

  it.effect(
    "restores a prepared update after startup and allows retry after preparation failure",
    () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify(release("0.0.46-local.4.1")))),
      );
      return Effect.gen(function* () {
        let attempts = 0;
        const updates = yield* make(initial, () => Effect.void, {
          pendingVersion: null,
          stage: () =>
            Effect.suspend(() =>
              ++attempts === 1
                ? Effect.fail(new LocalUpdatePreparationError({ cause: "checksum mismatch" }))
                : Effect.void,
            ),
        });
        yield* updates.check("manual");
        expect((yield* updates.download).state.errorContext).toBe("download");
        expect(yield* updates.isActionActive).toBe(false);
        expect((yield* updates.download).completed).toBe(true);
        const restored = yield* make(initial, () => Effect.void, {
          pendingVersion: "0.0.46-local.4.1",
          stage: () => Effect.die("must not download again"),
        });
        expect((yield* restored.getState).status).toBe("downloaded");
        expect((yield* restored.download).accepted).toBe(false);
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
    },
  );

  it.effect("rejects overlapping downloads and checks while preparation owns the action", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(release("0.0.46-local.4.1")))),
    );
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const updates = yield* make(initial, () => Effect.void, {
        pendingVersion: null,
        stage: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      });
      yield* updates.check("manual");
      const download = yield* Effect.forkChild(updates.download);
      yield* Deferred.await(started);
      expect((yield* updates.download).accepted).toBe(false);
      expect((yield* updates.check("poll")).checked).toBe(false);
      expect((yield* updates.getState).status).toBe("downloading");
      yield* Deferred.succeed(finish, undefined);
      expect((yield* Fiber.join(download)).completed).toBe(true);
      expect(yield* updates.isActionActive).toBe(false);
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
  });

  it.effect("releases download ownership after cancellation and allows retry", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(release("0.0.46-local.4.1")))),
    );
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let attempts = 0;
      const updates = yield* make(initial, () => Effect.void, {
        pendingVersion: null,
        stage: () =>
          Effect.suspend(() =>
            ++attempts === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
          ),
      });
      yield* updates.check("manual");
      const download = yield* Effect.forkChild(updates.download);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(download);
      expect(yield* updates.isActionActive).toBe(false);
      expect((yield* updates.getState).status).toBe("error");
      expect((yield* updates.download).completed).toBe(true);
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
  });

  it.effect("reports a startup installation failure while retaining the prepared update", () =>
    Effect.gen(function* () {
      const updates = yield* make(initial, () => Effect.void, {
        pendingVersion: "0.0.46-local.4.1",
        pendingError: "App directory is not writable",
        stage: () => Effect.void,
      });
      const state = yield* updates.getState;
      expect(state.status).toBe("error");
      expect(state.errorContext).toBe("install");
      expect(state.downloadedVersion).toBe("0.0.46-local.4.1");
      expect(state.message).toBe("App directory is not writable");
    }),
  );

  it.effect("reports absent releases as up to date and allows retry after an API error", () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(release("0.0.46-local.4.1")))),
    );
    return Effect.gen(function* () {
      const updates = yield* make(initial, () => Effect.void);
      expect((yield* updates.check("first")).state.status).toBe("up-to-date");
      expect((yield* updates.check("second")).checked).toBe(false);
      expect((yield* updates.getState).errorContext).toBe("check");
      expect(yield* updates.isActionActive).toBe(false);
      expect((yield* updates.check("retry")).state.status).toBe("available");
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
  });

  it.effect("honors disabled checks without leaving an active action", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    return Effect.gen(function* () {
      const updates = yield* make({ ...initial, enabled: false }, () => Effect.void);
      expect((yield* updates.check("manual")).checked).toBe(false);
      expect(yield* updates.isActionActive).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
  });
});
