import { z } from "zod";
import { SubjectRevision } from "../domain/evidence/types.js";
import { ProposedEdit } from "../domain/fixes/types.js";
import type { PullRequestInput } from "../providers/scm/port.js";

/**
 * Outbox payload for a fix-PR effect. Persisted JSON is untrusted at the
 * boundary (heritage scar), so the dispatcher parses it through this schema
 * before performing the write.
 */
export const PullRequestPayload = z.object({
  subject: SubjectRevision,
  externalId: z.string().min(1),
  branch: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  edits: z.array(ProposedEdit).min(1),
});
export type PullRequestPayload = z.infer<typeof PullRequestPayload>;

export function toPullRequestInput(payload: PullRequestPayload): PullRequestInput {
  return {
    subject: payload.subject,
    externalId: payload.externalId,
    branch: payload.branch,
    title: payload.title,
    body: payload.body,
    edits: payload.edits.map((e) => ({
      path: e.path,
      startLine: e.startLine,
      endLine: e.endLine,
      replacement: e.replacement,
    })),
  };
}
