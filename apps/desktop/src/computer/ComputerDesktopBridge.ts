import { ComputerDesktopRequest } from "@t3tools/contracts";
import {
  COMPUTER_REQUEST_MAX_CHARS,
  COMPUTER_RESPONSE_MAX_CHARS,
  ComputerMessageReader,
  encodeComputerMessage,
} from "@t3tools/shared/computerProtocol";
import * as Schema from "effect/Schema";

import type { ComputerAccessHost } from "./ComputerAccessHost.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ComputerDesktopRequest));

/** One instance per backend run; closing its pipes revokes every grant it owns. */
export class ComputerDesktopBridge {
  private readonly reader = new ComputerMessageReader(COMPUTER_REQUEST_MAX_CHARS);
  private readonly host: Pick<ComputerAccessHost, "handle" | "close">;
  private readonly write: (bytes: Uint8Array) => Promise<void>;
  private readonly pending = new Set<string>();
  private closed = false;

  constructor(
    host: Pick<ComputerAccessHost, "handle" | "close">,
    write: (bytes: Uint8Array) => Promise<void>,
  ) {
    this.host = host;
    this.write = write;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    this.host.close();
  }

  receive(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      for (const line of this.reader.push(bytes)) {
        const request = decode(line);
        if (this.pending.has(request.id) || this.pending.size >= 16) {
          this.close();
          return;
        }
        this.pending.add(request.id);
        // Do not queue behind consent: Stop must reach an open native dialog immediately.
        void this.dispatch(request);
      }
    } catch {
      this.close();
    }
  }

  private async dispatch(request: ComputerDesktopRequest): Promise<void> {
    try {
      const response = await this.host.handle(request);
      if (!this.closed)
        await this.write(encodeComputerMessage(response, COMPUTER_RESPONSE_MAX_CHARS));
    } catch {
      this.close();
    } finally {
      this.pending.delete(request.id);
    }
  }
}
