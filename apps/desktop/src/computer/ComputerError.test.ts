import { assert, it } from "@effect/vitest";
import { ComputerError, computerFailureReason } from "./ComputerError.ts";

it("reports known native failure categories without transporting window text", () => {
  for (const name of ["PermissionDeniedError", "AccessibilityNotEnabledError"]) {
    const error = new Error("private-window-text");
    error.name = name;
    assert.equal(computerFailureReason(error), "permissions");
  }
  const platform = new Error("private-window-text");
  platform.name = "PlatformError";
  assert.equal(computerFailureReason(platform), "native-platform");
  assert.equal(
    computerFailureReason(new ComputerError("focus-changed", "static explanation")),
    "focus-changed",
  );
  assert.equal(computerFailureReason(new Error("private-window-text")), "worker-failed");
});
