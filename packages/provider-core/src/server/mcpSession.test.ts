import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { layer as mcpProviderSessionsLayer, McpProviderSessions } from "./McpProviderSessions.ts";
import type { McpProviderSessionConfig } from "./mcpSession.ts";
import { withAgentDeviceEnvironment } from "./mcpSession.ts";
describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("session revocations", () => {
  it.effect("revokes replaced and closed provider sessions exactly once", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("computer-revocation-test");
      const session: McpProviderSessionConfig = {
        threadId,
        environmentId: EnvironmentId.make("test"),
        providerInstanceId: ProviderInstanceId.make("zcode"),
        providerSessionId: "first",
        endpoint: "http://unused.test/mcp",
        authorizationHeader: "test-only",
        browserToolsAvailable: true,
        capabilities: new Set<string>(),
      };
      const sessions = yield* McpProviderSessions;
      const revoked: string[] = [];
      const unsubscribe = yield* sessions.subscribeRevocations((value) =>
        revoked.push(value.providerSessionId),
      );
      try {
        yield* sessions.set(session);
        yield* sessions.set(session);
        yield* sessions.set({ ...session, providerSessionId: "second" });
        yield* sessions.clear(threadId);
        yield* sessions.clear(threadId);
        expect(revoked).toEqual(["first", "second"]);
      } finally {
        unsubscribe();
        yield* sessions.clear(threadId);
      }
    }).pipe(Effect.provide(mcpProviderSessionsLayer)),
  );
});
