// ClamAV clamd TCP client (§5.4): readiness (zPING → PONG) and INSTREAM scanning for FR-FILE-05.
import { connect } from "node:net";
import { TransientError } from "@aegispulse/ts-platform/errors";
import type { AvScanner, AvSession } from "../service/file-validation.service.js";

export function clamavCheck(host: string, port = 3310, timeoutMs = 2_000): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      const socket = connect({ host, port });
      let reply = "";
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error("clamd timeout")));
      socket.on("connect", () => socket.write("zPING\0"));
      socket.on("data", (chunk: Buffer) => {
        reply += chunk.toString("utf8");
      });
      socket.on("error", reject);
      socket.on("close", () =>
        reply.replace(/\0/g, "").trim() === "PONG" ? resolve() : reject(new Error("clamd did not answer PONG")),
      );
    });
}

// ── INSTREAM scanning (FR-FILE-05) ────────────────────────────────────────────

/** clamd's chunk framing: 4-byte big-endian length, then data; a zero length ends the stream. */
const MAX_CHUNK = 1024 * 1024;

/**
 * clamd `zINSTREAM` client. Connection problems, timeouts and clamd `ERROR` replies (e.g. StreamMaxLength exceeded)
 * are TransientError, so the consumer retries and finally dead-letters; a verdict is never guessed.
 */
export class ClamdScanner implements AvScanner {
  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 120_000,
  ) {}

  async open(): Promise<AvSession> {
    const socket = connect({ host: this.host, port: this.port });
    let reply = "";
    let failure: unknown;
    socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error("clamd timeout")));
    socket.on("data", (c: Buffer) => {
      reply += c.toString("utf8");
    });
    const closed = new Promise<void>((resolve) => {
      socket.on("error", (e: unknown) => {
        failure ??= e;
      });
      socket.on("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", (e) =>
        reject(new TransientError("DEPENDENCY_UNAVAILABLE", "clamd unreachable", { cause: e })),
      );
    });
    socket.write("zINSTREAM\0");

    const send = async (buf: Buffer): Promise<void> => {
      if (socket.destroyed) return; // clamd replied early (e.g. size limit); finish() reports it
      if (!socket.write(buf)) {
        await new Promise<void>((resolve) => {
          socket.once("drain", () => resolve());
          socket.once("close", () => resolve());
        });
      }
    };
    return {
      write: async (chunk) => {
        for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
          const part = chunk.subarray(i, i + MAX_CHUNK);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(part.length);
          await send(Buffer.concat([header, part]));
        }
      },
      finish: async () => {
        await send(Buffer.alloc(4));
        socket.end();
        await closed;
        const text = reply.replace(/\0/g, "").trim();
        const found = /^stream: (.+) FOUND$/.exec(text);
        if (found !== null) return { clean: false, signature: found[1] ?? null };
        if (text === "stream: OK") return { clean: true, signature: null };
        throw new TransientError(
          "DEPENDENCY_UNAVAILABLE",
          `clamd did not return a verdict (${text.slice(0, 120) || "no reply"})`,
          {
            cause: failure,
          },
        );
      },
      abort: () => socket.destroy(),
    };
  }
}
