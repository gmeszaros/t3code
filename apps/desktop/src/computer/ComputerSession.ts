import type { ComputerAction } from "@t3tools/contracts";
import { ComputerError } from "./ComputerError.ts";
export type { ComputerAction } from "@t3tools/contracts";

/** A grant is minted by the desktop host, never by a provider tool argument. */
export interface ComputerGrant {
  readonly owner: string;
  readonly processId: number;
  readonly application: string;
  readonly expiresAt: number;
  readonly readOnly: boolean;
}

export interface ComputerElement {
  readonly role: string;
  readonly name?: string | undefined;
  readonly value?: string | undefined;
  readonly actions: ReadonlyArray<"press" | "fill" | "scrollIntoView">;
}

export interface ComputerCapture {
  readonly elements: ReadonlyArray<ComputerElement>;
  readonly truncated: boolean;
  readonly image?: { readonly data: string; readonly mimeType: "image/png" };
}

export interface ComputerDriver {
  readonly foreground: () => Promise<{ processId: number; application: string }>;
  readonly capture: (processId: number) => Promise<ComputerCapture>;
  readonly act: (action: ComputerAction) => Promise<void>;
  readonly close: () => void;
}

/** One isolated worker and one app grant per provider session. */
export class ComputerSession {
  private revision = 0;
  private stopped = false;
  private busy = false;
  private snapshot: { id: string; expiresAt: number; capture: ComputerCapture } | undefined;
  private readonly grant: ComputerGrant;
  private readonly driver: ComputerDriver;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    grant: ComputerGrant,
    driver: ComputerDriver,
    now: () => number,
    newId: () => string,
  ) {
    this.grant = grant;
    this.driver = driver;
    this.now = now;
    this.newId = newId;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.revision++;
    this.snapshot = undefined;
    this.driver.close();
  }

  private check(owner: string): void {
    if (owner !== this.grant.owner) throw new Error("Computer grant belongs to another session.");
    if (this.stopped) throw new Error("Computer access was stopped.");
    if (this.now() >= this.grant.expiresAt) {
      this.stop();
      throw new Error("Computer grant expired. Request access again.");
    }
  }

  private async checkForeground(
    owner: string,
    phase: "before-capture" | "after-capture" | "before-action",
  ): Promise<void> {
    this.check(owner);
    const foreground = await this.driver.foreground();
    this.check(owner);
    if (
      foreground.processId !== this.grant.processId ||
      foreground.application !== this.grant.application
    ) {
      this.snapshot = undefined;
      throw new ComputerError(
        foreground.processId !== this.grant.processId
          ? `focus-${phase}-process`
          : `focus-${phase}-name`,
        "The user changed applications. Return to the approved app and snapshot again.",
      );
    }
  }

  async inspect(owner: string) {
    this.check(owner);
    if (this.busy) throw new Error("Another computer operation is in progress.");
    this.busy = true;
    this.snapshot = undefined;
    const revision = this.revision;
    try {
      await this.checkForeground(owner, "before-capture");
      const capture = await this.driver.capture(this.grant.processId);
      await this.checkForeground(owner, "after-capture");
      if (revision !== this.revision) throw new Error("Computer access was stopped.");
      const id = this.newId();
      this.snapshot = { id, expiresAt: this.now() + 30_000, capture };
      return { snapshotId: id, application: this.grant.application, ...capture };
    } finally {
      this.busy = false;
    }
  }

  async act(owner: string, snapshotId: string, action: ComputerAction): Promise<void> {
    this.check(owner);
    if (this.busy) throw new Error("Another computer operation is in progress.");
    if (this.grant.readOnly) throw new Error("Computer actions are disabled in read-only mode.");
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.id !== snapshotId || this.now() >= snapshot.expiresAt) {
      throw new Error("A fresh computer snapshot is required.");
    }
    if (!Number.isSafeInteger(action.element) || action.element < 0) {
      throw new Error("Unknown computer element.");
    }
    const element = snapshot.capture.elements[action.element];
    if (!element?.actions.includes(action.kind)) throw new Error("Unsupported element action.");
    if (action.kind === "fill" && action.text.length > 16_000) {
      throw new Error("Computer text exceeds the input limit.");
    }
    // Consume before awaiting: retries and concurrent calls cannot replay an action.
    this.snapshot = undefined;
    this.busy = true;
    try {
      await this.checkForeground(owner, "before-action");
      await this.driver.act(action);
    } finally {
      this.busy = false;
    }
  }
}
