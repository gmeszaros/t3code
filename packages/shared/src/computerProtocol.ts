/** Limits include JSON framing; image responses are larger than input requests. */
export const COMPUTER_REQUEST_MAX_CHARS = 100_000;
export const COMPUTER_RESPONSE_MAX_CHARS = 8_000_000;

/** Dedicated inherited pipes carry one JSON object per line, without payload logging. */
export class ComputerMessageReader {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffered = "";
  private failed = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Uint8Array): string[] {
    if (this.failed) throw new Error("Computer channel is closed.");
    try {
      this.buffered += this.decoder.decode(chunk, { stream: true });
      const messages: string[] = [];
      let newline: number;
      while ((newline = this.buffered.indexOf("\n")) !== -1) {
        if (newline > this.limit) throw new Error("Computer message exceeds the transport limit.");
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        if (line.length > 0) messages.push(line);
      }
      if (this.buffered.length > this.limit) {
        throw new Error("Computer message exceeds the transport limit.");
      }
      return messages;
    } catch {
      this.failed = true;
      this.buffered = "";
      throw new Error("Computer channel contains an invalid or oversized message.");
    }
  }

  close(): void {
    this.failed = true;
    this.buffered = "";
  }
}

export function encodeComputerMessage(value: unknown, limit: number): Uint8Array {
  const message = JSON.stringify(value);
  if (message === undefined || message.length > limit) {
    throw new Error("Computer message exceeds the transport limit.");
  }
  return new TextEncoder().encode(`${message}\n`);
}
