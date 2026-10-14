import { assert, it } from "@effect/vitest";

import { ComputerMessageReader, encodeComputerMessage } from "./computerProtocol.ts";

it("decodes split UTF-8 and coalesced messages without corrupting application names", () => {
  const bytes = encodeComputerMessage({ application: "Árvíztűrő" }, 100);
  const reader = new ComputerMessageReader(100);
  const lines = [...bytes].flatMap((byte) => reader.push(new Uint8Array([byte])));
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [{ application: "Árvíztűrő" }],
  );
  assert.deepEqual(reader.push(new TextEncoder().encode('{"a":1}\n{"a":2}\n')), [
    '{"a":1}',
    '{"a":2}',
  ]);
});

it("rejects an oversized partial frame and cannot be reused after protocol failure", () => {
  const reader = new ComputerMessageReader(10);
  reader.push(new TextEncoder().encode("123456"));
  assert.throws(() => reader.push(new TextEncoder().encode("78901")), /invalid or oversized/);
  assert.throws(() => reader.push(new TextEncoder().encode("{}\n")), /closed/);
});

it("checks complete frame sizes even when a newline is present", () => {
  const reader = new ComputerMessageReader(10);
  assert.throws(
    () => reader.push(new TextEncoder().encode("12345678901\n")),
    /invalid or oversized/,
  );
});

it("rejects malformed UTF-8 without reflecting source bytes in the error", () => {
  const reader = new ComputerMessageReader(100);
  assert.throws(() => reader.push(new Uint8Array([0xff, 0x0a])), /invalid or oversized/);
});

it("bounds outbound messages and discards partial input on shutdown", () => {
  assert.throws(() => encodeComputerMessage({ text: "x".repeat(100) }, 10), /limit/);
  const reader = new ComputerMessageReader(100);
  reader.push(new TextEncoder().encode('{"partial":'));
  reader.close();
  assert.throws(() => reader.push(new TextEncoder().encode("true}\n")), /closed/);
});
