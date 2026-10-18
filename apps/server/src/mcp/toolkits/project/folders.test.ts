import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  OrchestrationProjectShell,
  type ThreadFolderMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as ManagedFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as Git from "../../../vcs/GitVcsDriver.ts";
import * as Settings from "../../../serverSettings.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as AccessTestkit from "../../McpToolAccess.testkit.ts";
import { toolkitRegistration } from "../../McpHttpServer.ts";
import * as Handlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const decodeShell = Schema.decodeUnknownSync(OrchestrationProjectShell);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "folder-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "folder-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope = (
  access: Invocation.McpClientCaller["access"],
  allowed = true,
): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("folder-test-environment"),
  requestNamespace: "folder-test",
  thread: undefined,
  client: { sessionId: "folder-test", label: "test", access },
  issuedAt: 0,
  capabilities: new Set(allowed ? ["orchestration"] : []),
});

it.effect(
  "exposes authoritative folders and gates stable folder commands through production MCP registration",
  () => {
    const mutations: ThreadFolderMutation[] = [];
    const reads: ProjectId[] = [];
    const projectId = ProjectId.make("folder-project");
    const folders = [
      {
        id: "folder",
        parentId: null,
        title: "Research",
        orderKey: null,
        threadIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const shell = decodeShell({
      id: projectId,
      title: "Project",
      workspaceRoot: "/workspace/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      threadFolders: folders,
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (
        name: string,
        args: Record<string, unknown>,
        invocation: Invocation.McpInvocationScope,
      ) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const read = yield* call("t3_thread_folders_read", { projectId }, scope("read-only"));
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toEqual({ threadFolders: folders });
      expect(reads).toEqual([projectId]);
      const mutation = {
        type: "threadFolder.move",
        commandId: "stable-folder-move",
        projectId,
        folderId: "folder",
        parentId: null,
      };
      const denied = yield* call("t3_thread_folders_update", { mutation }, scope("read-only"));
      expect(denied.isError).toBe(true);
      const noCapability = yield* call(
        "t3_thread_folders_update",
        { mutation },
        scope("full-access", false),
      );
      expect(noCapability.isError).toBe(true);
      expect(mutations).toEqual([]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const updated = yield* call("t3_thread_folders_update", { mutation }, scope("full-access"));
        expect(updated.isError).not.toBe(true);
        expect(updated.structuredContent).toEqual({ threadFolders: folders });
      }
      expect(mutations).toEqual([mutation, mutation]);
    }).pipe(
      Effect.provide(
        toolkitRegistration(ProjectToolkit, Handlers.layer).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(
            Layer.mock(Projects.ProjectService)({
              getShell: (id) =>
                Effect.sync(() => {
                  reads.push(id);
                  return Option.some(shell);
                }),
              mutateThreadFolders: (mutation) =>
                Effect.sync(() => {
                  mutations.push(mutation);
                  return { threadFolders: shell.threadFolders ?? [] };
                }),
            }),
          ),
          Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
          Layer.provide(
            Layer.mock(ManagedFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/workspace/named",
            }),
          ),
          Layer.provide(Layer.mock(Repositories.SourceControlRepositoryService)({})),
          Layer.provide(Layer.mock(Git.GitVcsDriver)({})),
          Layer.provide(AccessTestkit.liveThreadsLayer),
          Layer.provide(Settings.layerTest()),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "thread-folder-mcp-test-" }),
          ),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);
