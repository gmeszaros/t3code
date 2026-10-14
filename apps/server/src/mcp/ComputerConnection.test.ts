import * as NodeAssert from "node:assert/strict";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { ComputerDesktopRequest } from "@t3tools/contracts";

import { ComputerConnection } from "./ComputerConnection.ts";

const request: ComputerDesktopRequest = {
  id: "request-1",
  invocation: { owner: "session-1", threadTitle: "Test", readOnly: true },
  command: { kind: "inspect" },
};
const response = new TextEncoder().encode('{"id":"request-1","result":{"kind":"completed"}}\n');

it("matches split responses and permits the next request only after completion", async () => {
  const write = vi.fn(async (_bytes: Uint8Array) => undefined);
  const connection = new ComputerConnection(write);
  const result = connection.request(request, new AbortController().signal);
  await NodeAssert.rejects(
    connection.request({ ...request, id: "second" }, new AbortController().signal),
    /pending/,
  );
  connection.receive(response.slice(0, 10));
  connection.receive(response.slice(10));
  assert.deepEqual(await result, { kind: "completed" });
  assert.equal(write.mock.calls.length, 1);
  connection.close();
});

it("cancellation sends owner-scoped Stop and never repeats an action", async () => {
  const write = vi.fn(async (_bytes: Uint8Array) => undefined);
  const connection = new ComputerConnection(write);
  const abort = new AbortController();
  const result = connection.request(request, abort.signal);
  const rejected = NodeAssert.rejects(result, /canceled/);
  abort.abort();
  await rejected;
  const stop = JSON.parse(new TextDecoder().decode(write.mock.calls[1]?.[0]));
  assert.deepEqual(stop.command, { kind: "stop" });
  assert.deepEqual(stop.invocation, request.invocation);
  connection.receive(response);
  assert.equal(write.mock.calls.length, 2);
  connection.close();
});

it("disconnect rejects pending operations and cannot fall back to a different host", async () => {
  const connection = new ComputerConnection(async () => undefined);
  const result = connection.request(request, new AbortController().signal);
  const rejected = NodeAssert.rejects(result, /disconnected/);
  connection.close();
  await rejected;
  await NodeAssert.rejects(
    connection.request(request, new AbortController().signal),
    /unavailable/,
  );
});

it("malformed replies close the channel without reflecting native payloads", async () => {
  const connection = new ComputerConnection(async () => undefined);
  const result = connection.request(request, new AbortController().signal);
  const rejected = NodeAssert.rejects(result, /disconnected/);
  connection.receive(new TextEncoder().encode('{"unexpected":"private window text"}\n'));
  await rejected;
});

it("write failure rejects the operation; pre-canceled calls emit nothing", async () => {
  const write = vi.fn(async () => {
    throw new Error("pipe closed");
  });
  const connection = new ComputerConnection(write);
  const abort = new AbortController();
  abort.abort();
  await NodeAssert.rejects(connection.request(request, abort.signal), /canceled/);
  assert.equal(write.mock.calls.length, 0);
  await NodeAssert.rejects(
    connection.request(request, new AbortController().signal),
    /disconnected/,
  );
});

it("session revocation sends Stop without creating an orphan pending request", async () => {
  const write = vi.fn(async (_bytes: Uint8Array) => undefined);
  const connection = new ComputerConnection(write);
  await connection.stopOwner("owner");
  const stop = JSON.parse(new TextDecoder().decode(write.mock.calls[0]?.[0]));
  assert.equal(stop.invocation.owner, "owner");
  assert.deepEqual(stop.command, { kind: "stop" });
  connection.receive(
    new TextEncoder().encode(JSON.stringify({ id: stop.id, result: { kind: "completed" } }) + "\n"),
  );
  connection.close();
  await connection.stopOwner("owner");
  assert.equal(write.mock.calls.length, 1);
});
