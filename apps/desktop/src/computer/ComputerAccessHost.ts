import type {
  ComputerDesktopRequest,
  ComputerDesktopResponse,
  ComputerInspection,
} from "@t3tools/contracts";

import type { ComputerAction, ComputerGrant } from "./ComputerSession.ts";
import { computerFailureReason } from "./ComputerError.ts";

export interface ComputerAccessWorker {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly inspect: () => Promise<ComputerInspection>;
  readonly act: (snapshotId: string, action: ComputerAction) => Promise<void>;
  readonly close: () => void;
}

export interface ComputerAccessHostOptions {
  readonly resolveApplication: (
    name: string,
    signal: AbortSignal,
  ) => Promise<{ processId: number; application: string }>;
  readonly approve: (input: {
    application: string;
    threadTitle: string;
    readOnly: boolean;
    signal: AbortSignal;
  }) => Promise<boolean>;
  readonly start: (grant: ComputerGrant) => ComputerAccessWorker;
  readonly changed: (grant: ComputerGrant | undefined) => void;
  readonly now: () => number;
}

/** One desktop can be controlled by one explicitly approved provider session at a time. */
export class ComputerAccessHost {
  private active:
    | { grant: ComputerGrant; worker: ComputerAccessWorker; ready: boolean }
    | undefined;
  private pending: { owner: string; application: string; abort: AbortController } | undefined;
  private closed = false;
  private readonly options: ComputerAccessHostOptions;

  constructor(options: ComputerAccessHostOptions) {
    this.options = options;
  }

  stop(owner?: string): void {
    if (this.pending && (owner === undefined || this.pending.owner === owner)) {
      const pending = this.pending;
      this.pending = undefined;
      pending.abort.abort();
    }
    if (this.active && (owner === undefined || this.active.grant.owner === owner)) {
      const active = this.active;
      this.active = undefined;
      active.worker.close();
      this.options.changed(undefined);
    }
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  async handle(request: ComputerDesktopRequest): Promise<ComputerDesktopResponse> {
    const respond = (result: ComputerDesktopResponse["result"]): ComputerDesktopResponse => ({
      id: request.id,
      result,
    });
    const unavailable = (
      reason: Extract<ComputerDesktopResponse["result"], { kind: "unavailable" }>["reason"],
    ) => respond({ kind: "unavailable", reason });
    const { invocation, command } = request;
    if (command.kind === "stop") {
      this.stop(invocation.owner);
      return respond({ kind: "completed" });
    }
    if (this.closed) return unavailable("stopped");
    if (this.active && this.options.now() >= this.active.grant.expiresAt)
      this.stop(this.active.grant.owner);

    if (command.kind === "requestAccess") {
      if (this.pending || (this.active && this.active.grant.owner !== invocation.owner))
        return unavailable("denied");
      this.stop(invocation.owner);
      const pending = {
        owner: invocation.owner,
        application: command.application,
        abort: new AbortController(),
      };
      this.pending = pending;
      try {
        const identity = await this.options.resolveApplication(
          command.application,
          pending.abort.signal,
        );
        if (this.pending !== pending || this.closed) return unavailable("stopped");
        // Show the verified native name, never a model-provided PID/label pair.
        pending.application = identity.application;
        void this.options
          .approve({
            application: identity.application,
            threadTitle: invocation.threadTitle,
            readOnly: invocation.readOnly,
            signal: pending.abort.signal,
          })
          .then((approved) => {
            if (this.pending !== pending || this.closed) return;
            if (!approved) {
              this.pending = undefined;
              return;
            }
            const grant: ComputerGrant = {
              ...identity,
              owner: invocation.owner,
              readOnly: invocation.readOnly,
              expiresAt: this.options.now() + 10 * 60_000,
            };
            const worker = this.options.start(grant);
            const active = { grant, worker, ready: false };
            this.active = active;
            void worker.closed.then(() => {
              if (this.active === active) this.stop(grant.owner);
            });
            void worker.ready.then(
              () => {
                if (this.active !== active) return;
                if (this.options.now() >= grant.expiresAt) {
                  this.stop(grant.owner);
                  return;
                }
                active.ready = true;
                this.options.changed(grant);
              },
              () => {
                if (this.active === active) this.stop(grant.owner);
              },
            );
            this.pending = undefined;
          })
          .catch(() => {
            if (this.pending === pending) this.stop(invocation.owner);
          });
        // Consent must not consume the provider's tool-execution deadline.
        return respond({ kind: "pending", application: identity.application });
      } catch (error) {
        const canceled = pending.abort.signal.aborted;
        if (this.pending === pending) this.stop(invocation.owner);
        return unavailable(canceled ? "stopped" : computerFailureReason(error));
      }
    }

    if (command.kind === "status" && this.pending?.owner === invocation.owner && !this.active) {
      return respond({ kind: "pending", application: this.pending.application });
    }
    const active = this.active;
    if (!active || active.grant.owner !== invocation.owner) return unavailable("denied");
    if (invocation.readOnly && !active.grant.readOnly) {
      this.stop(invocation.owner);
      return unavailable("read-only");
    }
    if (command.kind === "act" && active.grant.readOnly) return unavailable("read-only");
    if (!active.ready) return respond({ kind: "pending", application: active.grant.application });
    if (command.kind === "status")
      return respond({
        kind: "granted",
        application: active.grant.application,
        readOnly: active.grant.readOnly,
        expiresAt: active.grant.expiresAt,
      });
    try {
      if (command.kind === "inspect") {
        const snapshot = await active.worker.inspect();
        if (this.active !== active) return unavailable("stopped");
        return respond({ kind: "snapshot", snapshot });
      }
      await active.worker.act(command.snapshotId, command.action);
      if (this.active !== active) return unavailable("stopped");
      return respond({ kind: "completed" });
    } catch (error) {
      if (this.active === active) this.stop(invocation.owner);
      return unavailable(computerFailureReason(error));
    }
  }
}
