import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Scruffy } from "../app/scruffy.js";
import type { SubjectRevision } from "../domain/evidence/types.js";
import { InvalidSignatureError, MalformedPayloadError } from "../ingest/webhook.js";
import type { ReleaseAuthorityService } from "../app/release-authority.js";
import { ReleaseAuthorityError } from "../app/release-authority.js";
import type { GithubActionsOidcVerifier } from "../providers/identity/github-actions-oidc.js";
import { GithubActionsOidcError } from "../providers/identity/github-actions-oidc.js";
import { ZodError } from "zod";

/**
 * The hosted webhook listener. Deliberately node:http with zero framework —
 * two routes do not justify a dependency on the inbound trust boundary.
 *
 * POST /webhook: verify signature → parse → durably ensure the poison run →
 * ack 202 → drive the evaluation in the BACKGROUND. The ack must beat GitHub's
 * ~10s delivery budget, and analysis (SCM reads, validation) can exceed it, so
 * the ack promises only durability, never completion. A crash after the ack
 * loses nothing: the reconcile loop finds the `pending` run and drives it.
 *
 * GET /healthz: liveness plus whatever `healthCheck` probes (main wires a DB
 * ping). 503 on failure.
 *
 * ERROR MAPPING at the boundary: bad signature → 401 (typed, not string-matched),
 * unparseable body → 400, ignored-but-valid events → 200, oversized body → 413,
 * anything unexpected → 500 with a GENERIC body (details go to the log — an
 * internal error message is not for the caller).
 */

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // PR webhook payloads are ~10 KiB; 1 MiB is generous.

export interface WebhookServerOptions {
  /** Reject request bodies larger than this with 413. */
  maxBodyBytes?: number;
  /**
   * Drives an accepted run after the 202 has gone out. Injectable for tests.
   * Default: poison evaluate + flush effects. Failures are logged and left to
   * the reconciler — the run is already durable.
   */
  drive?: (subject: SubjectRevision) => Promise<void>;
  /** Extra readiness probe for /healthz (e.g. a DB ping). Throw = unhealthy. */
  healthCheck?: () => Promise<void>;
  /** Optional hosted release authority. Both fields are required to enable /v1/release-* routes. */
  releaseAuthority?: ReleaseAuthorityService;
  oidcVerifier?: GithubActionsOidcVerifier;
  /** Log sink, injectable for tests. */
  log?: (message: string) => void;
}

export function createWebhookServer(scruffy: Scruffy, options: WebhookServerOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = options.log ?? ((message: string) => console.error(message));
  const drive =
    options.drive ??
    (async (subject: SubjectRevision) => {
      await scruffy.poison.evaluate(subject);
      await scruffy.flushEffects();
    });

  return createServer((req, res) => {
    void route(req, res).catch((err) => {
      // Last-resort containment: nothing below should reject, but an unhandled
      // rejection here would crash the whole listener.
      log(
        `webhook-server: unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (path === "/healthz") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      try {
        await options.healthCheck?.();
        return json(res, 200, { ok: true });
      } catch (err) {
        log(
          `webhook-server: health check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return json(res, 503, { ok: false });
      }
    }

    if (path === "/webhook") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return handleWebhook(req, res);
    }

    if (path === "/v1/release-reports" && req.method === "POST") {
      return handleReleaseAuthority(req, res, { kind: "request-report" });
    }
    const reportMatch = path.match(/^\/v1\/release-reports\/([^/]+)$/);
    if (reportMatch && req.method === "GET") {
      return handleReleaseAuthority(req, res, { kind: "get-report", reportId: reportMatch[1]! });
    }
    const attestationMatch = path.match(/^\/v1\/release-reports\/([^/]+)\/attestations$/);
    if (attestationMatch && req.method === "POST") {
      return handleReleaseAuthority(req, res, {
        kind: "attest",
        reportId: attestationMatch[1]!,
      });
    }
    const authorizationMatch = path.match(/^\/v1\/release-reports\/([^/]+)\/authorizations$/);
    if (authorizationMatch && req.method === "POST") {
      return handleReleaseAuthority(req, res, {
        kind: "authorize",
        reportId: authorizationMatch[1]!,
      });
    }
    if (path.startsWith("/v1/release-")) {
      return json(res, options.releaseAuthority ? 405 : 404, {
        error: options.releaseAuthority ? "method not allowed" : "not found",
      });
    }

    return json(res, 404, { error: "not found" });
  }

  async function handleReleaseAuthority(
    req: IncomingMessage,
    res: ServerResponse,
    operation:
      | { kind: "request-report" }
      | { kind: "get-report"; reportId: string }
      | { kind: "attest"; reportId: string }
      | { kind: "authorize"; reportId: string },
  ): Promise<void> {
    const authority = options.releaseAuthority;
    const verifier = options.oidcVerifier;
    if (!authority || !verifier) return json(res, 404, { error: "not found" });
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return json(res, 401, { error: "missing bearer token" });
    }
    try {
      const identity = await verifier.verify(
        authorization.slice("Bearer ".length),
        operation.kind === "attest" ? { requireEnvironment: authority.approvalEnvironment } : {},
      );
      if (operation.kind === "get-report") {
        return json(res, 200, await authority.getReport(identity, operation.reportId));
      }
      const rawBody = await readBody(req, maxBodyBytes);
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json(res, 400, { error: "malformed JSON" });
      }
      if (operation.kind === "request-report") {
        return json(res, 200, await authority.requestReport(identity, body));
      }
      if (operation.kind === "attest") {
        return json(res, 201, await authority.attest(identity, operation.reportId, body));
      }
      return json(res, 201, await authority.authorize(identity, operation.reportId, body));
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json(res, 413, { error: "payload too large" });
      if (error instanceof GithubActionsOidcError)
        return json(res, 401, { error: "invalid bearer token" });
      if (error instanceof ZodError) return json(res, 400, { error: "invalid request" });
      if (error instanceof ReleaseAuthorityError)
        return json(res, error.status, { error: error.message });
      log(
        `release-authority: request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      return json(res, 500, { error: "internal error" });
    }
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawSignature = req.headers["x-hub-signature-256"];
    const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;
    if (!signature) return json(res, 401, { error: "missing x-hub-signature-256" });

    let body: string;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return json(res, 413, { error: "payload too large" });
      throw err;
    }

    let result: Awaited<ReturnType<Scruffy["acceptWebhook"]>>;
    try {
      result = await scruffy.acceptWebhook(signature, body);
    } catch (err) {
      if (err instanceof InvalidSignatureError)
        return json(res, 401, { error: "invalid signature" });
      if (err instanceof MalformedPayloadError)
        return json(res, 400, { error: "malformed payload" });
      // ensureRun failed (e.g. DB down): a durability failure must NOT 2xx —
      // GitHub marks the delivery failed and an operator can redeliver it.
      log(`webhook-server: accept failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 500, { error: "internal error" });
    }

    if (!result.accepted) return json(res, 200, { ignored: true, reason: result.reason });

    // Ack now — the run is durable. Then drive in the background; a failure here
    // is the reconciler's job, not the delivery's.
    json(res, 202, { accepted: true, runId: result.runId });
    const { runId, subject } = result;
    void drive(subject).catch((err) => {
      log(
        `webhook-server: background drive of run ${runId} failed (reconciler will recover): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (rejected) {
        // Already over the cap: stop buffering but keep draining so the 413 can
        // flush to the client (destroying the socket mid-upload loses the
        // response). An abusive stream still gets a hard stop.
        if (total > maxBytes * 8) req.destroy();
        return;
      }
      if (total > maxBytes) {
        rejected = true;
        reject(new BodyTooLargeError(`body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
