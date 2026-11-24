// clamd INSTREAM framing (FR-FILE-05) against a fake clamd: chunks are length-prefixed, a zero length ends the stream,
// and the reply decides clean / FOUND / error (error → TransientError, never a guessed verdict).
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ClamdScanner } from "./clamav.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server === undefined ? r() : server.close(() => r())));
  server = undefined;
});

/** Fake clamd: parses zINSTREAM framing, reassembles the body, replies with `verdict(body)`. */
async function fakeClamd(verdict: (body: Buffer) => string): Promise<{ port: number; bodies: Buffer[] }> {
  const bodies: Buffer[] = [];
  server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let commandDone = false;
    const parts: Buffer[] = [];
    socket.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (!commandDone) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        expect(buf.subarray(0, nul).toString()).toBe("zINSTREAM");
        buf = buf.subarray(nul + 1);
        commandDone = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const body = Buffer.concat(parts);
          bodies.push(body);
          socket.end(`${verdict(body)}\0`);
          return;
        }
        if (buf.length < 4 + len) return;
        parts.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return { port: (server?.address() as AddressInfo).port, bodies };
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe("ClamdScanner (INSTREAM)", () => {
  it("streams length-prefixed chunks (split at 1 MiB) and reports clean / FOUND", async () => {
    const clamd = await fakeClamd((b) =>
      b.includes(Buffer.from("EICAR")) ? "stream: Eicar-Signature FOUND" : "stream: OK",
    );
    const scanner = new ClamdScanner("127.0.0.1", clamd.port);
    const big = Buffer.alloc(2 * 1024 * 1024 + 5, 0x61);
    const s1 = await scanner.open();
    await s1.write(big);
    await s1.write(Buffer.from("tail"));
    expect(await s1.finish()).toEqual({ clean: true, signature: null });
    expect(clamd.bodies[0]?.length).toBe(big.length + 4);

    const s2 = await scanner.open();
    await s2.write(Buffer.from(EICAR));
    expect(await s2.finish()).toEqual({ clean: false, signature: "Eicar-Signature" });
  });

  it("an ERROR reply or an unreachable clamd is a TransientError (retry), never a verdict", async () => {
    const clamd = await fakeClamd(() => "INSTREAM size limit exceeded. ERROR");
    const s = await new ClamdScanner("127.0.0.1", clamd.port).open();
    await s.write(Buffer.from("x"));
    await expect(s.finish()).rejects.toMatchObject({ name: "TransientError" });
    await expect(new ClamdScanner("127.0.0.1", 1).open()).rejects.toMatchObject({ name: "TransientError" });
  });
});
