import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  isDesktopUpdateButtonDisabled,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("prepares Local updates before offering restart", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      currentVersion: "0.0.46-local.3.1",
      availableVersion: "0.0.46-local.4.1",
      status: "available",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("prepare the update in the background");
    expect(getDesktopUpdateReleaseUrl(state.availableVersion)).toBe(
      "https://github.com/gmeszaros/t3code/releases/tag/v0.0.46-local.4.1",
    );
    expect(getDesktopUpdateReleaseHistoryUrl(state.currentVersion)).toBe(
      "https://github.com/gmeszaros/t3code/releases",
    );
    expect(
      resolveDesktopUpdateButtonAction({
        ...state,
        status: "downloaded",
        downloadedVersion: state.availableVersion,
      }),
    ).toBe("install");
  });
  it("offers restart for a prepared Local update", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      currentVersion: "0.1.2-local.1.1",
      downloadedVersion: "0.1.2-local.2.1",
      status: "downloaded",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(false);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to restart and install");
    expect(canCheckForUpdate(state)).toBe(false);
  });

  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it("builds the stable release URL for a downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30", "pingdotgg/t3code")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
    );
  });

  it("uses the configured repository for non-Local version history", () => {
    vi.stubEnv("T3CODE_DESKTOP_UPDATE_REPOSITORY", "example/releases");
    try {
      expect(getDesktopUpdateReleaseHistoryUrl("0.0.36-nightly.3")).toBe(
        "https://github.com/example/releases/releases",
      );
      expect(getDesktopUpdateReleaseHistoryUrl("0.0.46-local.3.1")).toBe(
        "https://github.com/gmeszaros/t3code/releases",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the configured desktop update repository for release URLs", () => {
    expect(getDesktopUpdateReleaseUrl("1.2.3", "JustYannicc/t3code")).toBe(
      "https://github.com/JustYannicc/t3code/releases/tag/v1.2.3",
    );
    expect(getDesktopUpdateReleaseHistoryUrl("JustYannicc/t3code")).toBe(
      "https://github.com/JustYannicc/t3code/releases",
    );
  });

  it.each([
    "owner/repo/extra",
    "owner#notes/repo",
    "owner/repo#notes",
    "owner?tab=notes/repo",
    "owner/repo?tab=notes",
  ])("falls back to upstream for an invalid configured repository: %s", (repository) => {
    expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
      "https://github.com/pingdotgg/t3code/releases",
    );
    expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v1.2.3",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});
