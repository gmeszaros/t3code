import * as Schema from "effect/Schema";

/**
 * Errors for the ZCode Protocol stdio app-server client.
 *
 * The wire protocol is a custom line-delimited JSON envelope (not JSON-RPC):
 * client requests carry `{ id, method, params }`, the server answers with
 * `{ id, result }` or `{ id, error: { code, message, data? } }`, and the
 * server issues its own requests to the client with string ids such as
 * `server-1`, which the client answers with `{ id, result }`.
 */

export interface ZCodeAppServerErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type ZCodeAppServerError =
  | ZCodeAppServerSpawnError
  | ZCodeAppServerProcessExitedError
  | ZCodeAppServerProtocolParseError
  | ZCodeAppServerRequestError;

export class ZCodeAppServerSpawnError extends Schema.TaggedError<ZCodeAppServerSpawnError>()(
  "ZCodeAppServerSpawnError",
  {
    command: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.command
      ? `Failed to spawn ZCode app-server process for command: ${this.command}`
      : "Failed to spawn ZCode app-server process";
  }
}

export class ZCodeAppServerProcessExitedError extends Schema.TaggedError<ZCodeAppServerProcessExitedError>()(
  "ZCodeAppServerProcessExitedError",
  {
    code: Schema.optional(Schema.Number),
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.code === undefined
      ? "ZCode app-server process exited"
      : `ZCode app-server process exited with code ${this.code}`;
  }
}

export class ZCodeAppServerProtocolParseError extends Schema.TaggedError<ZCodeAppServerProtocolParseError>()(
  "ZCodeAppServerProtocolParseError",
  {
    operation: Schema.Literals([
      "encode-wire-message",
      "decode-wire-message",
      "route-wire-message",
      "decode-notification-payload",
      "decode-request-payload",
      "decode-response-payload",
      "encode-request-payload",
      "encode-response-payload",
    ]),
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const method = this.method === undefined ? "" : ` for method '${this.method}'`;
    const detail = this.detail === undefined ? "" : ` ${this.detail}`;
    return `ZCode Protocol operation '${this.operation}' failed${method}.${detail}`;
  }
}

export class ZCodeAppServerRequestError extends Schema.TaggedError<ZCodeAppServerRequestError>()(
  "ZCodeAppServerRequestError",
  {
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.Number),
    detail: Schema.String,
    data: Schema.optionalKey(Schema.Unknown),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const target =
      this.method === undefined
        ? this.requestId === undefined
          ? "request"
          : `request ${this.requestId}`
        : `request '${this.method}'`;
    return `ZCode Protocol ${target} failed: ${this.detail}`;
  }

  static methodNotFound(method: string) {
    return new ZCodeAppServerRequestError({
      method,
      detail: "Method not supported by this client",
      code: -32601,
    });
  }

  static fromServerError(requestId: string | number, error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      "message" in error &&
      typeof (error as { code: unknown }).code === "number" &&
      typeof (error as { message: unknown }).message === "string"
    ) {
      const shaped = error as { code: number; message: string; data?: unknown };
      return new ZCodeAppServerRequestError({
        requestId: String(requestId),
        detail: shaped.message,
        code: shaped.code,
        ...(shaped.data !== undefined ? { data: shaped.data } : {}),
      });
    }
    return new ZCodeAppServerRequestError({
      requestId: String(requestId),
      detail: typeof error === "string" ? error : JSON.stringify(error),
    });
  }
}
