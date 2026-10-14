import { ComputerDesktopResponse, type ComputerDesktopRequest } from "@t3tools/contracts";
import {
  COMPUTER_REQUEST_MAX_CHARS,
  COMPUTER_RESPONSE_MAX_CHARS,
  ComputerMessageReader,
  encodeComputerMessage,
} from "@t3tools/shared/computerProtocol";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ComputerDesktopResponse));

/** The transport is a desktop-owned inherited pipe, never a provider-supplied address. */
export class ComputerConnection {
  private readonly reader = new ComputerMessageReader(COMPUTER_RESPONSE_MAX_CHARS);
  private readonly pending = new Map<
    string,
    {
      owner: string;
      resolve: (response: ComputerDesktopResponse["result"]) => void;
      reject: (error: Error) => void;
      detach: () => void;
    }
  >();
  private closed = false;
  private stopSequence = 0;
  private readonly write: (bytes: Uint8Array) => Promise<void>;

  constructor(write: (bytes: Uint8Array) => Promise<void>) {
    this.write = write;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    for (const pending of this.pending.values()) {
      pending.detach();
      pending.reject(new Error("The desktop computer channel disconnected."));
    }
    this.pending.clear();
  }

  receive(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      for (const line of this.reader.push(bytes)) {
        const response = decode(line);
        const pending = this.pending.get(response.id);
        if (!pending) continue; // A canceled request may finish before the desktop observes Stop.
        this.pending.delete(response.id);
        pending.detach();
        pending.resolve(response.result);
      }
    } catch {
      this.close();
    }
  }

  async stopOwner(owner: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.write(
        encodeComputerMessage(
          {
            id: `revoke:${this.stopSequence++}`,
            invocation: { owner, threadTitle: "Computer access", readOnly: true },
            command: { kind: "stop" },
          },
          COMPUTER_REQUEST_MAX_CHARS,
        ),
      );
    } catch {
      this.close();
    }
  }

  request(
    request: ComputerDesktopRequest,
    signal: AbortSignal,
  ): Promise<ComputerDesktopResponse["result"]> {
    if (this.closed)
      return Promise.reject(new Error("The desktop computer channel is unavailable."));
    if (signal.aborted) return Promise.reject(new Error("Computer request canceled."));
    if (
      this.pending.has(request.id) ||
      this.pending.size >= 8 ||
      [...this.pending.values()].some((pending) => pending.owner === request.invocation.owner)
    ) {
      return Promise.reject(new Error("A computer operation is already pending."));
    }
    const bytes = encodeComputerMessage(request, COMPUTER_REQUEST_MAX_CHARS);
    const result = Promise.withResolvers<ComputerDesktopResponse["result"]>();
    const cancel = () => {
      if (!this.pending.delete(request.id)) return;
      result.reject(new Error("Computer request canceled."));
      // Revoke the whole owner grant: a timed-out click must never be retried implicitly.
      const stop = {
        ...request,
        id: `stop:${request.id}`.slice(0, 200),
        command: { kind: "stop" },
      };
      void this.write(encodeComputerMessage(stop, COMPUTER_REQUEST_MAX_CHARS)).catch(() =>
        this.close(),
      );
    };
    signal.addEventListener("abort", cancel, { once: true });
    this.pending.set(request.id, {
      owner: request.invocation.owner,
      ...result,
      detach: () => signal.removeEventListener("abort", cancel),
    });
    void this.write(bytes).catch(() => this.close());
    return result.promise;
  }
}
