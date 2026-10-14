/**
 * The T3 MCP credential each thread's provider session should expose to its
 * agent. The session manager writes it before a session starts; adapters read
 * it when they build provider launch options.
 *
 * @module provider-core/server/McpProviderSessions
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Observes credential revocations: replacing a session with a different
     * `providerSessionId`, or clearing one, notifies once with the revoked
     * session. Listener failures never prevent provider cleanup.
     */
    readonly subscribeRevocations: (
      listener: (session: McpProviderSessionConfig) => void,
    ) => Effect.Effect<() => void>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const revocationListeners = new Set<(session: McpProviderSessionConfig) => void>();
  const notifyRevoked = (session: McpProviderSessionConfig): void => {
    for (const listener of revocationListeners) {
      try {
        listener(session);
      } catch {
        /* Revocation must not prevent provider cleanup. */
      }
    }
  };
  return McpProviderSessions.of({
    set: (config) =>
      Ref.modify(sessions, (current) => {
        const previous = current.get(config.threadId);
        const next = new Map(current).set(config.threadId, config);
        const notify =
          previous !== undefined && previous.providerSessionId !== config.providerSessionId
            ? () => notifyRevoked(previous)
            : undefined;
        return [notify, next] as const;
      }).pipe(Effect.flatMap((notify) => (notify ? Effect.sync(notify) : Effect.void))),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.modify(sessions, (current) => {
        const previous = current.get(threadId);
        const next = new Map(current);
        next.delete(threadId);
        return [previous, next] as const;
      }).pipe(
        Effect.flatMap((previous) =>
          previous !== undefined ? Effect.sync(() => notifyRevoked(previous)) : Effect.void,
        ),
      ),
    subscribeRevocations: (listener) =>
      Effect.sync(() => {
        revocationListeners.add(listener);
        return () => {
          revocationListeners.delete(listener);
        };
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
