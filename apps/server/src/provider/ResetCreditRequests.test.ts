import {
  type OrchestrationV2StoredEvent,
  ProviderDriverKind,
  EnvironmentId,
  TurnItemId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderDriverError } from "./Errors.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ResetCreditRequests from "./ResetCreditRequests.ts";
import { ProviderToolkit } from "../mcp/toolkits/provider/tools.ts";
import * as ProviderHandlers from "../mcp/toolkits/provider/handlers.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

const threadId = ThreadId.make("thread:reset-request");
const instanceId = ProviderInstanceId.make("zcode");
const runId = RunId.make("run:reset-request");
const rootNodeId = "node:reset-request-root" as const;

interface TestCard {
  readonly requestStatus: "pending" | "approved" | "declined" | "cancelled";
  readonly outcome?: string;
  readonly warning?: string;
  readonly resetAccountIdentity?: string | undefined;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly runId: string;
}

const testTurnItem = (card: TestCard, cardId: string) =>
  ({
    id: cardId,
    type: "reset_credit_request" as const,
    threadId,
    runId: card.runId,
    nodeId: rootNodeId,
    label: "Redeem a weekly quota reset",
    reason: "test",
    providerInstanceId: card.providerInstanceId ?? instanceId,
    resetAccountIdentity: card.resetAccountIdentity,
    resetWindowId: "weekly" as const,
    requestStatus: card.requestStatus,
    ...(card.outcome === undefined ? {} : { outcome: card.outcome }),
    ...(card.warning === undefined ? {} : { warning: card.warning }),
    status:
      card.requestStatus === "pending"
        ? ("waiting" as const)
        : card.requestStatus === "approved"
          ? ("completed" as const)
          : ("cancelled" as const),
  }) as never;

interface Harness {
  readonly runs: Ref.Ref<
    ReadonlyArray<{ id: string; status: string; ordinal: number; rootNodeId: string }>
  >;
  readonly cards: Ref.Ref<ReadonlyMap<string, TestCard>>;
  /** Answers every pending card, the way a committed answer event would. */
  readonly cardAnswered: (status: TestCard["requestStatus"]) => Effect.Effect<void>;
  /** Ends the asking run, the way a committed terminal run event would. */
  readonly askingRunEnded: (status: string) => Effect.Effect<void>;
  readonly pendingRecorded: Effect.Effect<void>;
  readonly windows: Ref.Ref<
    ReadonlyArray<{ id: string; availableCount: number | null }> | undefined
  >;
  readonly redemptions: Ref.Ref<ReadonlyArray<{ windowId: string; idempotencyKey?: string }>>;
  readonly redemptionOutcome: Ref.Ref<
    ReadonlyArray<
      | "reset"
      | "nothingToReset"
      | "noCredit"
      | "alreadyRedeemed"
      | "driver-error"
      | "uncertain-error"
    >
  >;
  readonly instance: Ref.Ref<
    | {
        readonly enabled: boolean;
        readonly driverKind: string;
        readonly displayName: string;
        readonly redeemable: boolean;
      }
    | undefined
  >;
  readonly accountIdentity: Ref.Ref<string>;
  readonly route: Ref.Ref<ProviderInstanceId>;
  readonly inventoryState: Ref.Ref<"ok" | "notSignedIn" | "probeFailed">;
  readonly resetTime: Ref.Ref<string | undefined>;
  readonly layerService: Layer.Layer<ResetCreditRequests.ResetCreditRequests>;
}

const makeHarness = Effect.gen(function* () {
  const accountIdentity = yield* Ref.make("account-a");
  const route = yield* Ref.make(instanceId);
  const inventoryState = yield* Ref.make<"ok" | "notSignedIn" | "probeFailed">("ok");
  const resetTime = yield* Ref.make<string | undefined>(undefined);
  const runs = yield* Ref.make<
    ReadonlyArray<{ id: string; status: string; ordinal: number; rootNodeId: string }>
  >([{ id: runId, status: "running", ordinal: 1, rootNodeId }]);
  const cards = yield* Ref.make<ReadonlyMap<string, TestCard>>(new Map());
  const waiters = yield* Ref.make<ReadonlyArray<Deferred.Deferred<void, never>>>([]);
  const windows = yield* Ref.make<
    ReadonlyArray<{ id: string; availableCount: number | null }> | undefined
  >([]);
  const redemptions = yield* Ref.make<ReadonlyArray<{ windowId: string; idempotencyKey?: string }>>(
    [],
  );
  const redemptionOutcome = yield* Ref.make<
    ReadonlyArray<
      | "reset"
      | "nothingToReset"
      | "noCredit"
      | "alreadyRedeemed"
      | "driver-error"
      | "uncertain-error"
    >
  >(["reset"]);
  const instance = yield* Ref.make<
    | {
        readonly enabled: boolean;
        readonly driverKind: string;
        readonly displayName: string;
        readonly redeemable: boolean;
      }
    | undefined
  >({ enabled: true, driverKind: "zcode", displayName: "ZCode", redeemable: true });

  // The committed event stream the service waits on: the same replay-then-live
  // split the real sink uses, so a subscriber never misses nor duplicates an
  // answer committed around its subscription.
  const sequence = yield* Ref.make(0);
  const journal = yield* Ref.make<ReadonlyArray<OrchestrationV2StoredEvent>>([]);
  const live = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
  const publish = (event: {
    readonly type: string;
    readonly threadId: ThreadId;
    readonly payload: unknown;
  }) =>
    Effect.gen(function* () {
      const next = yield* Ref.updateAndGet(sequence, (n) => n + 1);
      const stored = { sequence: next, event } as OrchestrationV2StoredEvent;
      yield* Ref.update(journal, (events) => [...events, stored]);
      yield* PubSub.publish(live, stored);
    });

  const takeWaiter = Effect.gen(function* () {
    const current = yield* Ref.get(waiters);
    const [head, ...rest] = current;
    yield* Ref.set(waiters, rest);
    return head;
  });
  const pendingRecorded = Effect.gen(function* () {
    const waiter = yield* Deferred.make<void>();
    yield* Ref.update(waiters, (list) => [...list, waiter]);
    yield* Deferred.await(waiter);
  });

  const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (_id, _fields, options) =>
      Effect.gen(function* () {
        const currentRuns = yield* Ref.get(runs);
        const allCards = yield* Ref.get(cards);
        const wanted = new Set(options?.turnItemTypes ?? []);
        const turnItems = [...allCards.entries()]
          .filter(() => wanted.size === 0 || wanted.has("reset_credit_request"))
          .map(([id, card]) => testTurnItem(card, id));
        return {
          thread: { providerInstanceId: yield* Ref.get(route) },
          runs: currentRuns,
          turnItems,
        };
      }) as never,
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type !== "reset_credit_request.record")
          return { sequence: 0, storedEvents: [] };
        const id = command.turnItemId;
        yield* Ref.update(cards, (map) => {
          const existing = map.get(id);
          if (command.requestStatus === "pending" && existing !== undefined) return map;
          const next = new Map(map);
          next.set(id, {
            requestStatus: command.requestStatus,
            ...((command.resetAccountIdentity ?? existing?.resetAccountIdentity) === undefined
              ? {}
              : {
                  resetAccountIdentity:
                    command.resetAccountIdentity ?? existing?.resetAccountIdentity,
                }),
            providerInstanceId: command.providerInstanceId,
            ...(command.outcome === undefined ? {} : { outcome: command.outcome }),
            ...(command.warning === undefined ? {} : { warning: command.warning }),
            runId: command.runId ?? existing?.runId ?? runId,
          });
          return next;
        });
        if (command.requestStatus === "pending") {
          const waiter = yield* takeWaiter;
          if (waiter !== undefined) yield* Deferred.succeed(waiter, undefined);
        }
        if (command.requestStatus !== "pending") {
          const current = (yield* Ref.get(cards)).get(id)!;
          yield* publish({
            type: "turn-item.updated",
            threadId,
            payload: testTurnItem(current, id),
          });
        }
        return { sequence: 1, storedEvents: [] };
      }),
  });

  const layerEvents = Layer.mock(EventSink.EventSinkV2)({
    latestSequence: () => Ref.get(sequence) as never,
    stream: (input?: { threadId?: ThreadId; afterSequence?: number }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const afterSequence = input?.afterSequence ?? 0;
          const matches = (stored: OrchestrationV2StoredEvent) =>
            input?.threadId === undefined || stored.event.threadId === input.threadId;
          const subscription = yield* PubSub.subscribe(live);
          const highWater = yield* Ref.get(sequence);
          const replay = Stream.fromIterable(yield* Ref.get(journal)).pipe(
            Stream.filter(
              (stored) => stored.sequence > afterSequence && stored.sequence <= highWater,
            ),
            Stream.filter(matches),
          );
          const liveStream = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > highWater),
            Stream.filter(matches),
          );
          return Stream.concat(replay, liveStream);
        }),
      ) as never,
  });

  const layerProviderRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    refreshInstance: () =>
      Effect.gen(function* () {
        const currentWindows = yield* Ref.get(windows);
        const state = yield* Ref.get(inventoryState);
        const resetsAt = yield* Ref.get(resetTime);
        return [
          {
            instanceId,
            usageLimits: {
              checkedAt: "2026-10-17T12:00:00.000Z",
              ...(state === "ok" ? {} : { resetCreditWindowsUnavailable: { reason: state } }),
              windows: [
                {
                  id: "weekly",
                  kind: "weekly" as const,
                  label: "Weekly limit",
                  usedPercent: 100,
                  ...(resetsAt === undefined ? {} : { resetsAt }),
                },
              ],
              ...(currentWindows === undefined
                ? {}
                : {
                    resetCreditWindows: currentWindows.map((window) => ({
                      id: window.id,
                      label: window.id === "weekly" ? "Weekly resets" : "5-hour resets",
                      availableCount: window.availableCount,
                      canRedeem: true,
                    })),
                  }),
            },
          },
        ];
      }) as never,
  });

  const layerInstances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(instance);
        if (current === undefined) return undefined;
        return {
          instanceId,
          driverKind: current.driverKind,
          displayName: current.displayName,
          enabled: current.enabled,
          ...(current.redeemable
            ? {
                resetCreditAccountIdentity: Ref.get(accountIdentity),
                consumeResetCredit: (
                  windowId: string,
                  options?: {
                    readonly idempotencyKey?: string;
                    readonly expectedAccountIdentity?: string;
                  },
                ) =>
                  Effect.gen(function* () {
                    if (options?.expectedAccountIdentity !== (yield* Ref.get(accountIdentity)))
                      return yield* new ProviderDriverError({
                        driver: ProviderDriverKind.make("zcode"),
                        instanceId,
                        detail: "Account changed",
                        redemption: "refused",
                      });
                    const queued = yield* Ref.get(redemptionOutcome);
                    const outcome = queued[0] ?? "reset";
                    yield* Ref.set(redemptionOutcome, queued.slice(1));
                    const idempotencyKey = options?.idempotencyKey;
                    yield* Ref.update(redemptions, (list) => [
                      ...list,
                      {
                        windowId,
                        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                      },
                    ]);
                    if (outcome === "driver-error" || outcome === "uncertain-error") {
                      return yield* new ProviderDriverError({
                        driver: ProviderDriverKind.make("zcode"),
                        instanceId,
                        detail: "ZCode did not confirm the reset.",
                        redemption: outcome === "driver-error" ? "refused" : "unconfirmed",
                      });
                    }
                    return outcome;
                  }),
              }
            : {}),
        };
      }) as never,
  });

  const layerService = ResetCreditRequests.layer.pipe(
    Layer.provide(Layer.mergeAll(layerThreads, layerEvents, layerProviderRegistry, layerInstances)),
  );

  return {
    accountIdentity,
    route,
    inventoryState,
    resetTime,
    runs,
    cards,
    cardAnswered: (status: TestCard["requestStatus"]) =>
      Effect.gen(function* () {
        const answered: Array<readonly [string, TestCard]> = [];
        yield* Ref.update(cards, (map) => {
          const next = new Map(map);
          for (const [id, card] of map) {
            if (card.requestStatus === "pending") {
              const settled = { ...card, requestStatus: status };
              next.set(id, settled);
              answered.push([id, settled] as const);
            }
          }
          return next;
        });
        for (const [id, settled] of answered)
          yield* publish({
            type: "turn-item.updated",
            threadId,
            payload: testTurnItem(settled, id),
          });
      }),
    askingRunEnded: (status: string) =>
      Effect.gen(function* () {
        yield* Ref.set(runs, [{ id: runId, status, ordinal: 1, rootNodeId }]);
        yield* publish({
          type: "run.updated",
          payload: { id: runId, status, ordinal: 1, rootNodeId },
          threadId,
        } as never);
      }),
    pendingRecorded,
    windows,
    redemptions,
    redemptionOutcome,
    instance,
    layerService,
  } satisfies Harness;
});

const request = (input: {
  readonly resetWindowId?: "five_hour" | "weekly";
  readonly clientRequestId?: string;
  readonly timeoutMs?: number;
}) =>
  Effect.gen(function* () {
    const service = yield* ResetCreditRequests.ResetCreditRequests;
    return yield* service.request({
      requestNamespace: "test",
      threadId,
      providerInstanceId: instanceId,
      input,
    });
  });

describe("ResetCreditRequests", () => {
  it.effect("refuses to ask without an active run owned by the caller", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.runs, [{ id: runId, status: "completed", ordinal: 1, rootNodeId }]);
      const result = yield* request({ resetWindowId: "weekly" }).pipe(
        Effect.provide(harness.layerService),
        Effect.result,
      );
      assert.isTrue(result._tag === "Failure");
      assert.strictEqual(yield* Ref.get(harness.cards).pipe(Effect.map((m) => m.size)), 0);
    }),
  );

  it.effect("reports unsupported providers without asking or redeeming", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      for (const broken of [
        undefined,
        { enabled: false, driverKind: "zcode", displayName: "ZCode", redeemable: true },
        { enabled: true, driverKind: "codex", displayName: "Codex", redeemable: true },
        { enabled: true, driverKind: "zcode", displayName: "ZCode", redeemable: false },
      ]) {
        yield* Ref.set(harness.instance, broken);
        const result = yield* request({ resetWindowId: "weekly" }).pipe(
          Effect.provide(harness.layerService),
        );
        assert.strictEqual(result.status, "unsupported");
        assert.isDefined(result.note);
      }
      assert.strictEqual(yield* Ref.get(harness.cards).pipe(Effect.map((m) => m.size)), 0);
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
    }),
  );

  it.effect("does not ask when neither window holds a usable credit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [
        { id: "five_hour", availableCount: 0 },
        { id: "weekly", availableCount: 0 },
      ]);
      const result = yield* request({}).pipe(Effect.provide(harness.layerService));
      assert.strictEqual(result.status, "no_credit_available");
      assert.strictEqual(yield* Ref.get(harness.cards).pipe(Effect.map((m) => m.size)), 0);
    }),
  );

  it.effect("names the window back when several could be redeemed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [
        { id: "five_hour", availableCount: 1 },
        { id: "weekly", availableCount: 2 },
      ]);
      const result = yield* request({}).pipe(Effect.provide(harness.layerService));
      assert.strictEqual(result.status, "window_ambiguous");
      assert.strictEqual(result.resetCreditWindows?.length, 2);
      assert.strictEqual(yield* Ref.get(harness.cards).pipe(Effect.map((m) => m.size)), 0);
    }),
  );

  it.effect("asks, redeems on approval, and reports accepted without claiming recovery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
      const waited = yield* Effect.forkChild(
        request({ resetWindowId: "weekly" }).pipe(Effect.provide(harness.layerService)),
      );
      yield* harness.pendingRecorded;
      yield* harness.cardAnswered("approved");
      const result = yield* Fiber.join(waited);

      assert.strictEqual(result.status, "accepted");
      assert.strictEqual(result.outcome, "reset");
      assert.isFalse(result.verifiedRecovery);
      assert.match(result.note ?? "", /not verified recovery/);
      assert.strictEqual(result.resetWindowId, "weekly");
      // The redemption carries the card's pinned key, so a retry of the same
      // approved intent re-sends it instead of spending a second credit.
      const redemptions = yield* Ref.get(harness.redemptions);
      assert.strictEqual(redemptions.length, 1);
      assert.match(redemptions[0]!.idempotencyKey ?? "", /^[0-9a-f]{32}$/);
      // The card records the outcome for later replays.
      const cards = yield* Ref.get(harness.cards);
      const card = [...cards.values()][0]!;
      assert.strictEqual(card.requestStatus, "approved");
      assert.strictEqual(card.outcome, "reset");
    }),
  );

  it.effect("a declined card never redeems", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
      const waited = yield* Effect.forkChild(
        request({ resetWindowId: "weekly" }).pipe(Effect.provide(harness.layerService)),
      );
      yield* harness.pendingRecorded;
      yield* harness.cardAnswered("declined");
      const result = yield* Fiber.join(waited);
      assert.strictEqual(result.status, "declined");
      assert.strictEqual(result.outcome, undefined);
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
    }),
  );

  it.effect("the card ends with the run, and no redemption happens", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
      const waited = yield* Effect.forkChild(
        request({ resetWindowId: "weekly" }).pipe(Effect.provide(harness.layerService)),
      );
      yield* harness.pendingRecorded;
      yield* harness.askingRunEnded("interrupted");
      const result = yield* Fiber.join(waited);
      assert.strictEqual(result.status, "approval_cancelled");
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
      const card = [...(yield* Ref.get(harness.cards)).values()][0]!;
      assert.strictEqual(card.requestStatus, "cancelled");
    }),
  );

  it.effect(
    "a replay of the same approved intent returns the recorded answer, not a second credit",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
        const first = yield* Effect.forkChild(
          request({ resetWindowId: "weekly", clientRequestId: "same-intent" }).pipe(
            Effect.provide(harness.layerService),
          ),
        );
        yield* harness.pendingRecorded;
        yield* harness.cardAnswered("approved");
        yield* Fiber.join(first);

        const replay = yield* request({
          resetWindowId: "weekly",
          clientRequestId: "same-intent",
        }).pipe(Effect.provide(harness.layerService));
        assert.strictEqual(replay.status, "accepted");
        assert.strictEqual(replay.outcome, "reset");
        assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
      }),
  );

  it.effect(
    "a concurrent duplicate queues onto the settled answer instead of redeeming twice",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 2 }]);
        const original = yield* Effect.forkChild(
          request({ resetWindowId: "weekly", clientRequestId: "dup" }).pipe(
            Effect.provide(harness.layerService),
          ),
        );
        yield* harness.pendingRecorded;
        const duplicate = yield* Effect.forkChild(
          request({ resetWindowId: "weekly", clientRequestId: "dup" }).pipe(
            Effect.provide(harness.layerService),
          ),
        );
        yield* harness.cardAnswered("approved");
        const originalResult = yield* Fiber.join(original);
        const duplicateResult = yield* Fiber.join(duplicate);
        assert.strictEqual(originalResult.status, "accepted");
        assert.strictEqual(duplicateResult.status, "accepted");
        // The duplicate queues behind the per-card lock and replays the recorded
        // outcome; the provider sees exactly one redemption.
        assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
      }),
  );

  it.effect("a later, separately approved reset is a new card and a new redemption", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 3 }]);
      yield* Ref.set(harness.redemptionOutcome, ["reset", "reset"]);
      for (const clientRequestId of ["first-approval", "second-approval"]) {
        const waited = yield* Effect.forkChild(
          request({ resetWindowId: "weekly", clientRequestId }).pipe(
            Effect.provide(harness.layerService),
          ),
        );
        yield* harness.pendingRecorded;
        yield* harness.cardAnswered("approved");
        const result = yield* Fiber.join(waited);
        assert.strictEqual(result.status, "accepted");
      }
      // Two separately approved cards each redeemed once, with distinct keys.
      const redemptions = yield* Ref.get(harness.redemptions);
      assert.strictEqual(redemptions.length, 2);
      assert.notStrictEqual(redemptions[0]!.idempotencyKey, redemptions[1]!.idempotencyKey);
    }),
  );

  it.effect("a timeout closes the card and reports approval_timed_out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
      const waited = yield* Effect.forkChild(
        request({ resetWindowId: "weekly", timeoutMs: 1_000 }).pipe(
          Effect.provide(harness.layerService),
        ),
      );
      yield* harness.pendingRecorded;
      // The wait runs on the test clock: advancing it past the ask's timeout
      // is what fires it, so the test sleeps nowhere.
      yield* TestClock.adjust(Duration.millis(1_001));
      const result = yield* Fiber.join(waited);
      assert.strictEqual(result.status, "approval_timed_out");
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
      const card = [...(yield* Ref.get(harness.cards)).values()][0]!;
      assert.strictEqual(card.requestStatus, "cancelled");
    }),
  );

  it.effect("an approved redemption the provider refuses is reported as failed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
      yield* Ref.set(harness.redemptionOutcome, ["driver-error"]);
      const waited = yield* Effect.forkChild(
        request({ resetWindowId: "weekly" }).pipe(Effect.provide(harness.layerService)),
      );
      yield* harness.pendingRecorded;
      yield* harness.cardAnswered("approved");
      const result = yield* Fiber.join(waited);
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(result.outcome, undefined);
      // The note is the driver's fixed text, never a credential-bearing cause.
      assert.strictEqual(result.note, "The provider reported failed. ");
      const card = [...(yield* Ref.get(harness.cards)).values()][0]!;
      assert.strictEqual(card.requestStatus, "approved");
      assert.strictEqual(card.outcome, "failed");
      assert.strictEqual(
        (yield* request({ resetWindowId: "weekly" }).pipe(Effect.provide(harness.layerService)))
          .status,
        "failed",
      );
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
    }),
  );
  it.effect(
    "never POSTs an uncertain approved intent again, including immediate and concurrent replays",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
        yield* Ref.set(harness.redemptionOutcome, ["uncertain-error", "reset"]);
        yield* Effect.gen(function* () {
          const first = yield* Effect.forkChild(
            request({ resetWindowId: "weekly", clientRequestId: "lost" }),
          );
          yield* harness.pendingRecorded;
          yield* harness.cardAnswered("approved");
          const uncertain = yield* Fiber.join(first);
          assert.strictEqual(uncertain.status, "unconfirmed");
          assert.isFalse(uncertain.verifiedRecovery);
          assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
          const retry = yield* request({ clientRequestId: "lost" });
          assert.strictEqual(retry.status, "unconfirmed");
          assert.isFalse(retry.verifiedRecovery);
          const settled = yield* request({ clientRequestId: "lost" });
          assert.strictEqual(settled.status, "unconfirmed");
          const posts = yield* Ref.get(harness.redemptions);
          yield* Effect.all(
            [request({ clientRequestId: "lost" }), request({ clientRequestId: "lost" })],
            { concurrency: "unbounded" },
          );
          assert.strictEqual(posts.length, 1);
          assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
          assert.strictEqual((yield* Ref.get(harness.cards)).size, 1);
        }).pipe(Effect.provide(harness.layerService));
      }),
  );

  it.effect("does not retry persisted uncertainty after service restart", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
      yield* Ref.set(harness.redemptionOutcome, ["uncertain-error", "reset"]);
      const first = yield* Effect.forkChild(
        request({ resetWindowId: "weekly", clientRequestId: "restart" }).pipe(
          Effect.provide(harness.layerService),
        ),
      );
      yield* harness.pendingRecorded;
      yield* harness.cardAnswered("approved");
      assert.strictEqual((yield* Fiber.join(first)).status, "unconfirmed");
      const replay = yield* request({ clientRequestId: "restart" }).pipe(
        Effect.provide(harness.layerService),
      );
      assert.strictEqual(replay.status, "unconfirmed");
      assert.match(replay.note ?? "", /retention is undocumented/);
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
    }),
  );

  it.effect("carries exhausted quota type and unknown reset timezone separately from credits", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 0 }]);
      const result = yield* request({}).pipe(Effect.provide(harness.layerService));
      assert.strictEqual(result.quotaState, "supported");
      assert.deepStrictEqual(result.quotaSchedule, [
        { id: "weekly", kind: "weekly", exhausted: true, timezone: "unknown" },
      ]);
      assert.strictEqual(result.status, "no_credit_available");
    }),
  );
});

it.effect.each(["notSignedIn", "probeFailed"] as const)(
  "distinguishes unreadable inventory: %s",
  (state) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.inventoryState, state);
      const result = yield* request({ resetWindowId: "weekly" }).pipe(
        Effect.provide(harness.layerService),
      );
      assert.strictEqual(result.status, state === "probeFailed" ? "error" : "unavailable");
      assert.strictEqual(result.resetCreditWindowsUnavailable?.reason, state);
      assert.strictEqual((yield* Ref.get(harness.cards)).size, 0);
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
    }),
);

it.effect.each(["2026-10-19T02:53:07Z", "2026-10-19 02:53:07"])(
  "does not invent a timezone: %s",
  (resetsAt) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.resetTime, resetsAt);
      const result = yield* request({}).pipe(Effect.provide(harness.layerService));
      assert.strictEqual(result.quotaSchedule?.[0]?.resetsAt, resetsAt);
      assert.strictEqual(
        result.quotaSchedule?.[0]?.timezone,
        resetsAt.endsWith("Z") ? "explicit" : "unknown",
      );
    }),
);

it.effect(
  "MCP pins the route to its invoking full-access thread and still waits for a human answer",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
      const dependencies = Layer.mergeAll(
        harness.layerService,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "test",
          thread: { threadId, providerInstanceId: instanceId, providerSessionId: "session" },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              providerInstanceId: instanceId,
              activeRunId: runId,
              archivedAt: null,
              deletedAt: null,
              runtimeMode: "full-access",
              interactionMode: "default",
            } as OrchestrationV2ThreadShell),
        }),
      );
      yield* Effect.gen(function* () {
        const toolkit = yield* ProviderToolkit.pipe(
          Effect.provide(McpToolAccess.HandlersLayer.layer(ProviderHandlers.layer)),
        );
        const call = yield* Effect.forkChild(
          toolkit
            .handle("provider_request_quota_reset", {
              resetWindowId: "weekly",
              clientRequestId: "mcp-human",
            })
            .pipe(Stream.unwrap, Stream.runCollect),
        );
        yield* harness.pendingRecorded;
        assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
        const cards = yield* Ref.get(harness.cards);
        const id = [...cards.keys()][0]!;
        const service = yield* ResetCreditRequests.ResetCreditRequests;
        yield* service.answer({
          threadId,
          turnItemId: TurnItemId.make(id),
          answer: { type: "approve" },
        });
        const output = yield* Fiber.join(call);
        assert.deepInclude(output.at(-1)?.result, { status: "accepted" });
        assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
      }).pipe(Effect.provide(dependencies));
    }),
);

it.effect("an expired uncertain intent stays uncertain without another POST or approval", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
    yield* Ref.set(harness.redemptionOutcome, ["uncertain-error", "reset"]);
    yield* Effect.gen(function* () {
      const first = yield* Effect.forkChild(
        request({ resetWindowId: "weekly", clientRequestId: "expired" }),
      );
      yield* harness.pendingRecorded;
      yield* harness.cardAnswered("approved");
      assert.strictEqual((yield* Fiber.join(first)).status, "unconfirmed");
      yield* TestClock.adjust("61 seconds");
      assert.strictEqual((yield* request({ clientRequestId: "expired" })).status, "unconfirmed");
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
      assert.strictEqual((yield* Ref.get(harness.cards)).size, 1);
    }).pipe(Effect.provide(harness.layerService));
  }),
);

it.effect("a preserved approval without an attempt record cannot assume no POST occurred", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(
      harness.cards,
      new Map([
        [
          "turn-item:reset-credit-request:test:thread%3Areset-request:legacy",
          { requestStatus: "approved", runId },
        ],
      ]),
    );
    const result = yield* request({ clientRequestId: "legacy" }).pipe(
      Effect.provide(harness.layerService),
    );
    assert.strictEqual(result.status, "unconfirmed");
    assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
  }),
);

it.effect("rejects a different provider route before replaying an approved card", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
    yield* Effect.gen(function* () {
      const first = yield* Effect.forkChild(request({ clientRequestId: "route" }));
      yield* harness.pendingRecorded;
      yield* harness.cardAnswered("approved");
      assert.strictEqual((yield* Fiber.join(first)).status, "accepted");
      const service = yield* ResetCreditRequests.ResetCreditRequests;
      const replay = yield* service.request({
        requestNamespace: "test",
        threadId,
        providerInstanceId: ProviderInstanceId.make("another-provider"),
        input: { clientRequestId: "route" },
      });
      assert.strictEqual(replay.status, "unavailable");
      assert.isUndefined(replay.quotaBefore);
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 1);
    }).pipe(Effect.provide(harness.layerService));
  }),
);
it.effect("does not redeem if the native account changes while awaiting approval", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
    yield* Effect.gen(function* () {
      const first = yield* Effect.forkChild(request({ clientRequestId: "account-change" }));
      yield* harness.pendingRecorded;
      yield* Ref.set(harness.accountIdentity, "account-b");
      yield* harness.cardAnswered("approved");
      assert.strictEqual((yield* Fiber.join(first)).status, "failed");
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
    }).pipe(Effect.provide(harness.layerService));
  }),
);

it.effect("does not redeem if the thread route changes while awaiting approval", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
    yield* Effect.gen(function* () {
      const first = yield* Effect.forkChild(request({ clientRequestId: "route-change" }));
      yield* harness.pendingRecorded;
      yield* Ref.set(harness.route, ProviderInstanceId.make("another-provider"));
      yield* harness.cardAnswered("approved");
      assert.strictEqual((yield* Fiber.join(first)).status, "unavailable");
      assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
    }).pipe(Effect.provide(harness.layerService));
  }),
);

it.effect("a persisted pending approval without account binding cannot sample a new account", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.windows, [{ id: "weekly", availableCount: 1 }]);
    yield* Effect.gen(function* () {
      const first = yield* Effect.forkChild(request({ clientRequestId: "old-pending" }));
      yield* harness.pendingRecorded;
      yield* Fiber.interrupt(first);
    }).pipe(Effect.provide(harness.layerService));
    yield* Ref.update(
      harness.cards,
      (cards) =>
        new Map(
          [...cards].map(([id, card]) => [
            id,
            { requestStatus: "pending" as const, runId: card.runId },
          ]),
        ),
    );
    yield* Ref.set(harness.accountIdentity, "account-b");
    const result = yield* request({ clientRequestId: "old-pending" }).pipe(
      Effect.provide(harness.layerService),
    );
    assert.strictEqual(result.status, "unavailable");
    assert.strictEqual((yield* Ref.get(harness.redemptions)).length, 0);
  }),
);
