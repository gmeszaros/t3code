import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { ComputerDesktopRequest, ComputerDesktopResponse } from "@t3tools/contracts";
import { encodeComputerMessage } from "@t3tools/shared/computerProtocol";

import { ComputerDesktopBridge } from "./ComputerDesktopBridge.ts";

const request: ComputerDesktopRequest = {
  id: "request",
  invocation: { owner: "session", threadTitle: "Test", readOnly: false },
  command: { kind: "requestAccess", application: "Test App" },
};

it("delivers Stop while consent is pending and suppresses a response after disconnect", async () => {
  const consent = Promise.withResolvers<ComputerDesktopResponse>();
  const stopped = Promise.withResolvers<void>();
  const host = {
    handle: vi.fn(async (input: ComputerDesktopRequest): Promise<ComputerDesktopResponse> => {
      if (input.command.kind === "requestAccess") return consent.promise;
      stopped.resolve();
      return { id: input.id, result: { kind: "completed" } };
    }),
    close: vi.fn(),
  };
  const write = vi.fn(async (_bytes: Uint8Array) => undefined);
  const bridge = new ComputerDesktopBridge(host, write);
  bridge.receive(encodeComputerMessage(request, 100_000));
  bridge.receive(
    encodeComputerMessage({ ...request, id: "stop", command: { kind: "stop" } }, 100_000),
  );
  await stopped.promise;
  bridge.close();
  consent.resolve({ id: request.id, result: { kind: "completed" } });
  await consent.promise;
  assert.equal(host.handle.mock.calls.length, 2);
  assert.equal(host.close.mock.calls.length, 1);
  assert.equal(write.mock.calls.length, 1);
});

it("invalid pipe data revokes the host instead of reaching native code", () => {
  const host = { handle: vi.fn(), close: vi.fn() };
  const bridge = new ComputerDesktopBridge(host, async () => undefined);
  bridge.receive(new TextEncoder().encode('{"unexpected":"data"}\n'));
  assert.equal(host.close.mock.calls.length, 1);
  assert.equal(host.handle.mock.calls.length, 0);
  bridge.receive(encodeComputerMessage(request, 100_000));
  assert.equal(host.handle.mock.calls.length, 0);
});
