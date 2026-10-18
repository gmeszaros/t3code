import { describe, expect, it } from "@effect/vitest";
import { resetCreditRequestDisplay, resetCreditRequestOutcomeLabel } from "./resetCreditRequest.ts";

describe("reset credit request presentation", () => {
  it.each([
    [undefined, "approved-pending", "Approved: redemption pending"],
    ["unconfirmed", "unconfirmed", "Redemption uncertain: the provider may have spent the credit"],
    ["reset", "approved-reset", "Reset accepted for the weekly window"],
    ["failed", "approved-failed", "Approved, but the provider refused the reset"],
    ["noCredit", "noCredit", "Approved, but no reset credit remained"],
    ["nothingToReset", "nothingToReset", "Approved, but nothing needed a reset"],
    ["alreadyRedeemed", "alreadyRedeemed", "Approved, but this reset was already redeemed"],
  ] as const)(
    "shows the provider outcome %s without claiming recovery",
    (outcome, display, label) => {
      const item = { requestStatus: "approved", outcome, resetWindowId: "weekly" } as const;
      expect(resetCreditRequestDisplay(item, "local")).toEqual({
        kind: "answered",
        outcome: display,
      });
      expect(resetCreditRequestOutcomeLabel(item)).toBe(label);
    },
  );

  it("offers approval only on a pending card in its own thread", () => {
    const item = { requestStatus: "pending" } as const;
    expect(resetCreditRequestDisplay(item, "local")).toEqual({ kind: "pending" });
    expect(resetCreditRequestDisplay(item, "inherited")).toEqual({ kind: "pending-elsewhere" });
    expect(resetCreditRequestDisplay(item, "synthetic")).toEqual({ kind: "pending-elsewhere" });
  });
});
