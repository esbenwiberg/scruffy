import { verify } from "@octokit/webhooks-methods";
import { z } from "zod";
import type { SubjectRevision } from "../domain/evidence/types.js";

/**
 * Webhook ingest. Two jobs, both mandatory before anything else happens:
 *  1. verify the delivery signature (reject forgeries);
 *  2. parse the payload through a schema (untrusted external input).
 *
 * The parsed result is only a subject to reconcile — the webhook is a prompt,
 * not authoritative state.
 */

const PullRequestEvent = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string().min(1) }),
  pull_request: z.object({
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  }),
});

export type IngestResult =
  | { kind: "ignored"; reason: string }
  | { kind: "poison_subject"; subject: SubjectRevision };

const RELEVANT_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export async function verifyAndParseWebhook(
  secret: string,
  signature: string,
  rawBody: string,
): Promise<IngestResult> {
  const valid = await verify(secret, rawBody, signature);
  if (!valid) throw new Error("invalid webhook signature");

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new Error("webhook body is not valid JSON");
  }

  const parsed = PullRequestEvent.safeParse(json);
  if (!parsed.success) {
    return { kind: "ignored", reason: "unsupported event shape" };
  }
  if (!RELEVANT_ACTIONS.has(parsed.data.action)) {
    return { kind: "ignored", reason: `action ${parsed.data.action} not relevant` };
  }

  return {
    kind: "poison_subject",
    subject: {
      repository: parsed.data.repository.full_name,
      commitSha: parsed.data.pull_request.head.sha,
    },
  };
}
