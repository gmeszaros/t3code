import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: the run that asks stays unstarted, which is all the card
// dispatch needs — it validates the run and commits turn-item events.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "reset-credit-card" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const threadId = ThreadId.make("thread:reset-card");

/** A thread with one unstarted run, and the run's root node id. */
const makeAskingThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:reset-card"),
    title: threadId,
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${threadId}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}`),
    text: "The weekly quota is exhausted; may I spend a reset credit?",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
  return { runId: RunId.make(run.id), nodeId: NodeId.make(run.rootNodeId!) };
});

const record = (
  asking: { readonly runId: RunId; readonly nodeId: NodeId },
  fields: {
    readonly turnItemId: TurnItemId;
    readonly requestStatus: "pending" | "approved" | "declined" | "cancelled";
    readonly outcome?:
      | "reset"
      | "nothingToReset"
      | "noCredit"
      | "alreadyRedeemed"
      | "failed"
      | "unconfirmed";
    readonly label?: string;
  },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "reset_credit_request.record",
      commandId: CommandId.make(
        `${fields.turnItemId}:${fields.requestStatus}:${yield* nextSuffix}`,
      ),
      threadId,
      runId: asking.runId,
      nodeId: asking.nodeId,
      turnItemId: fields.turnItemId,
      label: fields.label ?? "Redeem a weekly quota reset",
      reason: "An agent in this thread asked to spend one reset credit.",
      providerInstanceId: instanceId,
      resetWindowId: "weekly",
      requestStatus: fields.requestStatus,
      ...(fields.outcome === undefined ? {} : { outcome: fields.outcome }),
    });
  });

let suffix = 0;
const nextSuffix = Effect.sync(() => (suffix += 1));

const card = (turnItemId: TurnItemId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return (
      projection.turnItems.find(
        (item): item is Extract<typeof item, { readonly type: "reset_credit_request" }> =>
          item.id === turnItemId && item.type === "reset_credit_request",
      ) ?? null
    );
  });

it.effect("a reset card is asked once, answered once, and its outcome recorded once", () =>
  Effect.gen(function* () {
    const asking = yield* makeAskingThread;
    const turnItemId = TurnItemId.make("turn-item:reset-credit-request:card-lifecycle");

    // The ask commits a pending card.
    yield* record(asking, { turnItemId, requestStatus: "pending" });
    const pending = yield* card(turnItemId);
    assert.strictEqual(pending?.requestStatus, "pending");
    assert.strictEqual(pending?.status, "waiting");
    assert.strictEqual(pending?.completedAt, null);

    // A re-ask of the same card changes nothing: no new label, no answer.
    yield* record(asking, { turnItemId, requestStatus: "pending", label: "A different label" });
    const reasked = yield* card(turnItemId);
    assert.strictEqual(reasked?.requestStatus, "pending");
    assert.strictEqual(reasked?.label, "Redeem a weekly quota reset");
    assert.deepStrictEqual(reasked, pending);

    // The user approves: the card settles completed.
    yield* record(asking, { turnItemId, requestStatus: "approved" });
    const approved = yield* card(turnItemId);
    assert.strictEqual(approved?.requestStatus, "approved");
    assert.strictEqual(approved?.status, "completed");
    assert.isDefined(approved?.completedAt);

    // Answered is answered once: a later decline cannot overwrite it.
    yield* record(asking, { turnItemId, requestStatus: "declined" });
    assert.strictEqual((yield* card(turnItemId))?.requestStatus, "approved");

    // The redemption outcome lands on the approved card exactly once.
    yield* record(asking, { turnItemId, requestStatus: "approved", outcome: "reset" });
    const reset = yield* card(turnItemId);
    assert.strictEqual(reset?.outcome, "reset");
    assert.strictEqual(reset?.requestStatus, "approved");
    yield* record(asking, { turnItemId, requestStatus: "approved", outcome: "failed" });
    assert.strictEqual((yield* card(turnItemId))?.outcome, "reset");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a card record for a node that is not the run's root is refused", () =>
  Effect.gen(function* () {
    const asking = yield* makeAskingThread;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const result = yield* Effect.exit(
      orchestrator.dispatch({
        type: "reset_credit_request.record",
        commandId: CommandId.make("reset-card:wrong-node"),
        threadId,
        runId: asking.runId,
        nodeId: NodeId.make("node:not-the-root"),
        turnItemId: TurnItemId.make("turn-item:reset-credit-request:wrong-node"),
        label: "Redeem a weekly quota reset",
        reason: "An agent in this thread asked to spend one reset credit.",
        providerInstanceId: instanceId,
        resetWindowId: "weekly",
        requestStatus: "pending",
      }),
    );
    assert.isTrue(Exit.isFailure(result));
    assert.isNull(yield* card(TurnItemId.make("turn-item:reset-credit-request:wrong-node")));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an uncertain redemption may settle but a confirmed refusal cannot be retried", () =>
  Effect.gen(function* () {
    const asking = yield* makeAskingThread;
    const uncertain = TurnItemId.make("turn-item:reset-credit-request:uncertain");
    yield* record(asking, { turnItemId: uncertain, requestStatus: "pending" });
    yield* record(asking, { turnItemId: uncertain, requestStatus: "approved" });
    yield* record(asking, {
      turnItemId: uncertain,
      requestStatus: "approved",
      outcome: "unconfirmed",
    });
    assert.strictEqual((yield* card(uncertain))?.outcome, "unconfirmed");
    yield* record(asking, { turnItemId: uncertain, requestStatus: "approved", outcome: "reset" });
    assert.strictEqual((yield* card(uncertain))?.outcome, "reset");
    yield* record(asking, {
      turnItemId: uncertain,
      requestStatus: "approved",
      outcome: "unconfirmed",
    });
    assert.strictEqual((yield* card(uncertain))?.outcome, "reset");
    const refused = TurnItemId.make("turn-item:reset-credit-request:refused");
    yield* record(asking, { turnItemId: refused, requestStatus: "pending" });
    yield* record(asking, { turnItemId: refused, requestStatus: "approved", outcome: "failed" });
    yield* record(asking, { turnItemId: refused, requestStatus: "approved", outcome: "reset" });
    assert.strictEqual((yield* card(refused))?.outcome, "failed");
  }).pipe(Effect.provide(layerTest)),
);
