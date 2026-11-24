// FR-FILE-01..04 through the gateway against the compose stack: init → presigned PUT straight to the object store
// (PUBLIC_OBJECTS_URL) → complete → UPLOADED; dedup; complete without a PUT; abort; tenant isolation.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, world } from "./support/world.js";

function pdf(): { body: Buffer; input: Record<string, unknown> } {
  const body = Buffer.from(`%PDF-1.7 e2e ${randomUUID()}`);
  return {
    body,
    input: {
      filename: "e2e-report.pdf",
      contentType: "application/pdf",
      sizeBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      purpose: "FILING",
    },
  };
}

interface Upload {
  method: string;
  url: string;
  headers: Record<string, string>;
}

describe("file uploads over the gateway (FR-FILE-01..04)", () => {
  it("ANALYST: init (201) → PUT to the presigned URL → complete → UPLOADED; same content again → 200 deduplicated", async () => {
    const w = await world();
    const token = w.a.users.ANALYST.token;
    const { body, input } = pdf();
    const init = await call("POST", "/v1/files/uploads/init", { token, body: input });
    expect(init.status).toBe(201);
    const data = init.body.data as unknown as { fileId: string; status: string; upload: Upload };
    expect(data.status).toBe("INITIATED");
    expect(data.upload.url).not.toContain("e2e-report");
    const put = await fetch(data.upload.url, { method: "PUT", headers: data.upload.headers, body });
    expect(put.status).toBe(200);
    const done = await call("POST", `/v1/files/uploads/${data.fileId}/complete`, { token });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ id: data.fileId, status: "UPLOADED", sha256: input["sha256"] });
    expect(JSON.stringify(done.body.data)).not.toContain("storageKey");

    const again = await call("POST", "/v1/files/uploads/init", { token, body: { ...input, filename: "copy.pdf" } });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ fileId: data.fileId, deduplicated: true });
    expect(again.body.data?.["upload"]).toBeUndefined();
  });

  it("complete without a PUT → 409 UPLOAD_NOT_FOUND_IN_STORAGE; abort → EXPIRED; tenant B sees 404", async () => {
    const w = await world();
    const integ = w.a.integration.token;
    const init = await call("POST", "/v1/files/uploads/init", { token: integ, body: pdf().input });
    expect(init.status).toBe(201);
    const fileId = String(init.body.data?.["fileId"]);
    const early = await call("POST", `/v1/files/uploads/${fileId}/complete`, { token: integ });
    expect({ status: early.status, code: early.body.error?.code }).toEqual({
      status: 409,
      code: "UPLOAD_NOT_FOUND_IN_STORAGE",
    });
    const other = await call("POST", `/v1/files/uploads/${fileId}/abort`, { token: w.b.users.ANALYST.token });
    expect(other.status).toBe(404);
    const aborted = await call("POST", `/v1/files/uploads/${fileId}/abort`, { token: integ });
    expect(aborted.body.data).toMatchObject({ status: "EXPIRED" });
  });

  it("type allowlist (422), the filename pattern (422), contract size bound (422) and PLATFORM_ADMIN via X-Aegis-Tenant", async () => {
    const w = await world();
    const token = w.a.users.ANALYST.token;
    const base = pdf().input;
    const bad = await call("POST", "/v1/files/uploads/init", {
      token,
      body: { ...base, contentType: "application/zip" },
    });
    expect(bad.body.error?.code).toBe("FILE_TYPE_NOT_ALLOWED");
    const traversal = await call("POST", "/v1/files/uploads/init", {
      token,
      body: { ...base, filename: "../../etc/passwd" },
    });
    expect({ status: traversal.status, code: traversal.body.error?.code }).toEqual({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    const big = await call("POST", "/v1/files/uploads/init", {
      token,
      body: { ...base, sizeBytes: 512 * 1024 * 1024 + 1 },
    });
    // Above the contract maximum (512 MiB) the request itself is invalid (422); FILE_TOO_LARGE (413) is for sizes
    // the schema allows but the configuration does not (> 64 MiB with multipart off; integration-tested).
    expect({ status: big.status, code: big.body.error?.code }).toEqual({ status: 422, code: "VALIDATION_ERROR" });
    const pa = await call("POST", "/v1/files/uploads/init", {
      token: w.pa,
      headers: { "x-aegis-tenant": w.a.id },
      body: pdf().input,
    });
    expect(pa.status).toBe(201);
    const paNoTenant = await call("POST", "/v1/files/uploads/init", { token: w.pa, body: pdf().input });
    expect(paNoTenant.status).toBe(403);
  });

  it("validation over the stack (FR-FILE-05/07/08): clean PDF → VALIDATED + downloadable; EICAR (real clamd) and PDF-as-CSV → QUARANTINED", async () => {
    const w = await world();
    const token = w.a.users.ANALYST.token;
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    const cases: [Buffer, string, string][] = [
      [Buffer.from(`%PDF-1.7 clean ${randomUUID()}`), "application/pdf", "VALIDATED"],
      [eicar, "text/plain", "QUARANTINED"],
      [Buffer.from(`%PDF-1.4 declared as csv ${randomUUID()}`), "text/csv", "QUARANTINED"],
    ];
    const ids: string[] = [];
    for (const [body, contentType] of cases) {
      const input = {
        filename: "probe.txt",
        contentType,
        sizeBytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        purpose: "OTHER",
        allowDuplicate: true,
      };
      const init = await call("POST", "/v1/files/uploads/init", { token, body: input });
      expect(init.status).toBe(201);
      const data = init.body.data as unknown as { fileId: string; upload: Upload };
      expect((await fetch(data.upload.url, { method: "PUT", headers: data.upload.headers, body })).status).toBe(200);
      expect((await call("POST", `/v1/files/uploads/${data.fileId}/complete`, { token })).body.data).toMatchObject({
        status: "UPLOADED",
      });
      ids.push(data.fileId);
    }
    const settled = async (id: string): Promise<Record<string, unknown>> => {
      for (let i = 0; i < 60; i++) {
        const r = await call("GET", `/v1/files/${id}`, { token });
        if (r.body.data?.["status"] !== "UPLOADED") return r.body.data ?? {};
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error(`file ${id} still UPLOADED after 30 s`);
    };
    const [clean, malware, mismatch] = await Promise.all(ids.map(settled));
    expect(clean).toMatchObject({ status: "VALIDATED", detectedType: "application/pdf", artifacts: [] });
    expect(malware).toMatchObject({
      status: "QUARANTINED",
      failureReason: expect.stringMatching(/^MALWARE:/) as unknown,
    });
    expect(mismatch).toMatchObject({ status: "QUARANTINED", failureReason: "TYPE_MISMATCH:application/pdf" });

    // FR-FILE-08: a VALIDATED file downloads as an attachment; a quarantined one needs TENANT_ADMIN + acknowledgement.
    const dl = await call("GET", `/v1/files/${String(ids[0])}/download-url`, { token });
    const got = await fetch(String(dl.body.data?.["url"]));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-disposition")).toContain("attachment");
    const denied = await call("GET", `/v1/files/${String(ids[1])}/download-url?acknowledgeQuarantine=true`, { token });
    expect({ status: denied.status, code: denied.body.error?.code }).toEqual({ status: 403, code: "FILE_QUARANTINED" });
    const ta = w.a.users.TENANT_ADMIN.token;
    expect((await call("GET", `/v1/files/${String(ids[1])}/download-url`, { token: ta })).status).toBe(403);
    const acked = await call("GET", `/v1/files/${String(ids[1])}/download-url?acknowledgeQuarantine=true`, {
      token: ta,
    });
    expect(acked.status).toBe(200);
    expect((await fetch(String(acked.body.data?.["url"]))).status).toBe(200);

    // FR-FILE-09: list by status; tenant B sees none of A's files.
    const listed = await call("GET", "/v1/files?status=QUARANTINED&limit=100", { token });
    expect((listed.body.data as unknown as { id: string }[]).map((f) => f.id)).toEqual(
      expect.arrayContaining([ids[1], ids[2]]),
    );
    const other = await call("GET", `/v1/files/${String(ids[0])}`, { token: w.b.users.ANALYST.token });
    expect(other.status).toBe(404);
  });

  it("FR-FILE-12 TENANT_ADMIN soft-deletes a file (then 404); ANALYST may not delete", async () => {
    const w = await world();
    const init = await call("POST", "/v1/files/uploads/init", { token: w.a.users.ANALYST.token, body: pdf().input });
    const fileId = String(init.body.data?.["fileId"]);
    expect((await call("DELETE", `/v1/files/${fileId}`, { token: w.a.users.ANALYST.token })).status).toBe(403);
    const del = await call("DELETE", `/v1/files/${fileId}`, { token: w.a.users.TENANT_ADMIN.token });
    expect(del.status).toBe(200);
    expect((await call("GET", `/v1/files/${fileId}`, { token: w.a.users.ANALYST.token })).status).toBe(404);
    expect((await call("DELETE", `/v1/files/${fileId}`, { token: w.a.users.TENANT_ADMIN.token })).status).toBe(404);
  });

  it(
    "FR-FILE-13 a 200 MiB file uploads as 16 MiB parts (every request < 100 MB) → UPLOADED → VALIDATED",
    { timeout: 300_000 },
    async () => {
      const w = await world();
      const token = w.a.users.ANALYST.token;
      const size = 200 * 1024 * 1024;
      const body = Buffer.alloc(size, `synthetic ledger line ${randomUUID()}\n`);
      const init = await call("POST", "/v1/files/uploads/init", {
        token,
        body: {
          filename: "ledger-200mib.txt",
          contentType: "text/plain",
          sizeBytes: size,
          sha256: createHash("sha256").update(body).digest("hex"),
          purpose: "OTHER",
        },
      });
      expect(init.status).toBe(201);
      const data = init.body.data as unknown as {
        fileId: string;
        multipart: { uploadId: string; partSizeBytes: number; parts: { partNumber: number; url: string }[] };
      };
      expect(data.multipart.parts).toHaveLength(13);
      const parts: { partNumber: number; etag: string }[] = [];
      for (const part of data.multipart.parts) {
        const start = (part.partNumber - 1) * data.multipart.partSizeBytes;
        const chunk = body.subarray(start, Math.min(size, start + data.multipart.partSizeBytes));
        expect(chunk.length).toBeLessThan(100_000_000); // Cloudflare's edge cap
        const res = await fetch(part.url, { method: "PUT", body: chunk });
        expect(res.status).toBe(200);
        parts.push({ partNumber: part.partNumber, etag: res.headers.get("etag") ?? "" });
      }
      const done = await call("POST", `/v1/files/uploads/${data.fileId}/complete`, { token, body: { parts } });
      expect(done.status).toBe(200);
      expect(done.body.data).toMatchObject({ status: "UPLOADED", sizeBytes: size });
      let status = "UPLOADED";
      for (let i = 0; i < 240 && status === "UPLOADED"; i++) {
        await new Promise((r) => setTimeout(r, 500));
        status = String((await call("GET", `/v1/files/${data.fileId}`, { token })).body.data?.["status"]);
      }
      expect(status).toBe("VALIDATED"); // full SHA-256 + clamd scan of 200 MiB
    },
  );
});
