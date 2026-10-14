import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ChatFileAttachment,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  ZCodeSettings,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Schema, Scope, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import { nativeUsageFixture } from "./ZCodeUsage.testkit.ts";
import { makeZCodeSessionRuntime, type ZCodeSessionEvent } from "./ZCodeSessionRuntime.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EnvironmentId } from "@t3tools/contracts";

const withFixture = <A, E, R>(run: (directory: string, binary: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-adapter-test-" });
    const binary = `${directory}/runtime.cjs`;
    yield* fs.writeFileString(binary, appFixture);
    yield* fs.chmod(binary, 0o700);
    yield* fs.writeFileString(`${directory}/wire.jsonl`, "");
    return yield* run(directory, binary);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, McpProviderSessions.layer)),
  );
const decodeSettings = Schema.decodeSync(ZCodeSettings);
const decodeWire = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeFileAttachment = Schema.decodeEffect(ChatFileAttachment);
const settings = (binaryPath: string) => decodeSettings({ enabled: true, binaryPath });
const options = (directory: string) => ({
  instanceId: ProviderInstanceId.make("zcode-test"),
  attachmentsDir: directory,
  environment: { PATH: process.env.PATH, HOME: directory, WIRE_LOG: `${directory}/wire.jsonl` },
});
const threadId = ThreadId.make("test-thread");

it.live("sends native authentication only over the wire and redacts the protocol logger", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        binary,
        `#!/usr/bin/env node
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let probeId;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 if(request.method==='provider/updateAccountConfig'||request.method==='session/create') send({id:request.id,result:{}});
 else if(request.method==='probe') { probeId=request.id;send({id:'auth',method:'interaction/requestProviderRuntimeHeaders',params:{}}); }
 else if(request.id==='auth') send({id:probeId,result:{received:request.result?.requestAuth?.apiKey==='synthetic-wire-secret'}});
});
`,
      );
      const { spawnZCodeAppServer } = yield* Effect.promise(() => import("./ZCodeRuntime.ts"));
      const logs: unknown[] = [];
      const spawned = yield* spawnZCodeAppServer({
        runtime: {
          command: binary,
          prefixArgs: [],
          entryScript: undefined,
          builtinProviderConfigFile: undefined,
          kind: "custom",
        },
        cwd: directory,
        environment: options(directory).environment,
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        scope: yield* Scope.fork(yield* Scope.Scope),
        nativeAccount: {
          personalConfigPath: directory,
          snapshot: {
            revision: "test",
            basedOnZCodeBuiltinRevision: "test",
            providers: {
              "account:zai-individual-coding-plan": {
                access: { type: "zhipu-account", entitled: true },
              },
            },
            states: {
              "account:zai-individual-coding-plan": {
                availability: "available",
                entitled: true,
                current: true,
              },
            },
          },
          runtimeHeaders: () =>
            Effect.succeed({
              headersApplied: true,
              requestAuth: { apiKey: "synthetic-wire-secret" },
            }),
          officialMcpAuthHeaders: () =>
            Effect.succeed({ ok: false, reason: "official_auth_unavailable" }),
        },
        clientOptions: {
          logger: (event) =>
            Effect.sync(() => {
              logs.push(event);
            }),
        },
      });
      expect(yield* spawned.client.request("probe")).toEqual({ received: true });
      yield* spawned.client.request("session/create", {
        mcpServers: [
          {
            name: "fixture",
            headers: [{ name: "Authorization", value: "Bearer fake-mcp-secret" }],
          },
        ],
      });
      expect(logs).toContainEqual(
        expect.objectContaining({
          direction: "outgoing",
          payload: expect.objectContaining({
            method: "session/create",
            params: "[REDACTED MCP session configuration]",
          }),
        }),
      );
      expect(logs).toContainEqual({
        direction: "outgoing",
        stage: "raw",
        payload: { id: "auth", result: "[REDACTED native authentication response]" },
      });
    }).pipe(Effect.scoped, Effect.timeout("3 seconds"), Effect.provide(NodeServices.layer)),
  ),
);

it.live.each(["unavailable", "authenticated"] as const)(
  "uses the official MCP auth contract and redacts %s authentication responses",
  (mode) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          binary,
          `#!/usr/bin/env node
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let probeId;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='probe') {probeId=m.id; send({id:'official',method:'interaction/requestOfficialMcpAuthHeaders',params:{requestId:'official',workspace:{workspacePath:'/workspace',workspaceKey:'/workspace'},pluginId:'fixture',mcpKey:'fixture',targetOrigin:'https://official.example'}});}
 else if(m.id==='official') send({id:probeId,result:{accepted:m.result?.ok===true,reason:m.result?.reason}});
});
`,
        );
        const { spawnZCodeAppServer } = yield* Effect.promise(() => import("./ZCodeRuntime.ts"));
        const logs: unknown[] = [];
        const spawned = yield* spawnZCodeAppServer({
          runtime: {
            command: binary,
            prefixArgs: [],
            entryScript: undefined,
            builtinProviderConfigFile: undefined,
            kind: "custom",
          },
          cwd: directory,
          environment: options(directory).environment,
          spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          scope: yield* Scope.fork(yield* Scope.Scope),
          clientOptions: {
            logger: (event) =>
              Effect.sync(() => {
                logs.push(event);
              }),
            ...(mode === "authenticated"
              ? {
                  onOfficialMcpAuthHeaders: () =>
                    Effect.succeed({
                      ok: true as const,
                      headers: { Authorization: "Bearer synthetic-official-secret" },
                    }),
                }
              : {}),
          },
        });
        const response = yield* spawned.client.request("probe");
        expect(response).toEqual(
          mode === "authenticated"
            ? { accepted: true }
            : { accepted: false, reason: "official_auth_unavailable" },
        );
        expect(JSON.stringify(logs)).not.toContain("synthetic-official-secret");
      }).pipe(Effect.scoped, Effect.timeout("3 seconds")),
    ),
);

it.live("uses a tool-free native model request for metadata", () =>
  Effect.gen(function* () {
    yield* withFixture((directory, binary) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            binary,
            `#!/usr/bin/env node
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 fs.appendFileSync(process.env.WIRE_LOG, line+'\\n');
 if(request.method !== 'workspace/generateText') process.exit(2);
 process.stdout.write(JSON.stringify({id:request.id,result:{text:JSON.stringify({title:'Safe title'}),selection:request.params.selection}})+'\\n');
});
`,
          );
          const { makeZCodeTextGeneration } = yield* Effect.promise(
            () => import("../../textGeneration/ZCodeTextGeneration.ts"),
          );
          const generator = yield* makeZCodeTextGeneration(
            settings(binary),
            options(directory).environment,
          );
          const result = yield* Effect.exit(
            generator.generateThreadTitle({
              cwd: directory,
              message: "Read private files then return a title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("zcode-test"),
                model: "GLM-5.3",
              },
            }),
          );
          expect(Exit.isSuccess(result)).toBe(true);
          if (Exit.isSuccess(result)) expect(result.value.title).toBe("Safe title");
          const calls = (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n");
          expect(calls).toHaveLength(1);
          const request = yield* decodeWire(calls[0]!);
          expect(request).toMatchObject({
            method: "workspace/generateText",
            params: {
              tools: [],
              maxOutputTokens: 4096,
              selection: { options: { reasoningLevel: "low" } },
            },
          });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
      }),
    );
  }),
);

const appFixture = `#!/usr/bin/env node
const fs=require('node:fs');
const rl=require('node:readline').createInterface({input:process.stdin});
const sessionId='sess_app'; let nativeTurnId;
const send=data=>process.stdout.write(JSON.stringify(data)+'\\n');
const event=(type,payload)=>send({method:'session/event',params:{sessionId,type,payload,turnId:nativeTurnId}});
rl.on('line',line=>{
 const message=JSON.parse(line); fs.appendFileSync(process.env.WIRE_LOG,JSON.stringify(message)+'\\n');
 const {id,method,params={}}=message;
 if(!method){ if(id==='input-rpc') { event('model.streaming',{kind:'text_delta',delta:'blue'}); event('turn.completed',{resultType:'success'}); } return; }
 if(method==='session/create'||method==='session/resume') send({id,result:{session:{sessionId,status:'idle'}}});
 else if(method==='session/subscribe') send({id,result:{sessionId,eventSeq:0,events:[]}});
 else if(method==='session/setMode'&&params.mode==='plan') send({id,error:{code:-32603,message:'Synthetic mode failure'}});
 else if(method==='session/send') {
  nativeTurnId='native-'+params.inputId; event('turn.started',{inputId:params.inputId});
  send({id,result:{sessionId,accepted:true,stateRevision:1}});
  send({id:'input-rpc',method:'interaction/requestUserInput',params:{requestId:'native-question',prompt:'Colour?',inputType:'choice',choices:['blue','red']}});
 } else send({id,result:{}});
});
`;

// Protocol fixtures from zai-org/ZCode@aac4755666d09fdcd70272fcf063c077a639015f:
// packages/shared/src/zcode-protocol/index.ts (session/goal),
// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/{server-operations,session-mapper}.ts,
// core/src/runtime/methods/target-continuation-loop.ts. GoalRead is deliberately
// absent from builtInTools (core/tests/target-tool.test.ts); goal control is RPC.
const goalFixture = `#!/usr/bin/env node
const fs=require('node:fs');
const sessionId='sess_app';
const statePath=process.env.HOME+'/goal-fixture.json';
let target=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):null;
let inputId; let nativeTurnId; let turnSequence=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const event=(type,payload)=>{if(type==='turn.started')nativeTurnId='native-goal-'+(++turnSequence);send({method:'session/event',params:{sessionId,type,payload,turnId:nativeTurnId}});};
const boundary=reason=>{
 send({method:'state.updated',params:{type:'state.updated',scope:'workspace',revision:1,patch:{}}});
 send({method:'state.updated',params:{type:'state.updated',scope:'session',sessionId,revision:1,patch:{}}});
 send({method:'state.updated',params:{type:'state.updated',scope:'session',sessionId,revision:1,reason,patch:{}}});
};
const persist=()=>fs.writeFileSync(statePath,JSON.stringify(target));
const snapshot=()=>({session:{sessionId,status:'idle',target}});
const finish=(allowed,reason)=>{
 target={...target,status:allowed?'complete':'paused'};persist();
 event('session.updated',{action:'status_changed',source:'runtime',target});
 event('tool.updated',{kind:allowed?'result':'error',toolCallId:'native-tool',toolName:'Bash',result:{output:'native result'},error:{message:'Permission denied'}});
 event('turn.completed',{inputId,resultType:allowed?'success':'cancelled'});
 boundary(reason);
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);fs.appendFileSync(process.env.WIRE_LOG,JSON.stringify(message)+'\\n');
 const {id,method,params={}}=message;
 if(!method){if(id==='goal-permission')finish(message.result?.decision==='allow','goal_continuation_completed');return;}
 if(method==='session/create'||method==='session/resume')send({id,result:snapshot()});
 else if(method==='session/subscribe')send({id,result:{sessionId,eventSeq:0,events:[]}});
 else if(method==='session/goal'){
  inputId=params.inputId;
  const starts=['set','replace','resume'].includes(params.action);
  if((params.action==='set'||params.action==='replace')&&params.objective?.trim())target={sessionID:sessionId,targetID:'goal-1',objective:params.objective,status:'active',summaryTitle:null,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,time:{created:1,updated:1}};
  if(params.action==='resume'&&target)target={...target,status:'active'};
  if(params.action==='pause'&&target)target={...target,status:'paused'};
  if(params.action==='clear')target=null;
  persist();
  event('session.updated',{action:params.action,source:'command',target});
  send({id,result:{response:target?'Goal '+target.status:'No goal is set.',snapshot:snapshot(),startedTurn:starts&&target!==null}});
  if(starts&&target){
   event('turn.started',{inputId});event('model.streaming',{kind:'text_delta',delta:'first iteration'});
   event('turn.completed',{inputId,resultType:'success',usage:{inputTokens:10,outputTokens:2,totalTokens:12}});
   event('turn.started',{inputId});
   send({id:'goal-permission',method:'interaction/requestPermission',params:{requestId:'goal-permission',toolName:'Bash',reason:'Native goal tool',input:{command:'fixture'},options:[{optionId:'allow',kind:'allow_once',name:'Allow',response:{decision:'allow'}},{optionId:'deny',kind:'deny',name:'Deny',response:{decision:'deny'}}]}});
  }
 }else if(method==='session/send'){
  inputId=params.inputId;send({id,result:{sessionId,accepted:true,stateRevision:1}});
  event('turn.started',{inputId});event('turn.completed',{inputId,resultType:'success'});
  event('model.streaming',{kind:'text_delta',delta:'after iteration completion'});
  boundary('prompt_completed');
 }else if(method==='session/stop'){
  if(target){target={...target,status:'paused'};persist();}
  send({id,result:{}});
  event('turn.completed',{inputId,resultType:'cancelled'});
  boundary('goal_continuation_completed');
 }else send({id,result:{}});
});
`;

it.live.each(["accept", "decline", "interrupt"] as const)(
  "bridges the native goal loop and its %s approval path without settling between iterations",
  (decision) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(binary, goalFixture);
        const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
        const terminal = yield* Deferred.make<void>();
        const events: Array<{ type: string; turnId?: TurnId | undefined; payload: unknown }> = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "request.opened") {
                expect(events.filter((item) => item.type === "turn.completed")).toHaveLength(0);
                expect((yield* adapter.listSessions())[0]?.status).toBe("running");
                const requestId = ApprovalRequestId.make(event.requestId!);
                if (decision === "interrupt") {
                  yield* adapter.interruptTurn(threadId, event.turnId);
                  // A stale approval cannot revive a cancelled native goal.
                  yield* adapter.respondToRequest(threadId, requestId, "accept");
                } else yield* adapter.respondToRequest(threadId, requestId, decision);
              }
              if (event.type === "turn.completed" || event.type === "turn.aborted")
                yield* Deferred.succeed(terminal, undefined);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
        const sent = yield* adapter.sendTurn({
          threadId,
          input: "/goal implement the requested change",
          modelSelection: { instanceId: ProviderInstanceId.make("zcode-test"), model: "GLM-5.3" },
        });
        yield* Deferred.await(terminal);
        yield* adapter.stopSession(threadId);
        const wire = yield* Effect.forEach(
          (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
          (line) => decodeWire(line),
        );
        expect(wire.some((message) => message.method === "session/send")).toBe(false);
        expect(wire.filter((message) => message.method === "session/goal")).toHaveLength(1);
        expect(wire.find((message) => message.method === "session/goal")).toMatchObject({
          params: {
            action: "set",
            objective: "implement the requested change",
            inputId: sent.turnId,
          },
        });
        expect(wire.findIndex((message) => message.method === "session/setMode")).toBeLessThan(
          wire.findIndex((message) => message.method === "session/goal"),
        );
        expect(wire.find((message) => message.method === "session/setModel")).toMatchObject({
          params: { model: { options: { reasoningLevel: "max" } } },
        });
        expect(wire.findIndex((message) => message.method === "session/setModel")).toBeLessThan(
          wire.findIndex((message) => message.method === "session/goal"),
        );
        expect(wire.filter((message) => message.id === "goal-permission")).toEqual([
          expect.objectContaining({
            result: { decision: decision === "accept" ? "allow" : "deny" },
          }),
        ]);
        expect(
          events.filter(
            (event) => event.type === "turn.completed" || event.type === "turn.aborted",
          ),
        ).toHaveLength(1);
        expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(
          events
            .filter((event) => event.turnId !== undefined)
            .every((event) => event.turnId === sent.turnId),
        ).toBe(true);
        if (decision === "interrupt")
          expect(events.find((event) => event.type === "turn.aborted")).toMatchObject({
            payload: {
              tokenUsage: {
                usageStatus: "partial",
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
              },
            },
          });
        if (decision !== "interrupt") {
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "item.completed",
              payload: expect.objectContaining(
                decision === "accept"
                  ? { data: { output: "native result" }, status: "completed" }
                  : { status: "failed" },
              ),
            }),
          );
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "thread.metadata.updated",
              payload: {
                metadata: {
                  goal: expect.objectContaining({
                    status: decision === "accept" ? "complete" : "paused",
                  }),
                },
              },
            }),
          );
        }
      }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
    ),
);

it.live("forwards an explicitly selected native project grant without changing its rules", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(binary, lifecycleFixture);
      const alternative = {
        ...onceAndDeny[0]!,
        optionId: "project-command",
        name: "Project command only",
        response: {
          decision: "allow",
          permissionUpdates: [{ type: "project", command: "fixture" }],
        },
      };
      const adapter = yield* lifecycleAdapter(directory, binary, {
        PERMISSION_OPTIONS: JSON.stringify([...onceAndDeny, alternative]),
      });
      const collected = yield* collectLifecycle(adapter);
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
      yield* adapter.sendTurn({ threadId, input: "interactions" });
      yield* Deferred.await(collected.opened);
      const approval = collected.events.find((event) => event.type === "request.opened")!;
      if (approval.type === "request.opened")
        expect(
          approval.payload.options?.filter((option) => option.decision === "acceptAlways"),
        ).toMatchObject([{ optionId: "project" }, { optionId: "project-command" }]);
      for (const [decision, optionId] of [
        ["acceptAlways", undefined],
        ["acceptAlways", "unknown"],
        ["accept", "project-command"],
      ] as const)
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(approval.requestId!),
                decision,
                optionId,
              ),
            ),
          ),
        ).toBe(true);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(approval.requestId!),
        "acceptAlways",
        "project-command",
      );
      yield* Deferred.await(collected.permissionAnswered);
      const wire = yield* Effect.forEach(
        (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
        (line) => decodeWire(line),
      );
      for (const id of ["permission", "permission-retry"])
        expect(wire.find((message) => message.id === id)?.result).toEqual(alternative.response);
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  ),
);

it.live.each([
  "/goal",
  "/goal show",
  "/goal pause",
  "/goal clear",
  "/goal replace",
  "/goal resume",
])("settles the native %s control response when no turn starts", (command) =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(binary, goalFixture);
      const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
      const terminal = yield* Deferred.make<void>();
      let response = "";
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "content.delta") response += event.payload.delta;
            if (event.type === "turn.completed") yield* Deferred.succeed(terminal, undefined);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: command });
      yield* Deferred.await(terminal);
      expect(response).not.toBe("");
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
  ),
);

it.live.each(["read-only", "plan"] as const)(
  "rejects goal control in %s before sending native execution",
  (restriction) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(binary, goalFixture);
        const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
        yield* adapter.startSession({
          threadId,
          cwd: directory,
          runtimeMode: "full-access",
          ...(restriction === "read-only" ? { sandboxMode: "read-only" as const } : {}),
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.sendTurn({
                threadId,
                input: "/goal change files",
                ...(restriction === "plan" ? { interactionMode: "plan" as const } : {}),
              }),
            ),
          ),
        ).toBe(true);
        const wire = yield* fs.readFileString(`${directory}/wire.jsonl`);
        expect(wire).not.toContain('"method":"session/goal"');
        expect(wire).not.toContain('"method":"session/send"');
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
    ),
);

it.live(
  "restores the native goal on cold resume and keeps later prompt results in the same turn",
  () =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(binary, goalFixture);
        yield* fs.writeFileString(
          `${directory}/goal-fixture.json`,
          JSON.stringify({
            sessionID: "sess_app",
            targetID: "goal-1",
            objective: "Finish the native goal",
            status: "paused",
            summaryTitle: null,
            tokenBudget: null,
            tokensUsed: 50,
            timeUsedSeconds: 2,
            time: { created: 1, updated: 1 },
          }),
        );
        const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
        const goalDone = yield* Deferred.make<void>();
        const promptDone = yield* Deferred.make<void>();
        let terminals = 0;
        let promptTail = "";
        const goals: unknown[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "thread.metadata.updated")
                goals.push(event.payload.metadata?.goal);
              if (event.type === "request.opened")
                yield* adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(event.requestId!),
                  "accept",
                );
              if (event.type === "content.delta" && terminals === 1)
                promptTail += event.payload.delta;
              if (event.type === "turn.completed") {
                terminals++;
                yield* Deferred.succeed(terminals === 1 ? goalDone : promptDone, undefined);
              }
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* adapter.startSession({
          threadId,
          cwd: directory,
          runtimeMode: "approval-required",
          resumeCursor: { sessionId: "sess_app" },
        });
        yield* adapter.sendTurn({ threadId, input: "/goal resume" });
        yield* Deferred.await(goalDone);
        yield* adapter.sendTurn({ threadId, input: "Report the final result" });
        yield* Deferred.await(promptDone);
        expect(goals[0]).toMatchObject({ targetID: "goal-1", status: "paused" });
        expect(goals.at(-1)).toMatchObject({ targetID: "goal-1", status: "complete" });
        expect(promptTail).toBe("after iteration completion");
        expect(terminals).toBe(2);
        const wire = yield* Effect.forEach(
          (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
          (line) => decodeWire(line),
        );
        expect(wire.find((message) => message.method === "session/resume")).toMatchObject({
          params: { sessionId: "sess_app" },
        });
        expect(wire.findIndex((message) => message.method === "session/setMode")).toBeLessThan(
          wire.findIndex((message) => message.method === "session/goal"),
        );
        expect(wire.filter((message) => message.method === "session/create")).toHaveLength(0);
        expect(wire.filter((message) => message.method === "session/goal")).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
    ),
);

it.live.each(["rejected", "missing start acknowledgement"])(
  "fails a %s goal RPC without prompt fallback and releases the turn",
  (failure) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          binary,
          failure === "rejected"
            ? goalFixture.replace(
                "inputId=params.inputId;\n  const starts",
                "send({id,error:{code:-32601,message:'Unsupported native goal RPC'}});return;\n  const starts",
              )
            : goalFixture.replace("startedTurn:starts&&target!==null", "startedTurn:undefined"),
        );
        const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
        expect(
          Exit.isFailure(
            yield* Effect.exit(adapter.sendTurn({ threadId, input: "/goal objective" })),
          ),
        ).toBe(true);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
        expect(yield* fs.readFileString(`${directory}/wire.jsonl`)).not.toContain(
          '"method":"session/send"',
        );
        expect(yield* fs.readFileString(`${directory}/wire.jsonl`)).toContain(
          '"method":"session/stop"',
        );
        yield* adapter.sendTurn({ threadId, input: "Ordinary prompt" });
      }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
    ),
);

it.live.each(["/goals", "Discuss /goal", "/goal with attachment"])(
  "keeps %s on the ordinary prompt path",
  (input) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(binary, goalFixture);
        const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
        const attachment = yield* decodeFileAttachment({
          type: "file",
          id: "test-thread-00000000-0000-4000-8000-000000000001",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        });
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input,
          ...(input.endsWith("attachment") ? { attachments: [attachment] } : {}),
        });
        const wire = yield* fs.readFileString(`${directory}/wire.jsonl`);
        expect(wire).toContain('"method":"session/send"');
        expect(wire).not.toContain('"method":"session/goal"');
      }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
    ),
);

it.live("advertises exactly one native goal surface", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const { buildInitialZCodeProviderSnapshot } = yield* Effect.promise(
        () => import("./ZCodeProviderStatus.ts"),
      );
      const snapshot = yield* buildInitialZCodeProviderSnapshot(
        { ...settings(binary), enabled: false },
        options(directory).environment,
      );
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["goal"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.live("reports a failed goal host boundary even after a successful native iteration", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        binary,
        goalFixture.replace(
          "if(starts&&target){",
          "if(starts&&target){event('turn.started',{inputId});event('turn.completed',{inputId,resultType:'success'});boundary('goal_continuation_failed');return;",
        ),
      );
      const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
      const terminal = yield* Deferred.make<void>();
      let state: string | undefined;
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "turn.completed") {
              state = event.payload.state;
              yield* Deferred.succeed(terminal, undefined);
            }
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
      yield* adapter.sendTurn({ threadId, input: "/goal objective" });
      yield* Deferred.await(terminal);
      expect(state).toBe("failed");
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
  ),
);

it.live(
  "forwards scoped MCP configuration on create and cold resume and passes attachment paths",
  () =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(binary, appFixture);
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const configure = (token: string) =>
          sessions.set({
            threadId,
            environmentId: EnvironmentId.make("test"),
            providerInstanceId: ProviderInstanceId.make("zcode-test"),
            providerSessionId: "test-session",
            endpoint: "http://127.0.0.1:1234/mcp",
            authorizationHeader: `Bearer ${token}`,
            browserToolsAvailable: true,
            capabilities: new Set(["preview"]),
          });
        yield* Effect.addFinalizer(() => sessions.clear(threadId));
        yield* configure("first-scoped-token");
        const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
        const attachment = yield* decodeFileAttachment({
          type: "file",
          id: "test-thread-00000000-0000-4000-8000-000000000001",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        });
        yield* adapter.sendTurn({ threadId, input: "read attachment", attachments: [attachment] });
        yield* adapter.stopSession(threadId);
        yield* configure("rotated-scoped-token");
        yield* adapter.startSession({
          threadId,
          cwd: directory,
          runtimeMode: "full-access",
          resumeCursor: { sessionId: "sess_app" },
        });
        yield* adapter.stopSession(threadId);
        const wire = yield* Effect.forEach(
          (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
          (line) => decodeWire(line),
        );
        expect(wire.find((message) => message.method === "session/create")).toMatchObject({
          params: {
            mcpServers: [
              {
                name: "t3-code",
                headers: [{ name: "Authorization", value: "Bearer first-scoped-token" }],
              },
            ],
          },
        });
        expect(wire.find((message) => message.method === "session/resume")).toMatchObject({
          params: {
            mcpServers: [
              {
                name: "t3-code",
                headers: [{ name: "Authorization", value: "Bearer rotated-scoped-token" }],
              },
            ],
          },
        });
        expect(wire.find((message) => message.method === "session/send")).toMatchObject({
          params: { attachments: [{ type: "file", path: `${directory}/${attachment.id}.txt` }] },
        });
      }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
    ),
);

it.live.each([false, true])("preserves user input answers for modern protocol %s", (modern) =>
  Effect.gen(function* () {
    yield* withFixture((directory, binary) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            binary,
            modern
              ? appFixture.replace(
                  "prompt:'Colour?',inputType:'choice',choices:['blue','red']",
                  "questions:[{header:'Colour',question:'Which colour?',options:[{value:'blue',label:'Blue'}]},{header:'Extras',question:'Other colours?',multiSelect:true,options:[{value:'green',label:'Green'},{value:'yellow',label:'Yellow'}]}]",
                )
              : appFixture,
          );
          const adapter = yield* makeZCodeSessionRuntime(
            { ...settings(binary) },
            options(directory),
          );
          const terminal = yield* Deferred.make<void>();
          let text = "";
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type === "content.delta" && event.payload.streamKind === "assistant_text")
                  text += event.payload.delta;
                if (event.type === "user-input.requested") {
                  expect(event.requestId).not.toBe("native-question");
                  yield* adapter.respondToUserInput(
                    threadId,
                    ApprovalRequestId.make(event.requestId!),
                    modern
                      ? { "native-question:0": "blue", "native-question:1": ["green", "yellow"] }
                      : { "native-question": "blue" },
                  );
                }
                if (event.type === "turn.completed") yield* Deferred.succeed(terminal, undefined);
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* adapter.startSession({
            threadId,
            cwd: directory,
            runtimeMode: "approval-required",
            modelSelection: {
              instanceId: ProviderInstanceId.make("zcode-test"),
              model: "GLM-5.3",
              options: [{ id: "reasoningLevel", value: "low" }],
            },
          });
          yield* adapter.sendTurn({ threadId, input: "question" });
          yield* Deferred.await(terminal);
          expect(text).toBe("blue");
          const wire = yield* Effect.forEach(
            (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
            (line) => decodeWire(line),
          );
          expect(wire.find((message) => message.id === "input-rpc")?.result).toEqual(
            modern
              ? {
                  action: "accept",
                  content: { answer_0: "blue", answer_1: ["green", "yellow"] },
                }
              : { requestId: "native-question", value: "blue" },
          );
          expect(wire.find((message) => message.method === "session/send")).toMatchObject({
            params: { modelSelection: { options: { reasoningLevel: "low" } } },
          });
        }).pipe(Effect.scoped, Effect.timeout("3 seconds"), Effect.provide(NodeServices.layer));
      }),
    );
  }),
);

it.live("does not send a prompt if the app-server rejects the restrictive mode", () =>
  Effect.gen(function* () {
    yield* withFixture((directory, binary) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(binary, appFixture);
          const adapter = yield* makeZCodeSessionRuntime(
            { ...settings(binary) },
            options(directory),
          );
          yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                adapter.sendTurn({ threadId, input: "edit files", interactionMode: "plan" }),
              ),
            ),
          ).toBe(true);
          expect(yield* fs.readFileString(`${directory}/wire.jsonl`)).not.toContain(
            '"method":"session/send"',
          );
        }).pipe(Effect.scoped, Effect.timeout("3 seconds"), Effect.provide(NodeServices.layer));
      }),
    );
  }),
);

it.live.each([null, {}, { sessionId: "" }, { sessionId: "other" }])(
  "rejects invalid persisted identity %j instead of creating a new conversation",
  (resumeCursor) =>
    Effect.gen(function* () {
      yield* withFixture((directory, binary) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const adapter = yield* makeZCodeSessionRuntime(settings(binary), options(directory));
            expect(
              Exit.isFailure(
                yield* Effect.exit(
                  adapter.startSession({
                    threadId,
                    cwd: directory,
                    runtimeMode: "full-access",
                    resumeCursor,
                  }),
                ),
              ),
            ).toBe(true);
            expect(yield* adapter.listSessions()).toEqual([]);
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
        }),
      );
    }),
);

it.live("honors an explicit executable name on PATH rather than silently switching runtimes", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { resolveZCodeRuntime } = yield* Effect.promise(() => import("./ZCodeRuntime.ts"));
      const runtime = yield* resolveZCodeRuntime({ binaryPath: "custom-zcode-runtime" });
      expect(runtime.command).toBe("custom-zcode-runtime");
      expect(runtime.kind).toBe("custom");
    }).pipe(Effect.provide(NodeServices.layer));
  }),
);

it.live("deduplicates native input retries and emits one resolved event after the answer", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const request =
        "{method:'interaction/requestUserInput',params:{requestId:'native-question',prompt:'Colour?',inputType:'choice',choices:['blue','red']}}";
      const retried = appFixture
        .replace(
          "const sessionId='sess_app'; let nativeTurnId;",
          "const sessionId='sess_app'; let nativeTurnId; let responses=0;",
        )
        .replace(
          "if(!method){ if(id==='input-rpc') { event('model.streaming',{kind:'text_delta',delta:'blue'}); event('turn.completed',{resultType:'success'}); } return; }",
          `if(!method){ if(String(id).startsWith('input-rpc')) { responses++; if(responses===1) send({id:'input-rpc-3',...${request}}); if(responses===3) event('turn.completed',{resultType:'success'}); } return; }`,
        )
        .replace(
          "send({id:'input-rpc',method:'interaction/requestUserInput',params:{requestId:'native-question',prompt:'Colour?',inputType:'choice',choices:['blue','red']}});",
          `send({id:'input-rpc-1',...${request}}); send({id:'input-rpc-2',...${request}});`,
        );
      yield* fs.writeFileString(binary, retried);
      const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
      const terminal = yield* Deferred.make<void>();
      let requested = 0;
      let resolved = 0;
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "user-input.requested") {
              requested++;
              expect(event.turnId).toBeDefined();
              yield* adapter.respondToUserInput(
                threadId,
                ApprovalRequestId.make(event.requestId!),
                { "native-question": "blue" },
              );
            }
            if (event.type === "user-input.resolved") {
              resolved++;
              expect(event.payload.answers).toEqual({ "native-question": "blue" });
            }
            if (event.type === "turn.completed") yield* Deferred.succeed(terminal, undefined);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "question" });
      yield* Deferred.await(terminal);
      expect(requested).toBe(1);
      expect(resolved).toBe(1);
      const wire = yield* Effect.forEach(
        (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
        (line) => decodeWire(line),
      );
      for (const id of ["input-rpc-1", "input-rpc-2", "input-rpc-3"]) {
        expect(wire.find((message) => message.id === id)?.result).toEqual({
          requestId: "native-question",
          value: "blue",
        });
      }
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
  ),
);

it.live("carries native aggregate usage and unknown usage across resume", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const usageEvents = `
const aggregate = ${JSON.stringify(nativeUsageFixture)};
const emitTurn = (content,inputId) => {
 event('turn.started',{inputId});
 if(content !== 'missing') {
  event('session.updated',{content:'first',stopReason:'tool-calls',querySource:'main_turn',usage:{inputTokens:10,outputTokens:2,totalTokens:12}});
  event('session.updated',{content:'second',stopReason:'stop',querySource:'main_turn',usage:{inputTokens:20,outputTokens:5,totalTokens:25}});
 }
 event('session.updated',{totalTokenCount:1000,contextUsed:500});
 event('turn.completed',content === 'missing' ? {resultType:'success',tokenCount:0} : {...aggregate,resultType:content === 'cancelled' ? 'cancelled' : 'success'});
};`;
      const script = `#!/usr/bin/env node
const send=data=>process.stdout.write(JSON.stringify(data)+'\\n');
const sessionId='sess_usage'; let nativeTurnId;
const event=(type,payload)=>{if(type==='turn.started')nativeTurnId='native-'+payload.inputId;send({method:'session/event',params:{type,sessionId,payload,turnId:nativeTurnId}});};
${usageEvents}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line);
 if(method==='session/create'||method==='session/resume') send({id,result:{session:{sessionId,status:'idle'}}});
 else if(method==='session/subscribe') send({id,result:{sessionId,eventSeq:0,events:[]}});
 else if(method==='session/send') {send({id,result:{sessionId,accepted:true,stateRevision:1}});emitTurn(params.content,params.inputId);}
 else send({id,result:{}});
});
`;
      yield* fs.writeFileString(binary, script);
      const adapter = yield* makeZCodeSessionRuntime({ ...settings(binary) }, options(directory));
      let terminal = yield* Deferred.make<unknown>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed" ? Deferred.succeed(terminal, event.payload) : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "usage" });
      expect(yield* Deferred.await(terminal)).toMatchObject({
        state: "completed",
        tokenUsage: {
          usageStatus: "complete",
          inputTokens: 30,
          outputTokens: 7,
          totalTokens: 37,
        },
      });
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        cwd: directory,
        runtimeMode: "full-access",
        resumeCursor: first.resumeCursor,
      });
      terminal = yield* Deferred.make<unknown>();
      const resumed = yield* adapter.sendTurn({ threadId, input: "missing" });
      expect(resumed.resumeCursor).toEqual(first.resumeCursor);
      expect(yield* Deferred.await(terminal)).toMatchObject({
        state: "completed",
        tokenUsage: { usageStatus: "unavailable" },
      });
      terminal = yield* Deferred.make<unknown>();
      yield* adapter.sendTurn({ threadId, input: "cancelled" });
      expect(yield* Deferred.await(terminal)).toMatchObject({
        state: "interrupted",
        tokenUsage: { usageStatus: "partial", inputTokens: 30, outputTokens: 7, totalTokens: 37 },
      });
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  ),
);
const lifecycleFixture = `#!/usr/bin/env node
const fs=require('node:fs');
const send=data=>process.stdout.write(JSON.stringify(data)+'\\n');
const sessionId='sess_lifecycle'; let current; let first;
const event=(type,payload={},turnId=current)=>send({method:'session/event',params:{sessionId,type,payload,turnId:turnId===null?undefined:turnId}});
const complete=()=>{ event('turn.completed',{resultType:'success'}); event('turn.failed',{error:{message:'duplicate'}}); event('session.titleUpdated',{title:'drained'}); };
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(process.env.WIRE_LOG,JSON.stringify(m)+'\\n');
 const {id,method,params={}}=m;
 if(!method) {
  if(id==='background') {event('turn.completed',{resultType:'success'},'background'); event('model.streaming',{kind:'text_delta',delta:'B'}); complete();}
  if(id==='death-trigger') process.exit(7);
  if(id==='permission') {event('session.titleUpdated',{title:'permission-answered'});}
  if(id==='input') {event('session.titleUpdated',{title:'input-answered'});}
  return;
 }
 if(method==='session/create'||method==='session/resume') send({id,result:{session:{sessionId,status:'idle'}}});
 else if(method==='session/subscribe') send({id,result:{sessionId,eventSeq:0,events:[]}});
 else if(method==='session/stop') {send({id,result:{}}); event('turn.completed',{resultType:'cancelled'}); send({method:'state.updated',params:{scope:'session',sessionId,revision:1,reason:'prompt_completed',patch:{}}});}
 else if(method==='session/send') {
  current='native-'+params.inputId; event('turn.started',{inputId:params.inputId}); event('turn.started',{inputId:params.inputId});
  if(params.content==='die-before-ack') { process.exit(7); return; }
  send({id,result:{sessionId,accepted:true,stateRevision:1}});
  if(params.content==='A') first={turnId:current,inputId:params.inputId};
  if(params.content==='B') {
   event('turn.started',{inputId:first.inputId},first.turnId); event('turn.started',{},'unattributed');
   for(const turnId of [first.turnId,'unattributed',null]) {
    event('model.streaming',{kind:'text_delta',delta:'late A'},turnId);
    event('tool.updated',{kind:'result',toolCallId:'late-tool',result:'late A'},turnId);
    event('turn.completed',{resultType:'success'},turnId);
   }
   send({id:'late-permission',method:'interaction/requestPermission',params:{sessionId,turnId:first.turnId,requestId:'late-permission',options:[{optionId:'once',kind:'allow_once',name:'Once',response:{decision:'allow'}}]}});
   send({id:'late-input',method:'interaction/requestUserInput',params:{sessionId,turnId:first.turnId,requestId:'late-input',prompt:'Late input'}});
   event('turn.started',{background:true},'background'); event('model.streaming',{kind:'text_delta',delta:'background'},'background');
   send({id:'background-permission',method:'interaction/requestPermission',params:{sessionId,turnId:'background',requestId:'bg-permission',background:true,options:[]}});
   send({id:'background',method:'interaction/requestUserInput',params:{sessionId,turnId:'background',requestId:'bg-input',prompt:'Background input'}});
  }
  if(params.content==='die') {
   send({id:'permission',method:'interaction/requestPermission',params:{sessionId,turnId:current,requestId:'permission',toolName:'Bash',options:[{optionId:'once',kind:'allow_once',name:'Once',response:{decision:'allow'}}]}});
   send({id:'death-trigger',method:'interaction/requestUserInput',params:{sessionId,turnId:current,requestId:'death-trigger',prompt:'Exit fixture'}});
  }
  if(params.content==='recover') {event('model.streaming',{kind:'text_delta',delta:'recovered'}); complete();}
  if(params.content==='interactions') {
   const options=JSON.parse(process.env.PERMISSION_OPTIONS);
   send({id:'permission',method:'interaction/requestPermission',params:{sessionId,turnId:current,requestId:'permission',toolName:'Bash',options}});
   send({id:'permission-retry',method:'interaction/requestPermission',params:{sessionId,turnId:current,requestId:'permission',toolName:'Bash',options}});
   send({id:'input',method:'interaction/requestUserInput',params:{sessionId,turnId:current,requestId:'input',questions:[{header:'Colour',question:'Colour?',options:[]}]}});
   event('permission.resolved',{requestId:'permission',decision:'allow'},'wrong-turn');
   event('userInput.resolved',{requestId:'input',value:{answer_0:'wrong-turn'}},'wrong-turn');
   event('session.titleUpdated',{title:'interactions-open'});
   if(process.env.NATIVE_RESOLVE==='1') {
    event('permission.resolved',{requestId:'permission',decision:'modify',modifiedInput:{command:'safe'}});
    event('permission.resolved',{requestId:'permission',decision:'modify',modifiedInput:{command:'safe'}});
    event('userInput.resolved',{requestId:'input',value:{answer_0:'native'}});
    event('userInput.resolved',{requestId:'input',value:{answer_0:'native'}});
   }
  }
 } else send({id,result:{}});
});
`;

it.live.each(["valid", "foreign"] as const)(
  "reads and forks the native stdio session with %s identities",
  (mode) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          binary,
          `#!/usr/bin/env node
const fs=require('node:fs');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.env.WIRE_LOG,line+'\\n');
 if(m.method==='session/create')send({id:m.id,result:{session:{sessionId:'sess_source',status:'idle'}}});
 else if(m.method==='session/subscribe')send({id:m.id,result:{sessionId:'sess_source',eventSeq:0,events:[]}});
 else if(m.method==='session/read')send({id:m.id,result:{session:{sessionId:${JSON.stringify(mode === "valid" ? "sess_source" : "sess_foreign")},status:'idle'},messages:[{durable:true}]}});
 else if(m.method==='session/fork')send({id:m.id,result:{forkedSessionId:'sess_child',parentSessionId:'sess_source',snapshot:{session:{sessionId:${JSON.stringify(mode === "valid" ? "sess_child" : "sess_foreign")},status:'idle'}}}});
 else send({id:m.id,result:{}});
});
`,
        );
        const adapter = yield* lifecycleAdapter(directory, binary);
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
        if (mode === "valid") {
          expect(yield* adapter.readNativeSnapshot!(threadId)).toMatchObject({
            messages: [{ durable: true }],
          });
          expect(yield* adapter.forkNativeHead!(threadId)).toBe("sess_child");
        } else {
          expect(
            Exit.isFailure(yield* adapter.readNativeSnapshot!(threadId).pipe(Effect.exit)),
          ).toBe(true);
          expect(Exit.isFailure(yield* adapter.forkNativeHead!(threadId).pipe(Effect.exit))).toBe(
            true,
          );
        }
        const wire = yield* Effect.forEach(
          (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
          (line) => decodeWire(line),
        );
        expect(wire.find((message) => message.method === "session/read")?.params).toEqual({
          sessionId: "sess_source",
        });
        expect(wire.find((message) => message.method === "session/fork")?.params).toEqual({
          sessionId: "sess_source",
        });
        if (mode === "valid")
          expect(wire.find((message) => message.method === "session/close")?.params).toEqual({
            sessionId: "sess_child",
          });
        yield* adapter.stopSession(threadId);
        expect(Exit.isFailure(yield* adapter.readNativeSnapshot!(threadId).pipe(Effect.exit))).toBe(
          true,
        );
      }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
    ),
);

const onceAndDeny = [
  {
    optionId: "project",
    kind: "allow_always",
    name: "Project",
    response: { decision: "allow", permissionUpdates: [{ type: "project" }] },
  },
  {
    optionId: "once",
    kind: "allow_once",
    name: "Once",
    response: { decision: "allow", reason: "Exact once" },
  },
  {
    optionId: "deny",
    kind: "deny",
    name: "Deny",
    response: { decision: "deny", reason: "Exact deny" },
  },
];
const lifecycleAdapter = (directory: string, binary: string, environment: NodeJS.ProcessEnv = {}) =>
  makeZCodeSessionRuntime(
    { ...settings(binary) },
    {
      ...options(directory),
      environment: {
        ...options(directory).environment,
        PERMISSION_OPTIONS: JSON.stringify(onceAndDeny),
        ...environment,
      },
    },
  );
const collectLifecycle = (adapter: Awaited<Effect.Success<ReturnType<typeof lifecycleAdapter>>>) =>
  Effect.gen(function* () {
    const events: ZCodeSessionEvent[] = [];
    const drained = yield* Deferred.make<void>();
    const failed = yield* Deferred.make<void>();
    const opened = yield* Deferred.make<void>();
    const permissionAnswered = yield* Deferred.make<void>();
    const inputAnswered = yield* Deferred.make<void>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "thread.metadata.updated") {
            if (event.payload.name === "drained") yield* Deferred.succeed(drained, undefined);
            if (event.payload.name === "interactions-open")
              yield* Deferred.succeed(opened, undefined);
            if (event.payload.name === "permission-answered")
              yield* Deferred.succeed(permissionAnswered, undefined);
            if (event.payload.name === "input-answered")
              yield* Deferred.succeed(inputAnswered, undefined);
          }
          if (event.type === "turn.completed" && event.payload.state === "failed")
            yield* Deferred.succeed(failed, undefined);
          if (
            event.type === "user-input.requested" &&
            event.payload.questions[0]?.id === "death-trigger"
          )
            yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(event.requestId!), {
              "death-trigger": "exit",
            });
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return { events, drained, failed, opened, permissionAnswered, inputAnswered };
  });

it.live("keeps late native A events and background work out of B and deduplicates terminals", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(binary, lifecycleFixture);
      const adapter = yield* lifecycleAdapter(directory, binary);
      const collected = yield* collectLifecycle(adapter);
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
      const a = yield* adapter.sendTurn({ threadId, input: "A" });
      yield* adapter.interruptTurn(threadId, a.turnId);
      const b = yield* adapter.sendTurn({ threadId, input: "B" });
      yield* Deferred.await(collected.drained);
      expect(
        collected.events.filter((e) => e.type === "turn.started").map((e) => e.turnId),
      ).toEqual([a.turnId, b.turnId]);
      expect(collected.events.filter((e) => e.type === "content.delta")).toMatchObject([
        { turnId: b.turnId, payload: { delta: "B" } },
      ]);
      expect(collected.events.filter((e) => e.type === "item.completed")).toEqual([]);
      expect(collected.events.filter((e) => e.type === "request.opened")).toEqual([]);
      expect(collected.events.filter((e) => e.type === "user-input.requested")).toHaveLength(0);
      const wire = yield* Effect.forEach(
        (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
        (line) => decodeWire(line),
      );
      expect(wire.find((m) => m.id === "background-permission")?.result).toEqual({
        decision: "deny",
      });
      expect(wire.find((m) => m.id === "background")?.result).toEqual({
        requestId: "bg-input",
        cancelled: true,
      });
      expect(wire.find((m) => m.id === "late-permission")?.result).toEqual({ decision: "deny" });
      expect(wire.find((m) => m.id === "late-input")?.result).toEqual({
        requestId: "late-input",
        cancelled: true,
      });
      expect(collected.events.filter((e) => e.type === "turn.aborted")).toMatchObject([
        { turnId: a.turnId },
      ]);
      expect(collected.events.filter((e) => e.type === "turn.completed")).toMatchObject([
        { turnId: b.turnId, payload: { state: "completed" } },
      ]);
      expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  ),
);

it.live(
  "fails a dead child once, settles pending approval and cold resumes with fresh scopes",
  () =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(binary, lifecycleFixture);
        const mcp = yield* McpProviderSessions.McpProviderSessions;
        const configure = (token: string) =>
          mcp.set({
            threadId,
            environmentId: EnvironmentId.make("test"),
            providerInstanceId: ProviderInstanceId.make("zcode-test"),
            providerSessionId: "scoped-session",
            endpoint: "http://127.0.0.1:1234/mcp",
            authorizationHeader: `Bearer ${token}`,
            browserToolsAvailable: true,
            capabilities: new Set(["preview"]),
          });
        yield* Effect.addFinalizer(() => mcp.clear(threadId));
        yield* configure("first-fixture-token");
        const adapter = yield* lifecycleAdapter(directory, binary);
        const collected = yield* collectLifecycle(adapter);
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
        const dead = yield* adapter.sendTurn({ threadId, input: "die" });
        yield* Deferred.await(collected.failed);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(yield* adapter.listSessions()).toEqual([]);
        const permission = collected.events.find((e) => e.type === "request.opened");
        expect(permission).toBeDefined();
        expect(collected.events.filter((e) => e.type === "request.resolved")).toHaveLength(1);
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(permission!.requestId!),
          "accept",
        );
        yield* configure("fresh-fixture-token");
        const resumed = yield* adapter.sendTurn({ threadId, input: "recover" });
        yield* Deferred.await(collected.drained);
        expect(resumed.resumeCursor).toEqual(dead.resumeCursor);
        expect(collected.events.filter((e) => e.type === "turn.completed")).toMatchObject([
          { turnId: dead.turnId, payload: { state: "failed" } },
          { turnId: resumed.turnId, payload: { state: "completed" } },
        ]);
        expect(collected.events.filter((e) => e.type === "request.resolved")).toHaveLength(1);
        const wire = yield* Effect.forEach(
          (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
          (line) => decodeWire(line),
        );
        expect(wire.filter((m) => m.method === "session/create")).toHaveLength(1);
        expect(wire.filter((m) => m.method === "session/resume")).toMatchObject([
          {
            params: {
              sessionId: "sess_lifecycle",
              mcpServers: [
                { headers: [{ name: "Authorization", value: "Bearer fresh-fixture-token" }] },
              ],
            },
          },
        ]);
      }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
    ),
);

it.live.each(["native", "ui", "interrupt", "close"] as const)(
  "settles native/UI interaction races once via %s",
  (winner) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(binary, lifecycleFixture);
        const adapter = yield* lifecycleAdapter(directory, binary, {
          NATIVE_RESOLVE: winner === "native" ? "1" : "0",
        });
        const collected = yield* collectLifecycle(adapter);
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
        const turn = yield* adapter.sendTurn({ threadId, input: "interactions" });
        yield* Deferred.await(collected.opened);
        const approval = collected.events.find((e) => e.type === "request.opened")!;
        const input = collected.events.find((e) => e.type === "user-input.requested")!;
        expect(collected.events.filter((e) => e.type === "request.opened")).toHaveLength(1);
        if (approval.type === "request.opened")
          expect(approval.payload.options).toEqual([
            { optionId: "project", decision: "acceptAlways", label: "Project" },
            { optionId: "once", decision: "accept", label: "Once" },
            { optionId: "deny", decision: "decline", label: "Deny" },
          ]);
        if (winner === "native") {
          yield* Deferred.await(collected.permissionAnswered);
          yield* Deferred.await(collected.inputAnswered);
        } else if (winner === "interrupt") yield* adapter.interruptTurn(threadId, turn.turnId);
        else if (winner === "close") yield* adapter.stopSession(threadId);
        else {
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make(approval.requestId!),
            "accept",
          );
          yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(input.requestId!), {
            "input:0": "ui",
          });
        }
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(approval.requestId!),
          "acceptAlways",
        );
        yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(input.requestId!), {
          "input:0": "stale",
        });
        if (winner !== "close") {
          yield* Deferred.await(collected.permissionAnswered);
          yield* Deferred.await(collected.inputAnswered);
        }
        expect(collected.events.filter((e) => e.type === "request.resolved")).toHaveLength(1);
        expect(collected.events.filter((e) => e.type === "user-input.resolved")).toHaveLength(1);
        if (winner !== "close") {
          const wire = yield* Effect.forEach(
            (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
            (line) => decodeWire(line),
          );
          for (const id of ["permission", "permission-retry"])
            expect(wire.find((m) => m.id === id)?.result).toEqual(
              winner === "native"
                ? { decision: "modify", modifiedInput: { command: "safe" } }
                : winner === "ui"
                  ? { decision: "allow", reason: "Exact once" }
                  : { decision: "deny" },
            );
          expect(wire.find((m) => m.id === "input")?.result).toEqual(
            winner === "interrupt"
              ? { action: "cancel" }
              : {
                  action: "accept",
                  content: { answer_0: winner },
                },
          );
          expect(collected.events.filter((e) => e.type === "user-input.resolved")).toMatchObject([
            { payload: { answers: winner === "interrupt" ? {} : { "input:0": winner } } },
          ]);
        } else
          expect(collected.events.filter((e) => e.type === "turn.aborted")).toMatchObject([
            { turnId: turn.turnId },
          ]);
      }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
    ),
);

it.live.each([
  [],
  [
    {
      optionId: "empty-project",
      kind: "allow_always",
      name: "Project",
      response: { decision: "allow" },
    },
  ],
  [
    {
      optionId: "updates",
      kind: "allow_once",
      name: "Updates",
      response: { decision: "allow", permissionUpdates: [{ type: "project" }] },
    },
  ],
  [
    {
      optionId: "modified",
      kind: "allow_once",
      name: "Modify",
      response: { decision: "allow", modifiedInput: { command: "different" } },
    },
  ],
])("never fabricates allow or widens an unsupported native option %j", (nativeOptions) =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(binary, lifecycleFixture);
      const adapter = yield* lifecycleAdapter(directory, binary, {
        PERMISSION_OPTIONS: JSON.stringify(nativeOptions),
      });
      const collected = yield* collectLifecycle(adapter);
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
      yield* adapter.sendTurn({ threadId, input: "interactions" });
      yield* Deferred.await(collected.opened);
      const approval = collected.events.find((e) => e.type === "request.opened")!;
      if (approval.type === "request.opened")
        expect(approval.payload.options).not.toContainEqual(
          expect.objectContaining({ decision: "accept" }),
        );
      for (const decision of ["accept", "acceptForSession", "acceptAlways"] as const)
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(approval.requestId!),
                decision,
              ),
            ),
          ),
        ).toBe(true);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(approval.requestId!),
        "cancel",
      );
      yield* Deferred.await(collected.permissionAnswered);
      const wire = yield* Effect.forEach(
        (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
        (line) => decodeWire(line),
      );
      expect(wire.find((m) => m.id === "permission")?.result).toEqual({ decision: "deny" });
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  ),
);

it.live("does not retain a child that terminates during setup", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(binary, "#!/usr/bin/env node\nprocess.exit(7);\n");
      const adapter = yield* lifecycleAdapter(directory, binary);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" }),
          ),
        ),
      ).toBe(true);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  ),
);

it.live("fails an active turn when the child dies before acknowledging send", () =>
  withFixture((directory, binary) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(binary, lifecycleFixture);
      const adapter = yield* lifecycleAdapter(directory, binary);
      const collected = yield* collectLifecycle(adapter);
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
      expect(
        Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "die-before-ack" }))),
      ).toBe(true);
      yield* Deferred.await(collected.failed);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(collected.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      const resumed = yield* adapter.sendTurn({ threadId, input: "recover" });
      yield* Deferred.await(collected.drained);
      expect(resumed.resumeCursor).toEqual({ sessionId: "sess_lifecycle" });
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  ),
);

it.live(
  "waits beyond Stop acknowledgement and TurnComplete for the native prompt lock release",
  () =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          binary,
          lifecycleFixture.replace(
            "else if(method==='session/stop') {send({id,result:{}}); event('turn.completed',{resultType:'cancelled'}); send({method:'state.updated',params:{scope:'session',sessionId,revision:1,reason:'prompt_completed',patch:{}}});}",
            `else if(method==='session/stop') {
        send({id,result:{}});event('turn.completed',{resultType:'cancelled',usage:{inputTokens:3,outputTokens:1}});
        event('session.titleUpdated',{title:'stop-ack'});
        const watcher=fs.watch(process.env.HOME,(_,name)=>{if(name==='release'){
          watcher.close();send({method:'state.updated',params:{scope:'session',sessionId,revision:1,reason:'prompt_completed',patch:{}}});
        }});
      }`,
          ),
        );
        const adapter = yield* lifecycleAdapter(directory, binary);
        const ack = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        const events: ZCodeSessionEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "thread.metadata.updated" && event.payload.name === "stop-ack")
                yield* Deferred.succeed(ack, undefined);
              if (event.type === "turn.completed") yield* Deferred.succeed(terminal, undefined);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
        const first = yield* adapter.sendTurn({ threadId, input: "A" });
        const stopping = yield* adapter
          .interruptTurn(threadId, first.turnId)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(ack);
        expect(stopping.pollUnsafe()).toBeUndefined();
        expect(
          events.filter(
            (event) => event.type === "turn.aborted" || event.type === "turn.completed",
          ),
        ).toEqual([]);
        expect(
          Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "too early" }))),
        ).toBe(true);
        yield* fs.writeFileString(`${directory}/release`, "release");
        expect(yield* Fiber.join(stopping)).toMatchObject({
          usageStatus: "partial",
          inputTokens: 3,
          outputTokens: 1,
          totalTokens: 4,
        });
        const next = yield* adapter.sendTurn({ threadId, input: "recover" });
        yield* Deferred.await(terminal);
        expect(next.resumeCursor).toEqual(first.resumeCursor);
        expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
        expect(events.filter((event) => event.type === "session.exited")).toEqual([]);
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    ),
);

it.effect.each(["missing-boundary", "missing-ack"] as const)(
  "bounds Stop with %s and cold resumes instead of reusing a locked child",
  (mode) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          binary,
          lifecycleFixture.replace(
            "else if(method==='session/stop') {send({id,result:{}}); event('turn.completed',{resultType:'cancelled'}); send({method:'state.updated',params:{scope:'session',sessionId,revision:1,reason:'prompt_completed',patch:{}}});}",
            `else if(method==='session/stop') {${mode === "missing-boundary" ? "send({id,result:{}});" : ""}event('session.titleUpdated',{title:'stop-ack'});}`,
          ),
        );
        const adapter = yield* lifecycleAdapter(directory, binary);
        const ack = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        const events: ZCodeSessionEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "thread.metadata.updated" && event.payload.name === "stop-ack")
                yield* Deferred.succeed(ack, undefined);
              if (event.type === "turn.completed") yield* Deferred.succeed(terminal, undefined);
              if (event.type === "session.exited") yield* Deferred.succeed(exited, undefined);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
        const first = yield* adapter.sendTurn({ threadId, input: "A" });
        const stopping = yield* adapter
          .interruptTurn(threadId, first.turnId)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(ack);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(stopping);
        yield* Deferred.await(exited);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
        expect(events.find((event) => event.type === "turn.aborted")?.payload).toEqual({
          reason: "Interrupted from T3",
        });
        expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
        const next = yield* adapter.sendTurn({ threadId, input: "recover" });
        yield* Deferred.await(terminal);
        expect(next.resumeCursor).toEqual(first.resumeCursor);
        const wire = yield* Effect.forEach(
          (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
          (line) => decodeWire(line),
        );
        expect(wire.filter((message) => message.method === "session/create")).toHaveLength(1);
        expect(wire.filter((message) => message.method === "session/resume")).toMatchObject([
          { params: { sessionId: "sess_lifecycle" } },
        ]);
      }).pipe(Effect.scoped),
    ),
);

it.live(
  "denies idle permissions and cancels idle questions without opening unanswerable requests",
  () =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          binary,
          lifecycleFixture
            .replace(
              "if(!method) {",
              `if(!method) {
        if(String(id).startsWith('idle-')) {idleResponses.add(id);if(idleResponses.size===3)event('session.titleUpdated',{title:'drained'});}`,
            )
            .replace(
              "require('node:readline')",
              "const idleResponses=new Set();\nrequire('node:readline')",
            )
            .replace(
              "else if(method==='session/subscribe') send({id,result:{sessionId,eventSeq:0,events:[]}});",
              `else if(method==='session/subscribe') {
        send({id,result:{sessionId,eventSeq:0,events:[]}});
        send({id:'idle-permission',method:'interaction/requestPermission',params:{sessionId,requestId:'idle-permission',background:true,options:[]}});
        send({id:'idle-input',method:'interaction/requestUserInput',params:{sessionId,requestId:'idle-input',prompt:'Idle input'}});
        send({id:'idle-question',method:'interaction/requestUserInput',params:{sessionId,requestId:'idle-question',questions:[{header:'Idle',question:'Idle question?',options:[]}]}});
      }`,
            ),
        );
        const adapter = yield* lifecycleAdapter(directory, binary);
        const collected = yield* collectLifecycle(adapter);
        yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "approval-required" });
        yield* Deferred.await(collected.drained);
        expect(
          collected.events.filter(
            (event) => event.type === "request.opened" || event.type === "user-input.requested",
          ),
        ).toEqual([]);
        const wire = yield* Effect.forEach(
          (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
          (line) => decodeWire(line),
        );
        expect(wire.find((message) => message.id === "idle-permission")?.result).toEqual({
          decision: "deny",
        });
        expect(wire.find((message) => message.id === "idle-input")?.result).toEqual({
          requestId: "idle-input",
          cancelled: true,
        });
        expect(wire.find((message) => message.id === "idle-question")?.result).toEqual({
          action: "cancel",
        });
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
    ),
);

it.live.each([false, true])(
  "restores the base execution mode after starting in Plan (resume=%s)",
  (resume) =>
    withFixture((directory, binary) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(binary, goalFixture);
        const adapter = yield* makeZCodeSessionRuntime(settings(binary), options(directory));
        yield* adapter.startSession({
          threadId,
          cwd: directory,
          runtimeMode: "full-access",
          interactionMode: "plan",
          ...(resume ? { resumeCursor: { sessionId: "sess_app" } } : {}),
        });
        const terminals = yield* Queue.unbounded<void>();
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "turn.completed" ? Queue.offer(terminals, undefined) : Effect.void,
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* adapter.sendTurn({ threadId, input: "plan", interactionMode: "plan" });
        yield* Queue.take(terminals);
        yield* adapter.sendTurn({ threadId, input: "execute", interactionMode: "default" });
        yield* Queue.take(terminals);
        const wire = yield* Effect.forEach(
          (yield* fs.readFileString(`${directory}/wire.jsonl`)).trim().split("\n"),
          (line) => decodeWire(line),
        );
        if (!resume)
          expect(wire.find((message) => message.method === "session/create")).toMatchObject({
            params: { mode: "plan" },
          });
        expect(
          wire
            .filter((message) => message.method === "session/setMode")
            .map((message) => message.params),
        ).toEqual([
          ...(resume ? [{ sessionId: "sess_app", mode: "plan" }] : []),
          { sessionId: "sess_app", mode: "plan" },
          { sessionId: "sess_app", mode: "yolo" },
        ]);
        yield* adapter.sendTurn({ threadId, input: "/goal show", interactionMode: "default" });
        expect(yield* fs.readFileString(`${directory}/wire.jsonl`)).toContain(
          '"method":"session/goal"',
        );
      }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(NodeServices.layer)),
    ),
);
