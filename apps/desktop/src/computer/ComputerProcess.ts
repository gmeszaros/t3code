// @effect-diagnostics globalTimers:off -- Deadlines kill the owned native worker at the process boundary.
// @effect-diagnostics globalDate:off -- Native worker expiry uses the host's wall-clock grant deadline.
// @effect-diagnostics nodeBuiltinImport:off -- Desktop-owned accessibility worker.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

import type { ComputerAction, ComputerGrant } from "./ComputerSession.ts";
import { ComputerError } from "./ComputerError.ts";
import {
  ComputerWorkerResponse,
  type ComputerInspection,
  type ComputerApplicationIdentity,
  type ComputerWorkerRequest,
} from "./ComputerWorkerProtocol.ts";

export function startComputerProcess(workerPath: string, grant?: ComputerGrant) {
  const worker = NodeChildProcess.fork(workerPath, [], {
    execPath: process.execPath,
    execArgv: [],
    env: { HOME: process.env.HOME, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let closed = false;
  const ready = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let pending:
    | {
        id: string;
        resolve: (
          value: ComputerInspection | typeof ComputerApplicationIdentity.Type | undefined,
        ) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expiry = setTimeout(
    () => close(),
    Math.max(0, grant ? grant.expiresAt - Date.now() : 30_000),
  );
  expiry.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    if (deadline) clearTimeout(deadline);
    const error = new Error(
      "Computer access stopped, expired or the native worker became unavailable.",
    );
    ready.reject(error);
    pending?.reject(error);
    pending = undefined;
    stopped.resolve();
    worker.kill("SIGKILL");
  };
  const decode = Schema.decodeUnknownSync(ComputerWorkerResponse);
  worker.on("message", (raw) => {
    try {
      const response = decode(raw);
      if ("ready" in response) {
        ready.resolve();
        return;
      }
      if (response.id !== pending?.id) {
        close();
        return;
      }
      if (deadline) clearTimeout(deadline);
      if (response.ok) pending.resolve(response.result);
      else
        pending.reject(
          new ComputerError(
            response.reason ?? "worker-failed",
            "Computer operation failed. Check app focus and OS permissions, then take a new snapshot.",
          ),
        );
      pending = undefined;
    } catch {
      close();
    }
  });
  worker.once("error", close);
  worker.once("exit", close);
  const request = (input: typeof ComputerWorkerRequest.Type) => {
    if (closed) return Promise.reject(new Error("Computer access stopped."));
    if (pending) return Promise.reject(new Error("Computer operation already in progress."));
    const result = Promise.withResolvers<
      ComputerInspection | typeof ComputerApplicationIdentity.Type | undefined
    >();
    pending = { id: input.id, ...result };
    deadline = setTimeout(close, 8_000);
    deadline.unref();
    try {
      worker.send(input, (error) => {
        if (error) close();
      });
    } catch {
      close();
    }
    return result.promise;
  };
  const bootDeadline = setTimeout(close, 8_000);
  bootDeadline.unref();
  const initialized = ready.promise
    .then(() => {
      clearTimeout(bootDeadline);
      return grant ? request({ id: NodeCrypto.randomUUID(), kind: "init", grant }) : undefined;
    })
    .then(() => undefined)
    .finally(() => clearTimeout(bootDeadline));
  // A host may revoke immediately, before it awaits the first operation.
  void initialized.catch(() => undefined);
  return {
    close,
    ready: initialized,
    closed: stopped.promise,
    async resolveApplication(application: string) {
      if (grant) throw new Error("Computer worker already has a grant.");
      await initialized;
      const result = await request({ id: NodeCrypto.randomUUID(), kind: "resolve", application });
      if (!result || !("processId" in result)) throw new Error("Application identity unavailable.");
      return result;
    },
    async inspect() {
      if (!grant) throw new Error("Computer access needs a grant.");
      await initialized;
      const result = await request({
        id: NodeCrypto.randomUUID(),
        kind: "inspect",
        owner: grant.owner,
      });
      if (!result || !("snapshotId" in result))
        throw new Error("Computer worker returned no snapshot.");
      return result;
    },
    async act(snapshotId: string, action: ComputerAction) {
      if (!grant) throw new Error("Computer access needs a grant.");
      await initialized;
      await request({
        id: NodeCrypto.randomUUID(),
        kind: "act",
        owner: grant.owner,
        snapshotId,
        action,
      });
    },
  };
}
