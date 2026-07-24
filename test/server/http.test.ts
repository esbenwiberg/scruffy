import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createWebhookServer } from "../../src/server/http.js";
import type { SubjectRevision } from "../../src/domain/evidence/types.js";
import { bootHarness, type Harness } from "../harness/boot.js";
import { REPO, SCENARIOS, signBody, webhookBody } from "../fixtures/scenarios.js";

/**
 * The hosted webhook listener against the REAL durable path (Postgres) with the
 * fake SCM — the same trust-edge layout as the rest of the harness. Pins the
 * boundary contract (status codes, ack-before-drive, durability-before-ack) and
 * one full webhook → analysis → effect flow through a real HTTP round trip.
 */

let harness: Harness;
let server: Server;
let base: string;
let driven: { subject: SubjectRevision; resolve: () => void; done: Promise<void> }[] = [];

/** Records drive calls. Each drive is parked on a gate the test releases, so a
 * test can observe that the HTTP ack does NOT wait on analysis; `done` settles
 * only after the full evaluate + effect flush. */
function recordedDrive(subject: SubjectRevision): Promise<void> {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const done = (async () => {
    await gate;
    await harness.scruffy.poison.evaluate(subject);
    await harness.scruffy.flushEffects();
  })();
  driven.push({ subject, resolve, done });
  return done;
}

function listen(s: Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function post(body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}/webhook`, { method: "POST", body, headers });
}

async function signedPost(body: string): Promise<Response> {
  return post(body, { "x-hub-signature-256": await signBody(body) });
}

beforeAll(async () => {
  harness = await bootHarness();
  for (const scenario of Object.values(SCENARIOS)) {
    harness.scm.seedChangedFiles({ repository: REPO, commitSha: scenario.commitSha }, scenario.files);
  }
  server = createWebhookServer(harness.scruffy, { drive: recordedDrive, log: () => {}, maxBodyBytes: 64 * 1024 });
  base = await listen(server);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await harness.pool.end();
});

describe("POST /webhook", () => {
  it("rejects a missing signature with 401 and creates nothing", async () => {
    const res = await post(webhookBody(SCENARIOS.clean!), {});
    expect(res.status).toBe(401);
  });

  it("rejects a FORGED signature with 401 — verification precedes everything", async () => {
    const body = webhookBody(SCENARIOS.clean!);
    const res = await post(body, { "x-hub-signature-256": "sha256=" + "0".repeat(64) });
    expect(res.status).toBe(401);
    expect(driven).toHaveLength(0);
  });

  it("rejects a correctly signed but non-JSON body with 400", async () => {
    const body = "not json";
    const res = await signedPost(body);
    expect(res.status).toBe(400);
  });

  it("acks an irrelevant action with 200 ignored (GitHub must not retry it)", async () => {
    const body = webhookBody(SCENARIOS.clean!, "labeled");
    const res = await signedPost(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(driven).toHaveLength(0);
  });

  it("rejects an oversized body with 413", async () => {
    const res = await post("x".repeat(65 * 1024), { "x-hub-signature-256": "sha256=" + "0".repeat(64) });
    expect(res.status).toBe(413);
  });

  it("acks 202 with a DURABLE pending run BEFORE the drive completes, then the drive decides it", async () => {
    driven = [];
    const res = await signedPost(webhookBody(SCENARIOS.realSecret!));
    expect(res.status).toBe(202);
    const ack = (await res.json()) as { accepted: boolean; runId: string };
    expect(ack.accepted).toBe(true);

    // The ack has arrived while the drive is still parked on its gate: the run
    // must already exist durably (crash-safe), still pending.
    await new Promise((r) => setTimeout(r, 20)); // let the background drive register
    expect(driven).toHaveLength(1);
    const { rows: pending } = await harness.pool.query("select state from evaluation_runs where id = $1", [ack.runId]);
    expect(pending[0]).toMatchObject({ state: "pending" });

    // Release the drive; the run reaches a decision and the effect lands.
    driven[0]!.resolve();
    await driven[0]!.done;
    const { rows: decided } = await harness.pool.query("select state from evaluation_runs where id = $1", [ack.runId]);
    expect(decided[0]).toMatchObject({ state: "decided" });
    const checks = harness.scm.recordedCheckRuns();
    expect(checks.some((c) => c.input.conclusion === "failure")).toBe(true);
  });

  it("redelivery of the same webhook is idempotent — same durable run, no duplicate", async () => {
    driven = [];
    const body = webhookBody(SCENARIOS.realSecret!, "synchronize");
    const first = (await (await signedPost(body)).json()) as { runId: string };
    const second = (await (await signedPost(body)).json()) as { runId: string };
    expect(second.runId).toBe(first.runId);
    // Settle the background drives fully before teardown (they hold pool clients).
    for (const d of driven) d.resolve();
    await Promise.all(driven.map((d) => d.done));
  });
});

describe("routing and health", () => {
  it("GET /healthz reports ok and runs the injected probe", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown paths 404; wrong methods 405", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/webhook`)).status).toBe(405);
    expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(405);
  });
});

describe("healthz failure", () => {
  it("returns 503 when the probe throws", async () => {
    const failing = createWebhookServer(harness.scruffy, {
      log: () => {},
      healthCheck: async () => {
        throw new Error("db down");
      },
    });
    const failingBase = await listen(failing);
    try {
      expect((await fetch(`${failingBase}/healthz`)).status).toBe(503);
    } finally {
      await new Promise((resolve) => failing.close(resolve));
    }
  });
});
