import * as Schema from "effect/Schema";

/**
 * ZCode Protocol (app-server) wire schemas.
 *
 * Shapes were taken from the installed ZCode runtime's protocol tables and
 * verified against a live `zcode app-server` session. Schemas intentionally
 * ignore unknown struct members: the runtime adds fields over time and older
 * clients must keep working. Enum-like literals that grow on the server are
 * typed as strings with light validation instead of closed unions.
 */

/** Identifier strings used across the protocol (`sess_...`, `query_...`, uuids). */
export const Id = Schema.String.check(Schema.isNonEmpty());
export type Id = typeof Id.Type;

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const WorkspaceRef = Schema.Struct({
  workspacePath: Schema.String,
  workspaceIdentity: Schema.optional(Schema.String),
  remoteSessionId: Schema.optional(Schema.String),
  workspaceKey: Schema.String,
});
export type WorkspaceRef = typeof WorkspaceRef.Type;

export const ModelSelectionRef = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
  options: Schema.optional(
    Schema.Struct({
      reasoningLevel: Schema.optional(Schema.String),
    }),
  ),
});
export type ModelSelectionRef = typeof ModelSelectionRef.Type;

export const SessionMode = Schema.String;
export type SessionMode = typeof SessionMode.Type;

export const McpServerConfig = Schema.Union([
  Schema.Struct({
    name: Id,
    command: Id,
    args: Schema.Array(Schema.String),
    env: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    isolation: Schema.optional(Schema.String),
    protocolVersion: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Int),
  }),
  Schema.Struct({
    name: Id,
    type: Schema.Literals(["http", "sse"]),
    url: Id,
    headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    isolation: Schema.optional(Schema.String),
    protocolVersion: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Int),
  }),
]);
export type McpServerConfig = typeof McpServerConfig.Type;

export const RuntimeCapabilitiesParams = Schema.Struct({});

export const SessionCreateParams = Schema.Struct({
  sessionId: Schema.optional(Id),
  workspace: WorkspaceRef,
  parentSessionId: Schema.optional(Id),
  mode: Schema.optional(SessionMode),
  model: Schema.optional(ModelSelectionRef),
  persistence: Schema.optional(Schema.Literals(["immediate", "deferred"])),
  thoughtLevel: Schema.optional(Schema.String),
  titleGenerationEnabled: Schema.optional(Schema.Boolean),
  mcpServers: Schema.optional(Schema.Array(McpServerConfig)),
  toolAllowlist: Schema.optional(Schema.Array(Id)),
  toolDenylist: Schema.optional(Schema.Array(Id)),
  offPeakToolEnabled: Schema.optional(Schema.Boolean),
  dynamicWorkflowEnabled: Schema.optional(Schema.Boolean),
});
export type SessionCreateParams = typeof SessionCreateParams.Type;

export const SessionSummary = Schema.Struct({
  sessionId: Id,
  sessionKind: Schema.optional(Schema.String),
  status: Schema.String,
  mode: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
  workspace: Schema.optional(WorkspaceRef),
  traceId: Schema.optional(Schema.String),
  target: Schema.optional(Schema.Unknown),
});
export type SessionSummary = typeof SessionSummary.Type;

export const SessionSettingsProjection = Schema.Struct({
  mode: Schema.optional(Schema.Struct({ current: Schema.optional(Schema.String) })),
  model: Schema.optional(
    Schema.Struct({
      current: Schema.optional(ModelSelectionRef),
      available: Schema.optional(
        Schema.Array(
          Schema.Struct({
            ref: ModelSelectionRef,
            label: Schema.String,
            providerLabel: Schema.optional(Schema.String),
            description: Schema.optional(Schema.String),
            contextWindow: Schema.optional(Schema.Int),
            maxOutputTokens: Schema.optional(Schema.Int),
            disabledReason: Schema.optional(Schema.String),
          }),
        ),
      ),
      lastUsed: Schema.optional(ModelSelectionRef),
    }),
  ),
  thoughtLevel: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      current: Schema.optional(Schema.String),
      defaultLevel: Schema.optional(Schema.String),
      available: Schema.optional(
        Schema.Array(
          Schema.Struct({
            value: Schema.String,
            label: Schema.String,
            description: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
  permission: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.String),
      rulesRevision: Schema.optional(Schema.Number),
    }),
  ),
});
export type SessionSettingsProjection = typeof SessionSettingsProjection.Type;

export const SessionProjection = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  turnCount: Schema.optional(Schema.Number),
  totalTokenCount: Schema.optional(Schema.Number),
  contextUsed: Schema.optional(Schema.Number),
  contextWindow: Schema.optional(Schema.Number),
  activeToolCalls: Schema.optional(Schema.Array(Schema.Unknown)),
  backgroundJobs: Schema.optional(Schema.Array(Schema.Unknown)),
  pendingPermissions: Schema.optional(Schema.Array(Schema.Unknown)),
  target: Schema.optional(Schema.Unknown),
});
export type SessionProjection = typeof SessionProjection.Type;

export const SessionSnapshot = Schema.Struct({
  protocol: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.Number),
    }),
  ),
  session: Schema.optional(SessionSummary),
  settings: Schema.optional(SessionSettingsProjection),
  projection: Schema.optional(SessionProjection),
  runtime: Schema.optional(
    Schema.Struct({
      eventSeq: Schema.optional(Schema.Number),
      stateRevision: Schema.optional(Schema.Number),
      deliveryKind: Schema.optional(Schema.String),
      activeTurnId: Schema.optional(Schema.String),
      activeTurnKind: Schema.optional(Schema.String),
      pendingRequestIds: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  todos: Schema.optional(Schema.Array(Schema.Unknown)),
  slashCommands: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
        inputHint: Schema.optional(Schema.String),
        source: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type SessionSnapshot = typeof SessionSnapshot.Type;

export const SessionCreateResult = Schema.Struct({
  protocol: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.Number),
    }),
  ),
  session: Schema.optional(SessionSummary),
  settings: Schema.optional(SessionSettingsProjection),
  projection: Schema.optional(SessionProjection),
  runtime: Schema.optional(Schema.Unknown),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  slashCommands: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type SessionCreateResult = typeof SessionCreateResult.Type;

export const SessionResumeParams = Schema.Struct({
  sessionId: Id,
  workspace: Schema.optional(WorkspaceRef),
  thoughtLevel: Schema.optional(Schema.String),
  mcpServers: Schema.optional(Schema.Array(McpServerConfig)),
  toolAllowlist: Schema.optional(Schema.Array(Id)),
  toolDenylist: Schema.optional(Schema.Array(Id)),
});
export type SessionResumeParams = typeof SessionResumeParams.Type;

export const SessionListParams = Schema.Struct({
  workspace: Schema.optional(WorkspaceRef),
  sessionIds: Schema.optional(Schema.Array(Id)),
  includeArchived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
});
export type SessionListParams = typeof SessionListParams.Type;

export const SessionListResult = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
});
export type SessionListResult = typeof SessionListResult.Type;

export const SessionSubscribeParams = Schema.Struct({
  sessionId: Id,
  deliveryKind: Schema.Literals(["desktop-continuous", "web-remote-replayable"]),
  afterSeq: Schema.optional(NonNegativeInt),
  includeSnapshot: Schema.optional(Schema.Boolean),
});
export type SessionSubscribeParams = typeof SessionSubscribeParams.Type;

export const SessionEventEnvelope = Schema.Struct({
  type: Schema.String,
  sessionId: Schema.optional(Schema.String),
  eventId: Schema.optional(Schema.String),
  seq: Schema.optional(Schema.Number),
  timestamp: Schema.optional(Schema.Number),
  traceId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  deliveryKind: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type SessionEventEnvelope = typeof SessionEventEnvelope.Type;

export const SessionSubscribeResult = Schema.Struct({
  sessionId: Id,
  eventSeq: NonNegativeInt,
  events: Schema.Array(Schema.Unknown),
  snapshot: Schema.optional(Schema.Unknown),
});
export type SessionSubscribeResult = typeof SessionSubscribeResult.Type;

export const SessionSendParams = Schema.Struct({
  sessionId: Id,
  content: Schema.String,
  modelSelection: Schema.optional(ModelSelectionRef),
  inputId: Schema.optional(Id),
  queryId: Schema.optional(Id),
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  expectedRevision: Schema.optional(NonNegativeInt),
  toolDenylist: Schema.optional(Schema.Array(Id)),
});
export type SessionSendParams = typeof SessionSendParams.Type;

export const SessionSendResult = Schema.Struct({
  sessionId: Id,
  accepted: Schema.Literal(true),
  stateRevision: NonNegativeInt,
});
export type SessionSendResult = typeof SessionSendResult.Type;

// zai-org/ZCode@aac4755666d09fdcd70272fcf063c077a639015f,
// packages/shared/src/zcode-protocol/index.ts: session/goal is a control RPC,
// not a provider tool or a prompt interpreted by session/send.
export const SessionGoalParams = Schema.Struct({
  sessionId: Id,
  inputId: Schema.optional(Id),
  action: Schema.Literals(["show", "set", "replace", "pause", "resume", "clear"]),
  objective: Schema.optional(Schema.String),
});
export type SessionGoalParams = typeof SessionGoalParams.Type;

export const StateUpdatedNotification = Schema.Struct({
  scope: Schema.String,
  sessionId: Schema.optional(Id),
  reason: Schema.optional(Schema.String),
});

export const SessionStopParams = Schema.Struct({
  sessionId: Id,
});
export type SessionStopParams = typeof SessionStopParams.Type;

export const SessionSetModelParams = Schema.Struct({
  sessionId: Id,
  model: ModelSelectionRef,
  expectedRevision: Schema.optional(NonNegativeInt),
  persistAsWorkspaceLastUsed: Schema.optional(Schema.Boolean),
});
export type SessionSetModelParams = typeof SessionSetModelParams.Type;

export const SessionSetModeParams = Schema.Struct({
  sessionId: Id,
  mode: SessionMode,
  expectedRevision: Schema.optional(NonNegativeInt),
});
export type SessionSetModeParams = typeof SessionSetModeParams.Type;

export const SessionCloseParams = Schema.Struct({
  sessionId: Id,
  expectedPersistence: Schema.optional(Schema.Literals(["immediate", "deferred"])),
});
export type SessionCloseParams = typeof SessionCloseParams.Type;

export const SessionCloseResult = Schema.Struct({
  closed: Schema.optional(Schema.Boolean),
});
export type SessionCloseResult = typeof SessionCloseResult.Type;

export const RequestRuntimePreferencesParams = Schema.Struct({
  sessionId: Schema.optional(Id),
  scope: Schema.String,
});
export type RequestRuntimePreferencesParams = typeof RequestRuntimePreferencesParams.Type;

export const RequestRuntimePreferencesResult = Schema.Struct({
  nativeSearchEnhancementsEnabled: Schema.Boolean,
  memoryEnabled: Schema.optional(Schema.Boolean),
  askUserQuestionAutoResolutionEnabled: Schema.optional(Schema.Boolean),
  integratedTerminalShell: Schema.optional(Schema.Unknown),
  modelContextBudgetStrategy: Schema.optional(Schema.String),
});
export type RequestRuntimePreferencesResult = typeof RequestRuntimePreferencesResult.Type;

export const PermissionOption = Schema.Struct({
  optionId: Id,
  kind: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  response: Schema.optional(
    Schema.Struct({
      decision: Schema.String,
      reason: Schema.optional(Schema.String),
      modifiedInput: Schema.optional(Schema.Unknown),
      permissionUpdates: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
});
export type PermissionOption = typeof PermissionOption.Type;

export const RequestPermissionParams = Schema.Struct({
  sessionId: Schema.optional(Id),
  turnId: Schema.optional(Id),
  requestId: Schema.optional(Id),
  toolCallId: Schema.optional(Id),
  toolName: Schema.optional(Schema.String),
  riskLevel: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  origin: Schema.optional(Schema.Unknown),
  options: Schema.optional(Schema.Array(PermissionOption)),
  childSessionId: Schema.optional(Id),
  background: Schema.optional(Schema.Boolean),
});
export type RequestPermissionParams = typeof RequestPermissionParams.Type;

export const RequestOfficialMcpAuthHeadersParams = Schema.Struct({
  requestId: Id,
  workspace: WorkspaceRef,
  pluginId: Id,
  mcpKey: Id,
  targetOrigin: Id,
});
export type RequestOfficialMcpAuthHeadersParams = typeof RequestOfficialMcpAuthHeadersParams.Type;

export const RequestOfficialMcpAuthHeadersResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), headers: Schema.Record(Schema.String, Schema.String) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals([
      "official_auth_unavailable",
      "official_mcp_origin_untrusted",
      "official_auth_plan_required",
    ]),
  }),
]);
export type RequestOfficialMcpAuthHeadersResult = typeof RequestOfficialMcpAuthHeadersResult.Type;

export const RequestUserInputParams = Schema.Struct({
  sessionId: Schema.optional(Id),
  turnId: Schema.optional(Id),
  requestId: Id,
  prompt: Schema.optional(Schema.String),
  inputType: Schema.optional(Schema.Literals(["text", "choice", "confirm"])),
  choices: Schema.optional(Schema.Array(Schema.String)),
  questions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        question: Schema.String,
        header: Schema.String,
        multiSelect: Schema.optional(Schema.Boolean),
        options: Schema.Array(
          Schema.Struct({
            value: Schema.String,
            label: Schema.String,
            description: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  ),
});
export type RequestUserInputParams = typeof RequestUserInputParams.Type;

export const IncomingNotification = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
export type IncomingNotification = typeof IncomingNotification.Type;

/** Raw wire envelope before routing. */
export const IncomingRequest = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
export type IncomingRequest = typeof IncomingRequest.Type;

export const IncomingResponse = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
export type IncomingResponse = typeof IncomingResponse.Type;
