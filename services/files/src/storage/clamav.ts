// ClamAV clamd TCP client (§5.4, FR-FILE-06). Readiness only in the skeleton: zPING → PONG.
import { connect } from "node:net";

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
