import * as Schema from "effect/Schema";

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const ContextFields = {
  requestId: NonEmpty,
  sessionId: NonEmpty,
  turnId: Schema.optional(NonEmpty),
  workspaceKey: Schema.optional(NonEmpty),
  workspacePath: Schema.optional(NonEmpty),
  workspaceIdentity: Schema.optional(NonEmpty),
  remoteSessionId: Schema.optional(NonEmpty),
  clientMode: Schema.optional(Schema.Literals(["desktop-continuous", "web-remote-replayable"])),
  sessionContext: Schema.optional(Schema.Literals(["live", "cached"])),
};

// Mirrors ZCode aac4755666d0 interaction/browser{List,Execute}. Unknown
// command variants remain decodable so they get an explicit unsupported result.
export const BrowserListParams = Schema.Struct({
  ...ContextFields,
  workspaceKey: NonEmpty,
  workspacePath: NonEmpty,
  clientMode: Schema.Literals(["desktop-continuous", "web-remote-replayable"]),
  sessionContext: Schema.Literals(["live", "cached"]),
});
export type BrowserListParams = typeof BrowserListParams.Type;
export const BrowserExecuteParams = Schema.Struct({
  ...ContextFields,
  browserId: Schema.optional(NonEmpty),
  browserGeneration: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  command: Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.makeFilter(
      (command) =>
        (typeof command.method === "string" && command.method.length > 0) ||
        "Expected a native browser command method",
    ),
  ),
});
export type BrowserExecuteParams = typeof BrowserExecuteParams.Type;
export interface BrowserListResult {
  readonly browsers: ReadonlyArray<{
    readonly id: string;
    readonly generation: number;
    readonly type: "cdp";
    readonly name: string;
    readonly capabilities: {
      readonly browser: ReadonlyArray<{ id: string; description: string }>;
      readonly tab: ReadonlyArray<{ id: string; description: string }>;
    };
    readonly apiSupportOverrides?: Readonly<Record<string, boolean>>;
  }>;
}
export const BrowserTabSummary = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  viewport: Schema.Struct({
    width: Schema.Number.check(Schema.isGreaterThan(0)),
    height: Schema.Number.check(Schema.isGreaterThan(0)),
  }),
});
export type BrowserTabSummary = typeof BrowserTabSummary.Type;
export interface BrowserExecuteResult {
  readonly ok: boolean;
  readonly state?: {
    readonly url: string;
    readonly title: string;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
    readonly viewportWidth?: number;
    readonly viewportHeight?: number;
  };
  readonly value?: unknown;
  readonly image?: { readonly base64: string; readonly mimeType: "image/png" };
  readonly tab?: BrowserTabSummary;
  readonly tabs?: ReadonlyArray<NonNullable<BrowserExecuteResult["tab"]>>;
  readonly dialog?: {
    readonly type: "alert" | "confirm" | "prompt" | "beforeunload";
    readonly message: string;
    readonly defaultPrompt?: string;
  } | null;
  readonly error?: {
    readonly code:
      | "backend_unavailable"
      | "capability_unsupported"
      | "duplicate_request_id"
      | "cancelled"
      | "execution_error";
    readonly message: string;
    readonly sideEffect: "none" | "uncertain";
  };
  readonly elapsedMs: number;
}
