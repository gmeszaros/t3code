// @effect-diagnostics-next-line nodeBuiltinImport:off -- IPC callbacks need synchronous snapshot IDs outside an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

import { makeComputerNativeDriver } from "./ComputerNativeDriver.ts";
import { ComputerSession } from "./ComputerSession.ts";
import { ComputerWorkerRequest } from "./ComputerWorkerProtocol.ts";
import { computerFailureReason } from "./ComputerError.ts";

let session: ComputerSession | undefined;
let active = false;
const decode = Schema.decodeUnknownSync(ComputerWorkerRequest);

process.once("disconnect", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
process.on("message", async (raw) => {
  let request: typeof ComputerWorkerRequest.Type;
  try {
    request = decode(raw);
  } catch {
    process.exit(1);
  }
  if (active) {
    process.send?.({ id: request.id, ok: false });
    return;
  }
  active = true;
  try {
    switch (request.kind) {
      case "resolve": {
        if (session) throw new Error("Already initialized");
        const { default: api } = await import("@crowecawcaw/xa11y");
        const app = await api.App.byName(request.application, { timeout: 0 });
        if (app.pid === null) throw new Error("Application has no process identity");
        process.send?.({
          id: request.id,
          ok: true,
          result: { processId: app.pid, application: app.name },
        });
        break;
      }
      case "init": {
        if (session) throw new Error("Already initialized");
        const { default: api } = await import("@crowecawcaw/xa11y");
        session = new ComputerSession(
          request.grant,
          makeComputerNativeDriver(api),
          Date.now,
          NodeCrypto.randomUUID,
        );
        process.send?.({ id: request.id, ok: true });
        break;
      }
      case "inspect": {
        if (!session) throw new Error("Not initialized");
        const result = await session.inspect(request.owner);
        process.send?.({ id: request.id, ok: true, result });
        break;
      }
      case "act": {
        if (!session) throw new Error("Not initialized");
        await session.act(request.owner, request.snapshotId, request.action);
        process.send?.({ id: request.id, ok: true });
        break;
      }
    }
  } catch (error) {
    // AX errors can embed window text. Do not transport native exception details.
    process.send?.({ id: request.id, ok: false, reason: computerFailureReason(error) });
  } finally {
    active = false;
  }
});

process.send?.({ ready: true });
