import { afterEach, describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { make, newerLocalRelease } from "./LocalReleaseUpdates.ts";
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

describe("Local manual release checks", () => {
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

  it.effect(
    "advertises a newer release through IPC state and refuses automated installation",
    () => {
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(release("0.0.46-local.4.1"))));
      vi.stubGlobal("fetch", fetch);
      return Effect.gen(function* () {
        const updates = yield* make(initial, () => Effect.void);
        const result = yield* updates.check("manual");
        expect(result.checked).toBe(true);
        expect(String(fetch.mock.calls[0]?.[0])).toBe(
          "https://api.github.com/repos/gmeszaros/t3code-local/releases/latest",
        );
        expect(result.state.status).toBe("available");
        expect(result.state.availableVersion).toBe("0.0.46-local.4.1");
        expect(result.state.downloadedVersion).toBeNull();
        expect((yield* updates.download).accepted).toBe(false);
        expect((yield* updates.installPrepared("0.0.46-local.4.1")).failed).toBe(true);
        expect(yield* updates.isInstallActive).toBe(false);
        expect((yield* updates.setChannel("nightly")).channel).toBe("latest");
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
    },
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
