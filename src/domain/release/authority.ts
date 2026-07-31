import { createHash } from "node:crypto";
import { z } from "zod";
import { ReleaseReportSubject } from "./report.js";

export const GithubIdentity = z.object({
  login: z.string().min(1),
  id: z.string().regex(/^\d+$/),
});
export type GithubIdentity = z.infer<typeof GithubIdentity>;

export const WorkflowIdentity = z.object({
  issuer: z.literal("https://token.actions.githubusercontent.com"),
  audience: z.string().min(1),
  repository: z.string().min(3),
  repositoryId: z.string().regex(/^\d+$/),
  workflowRef: z.string().min(1),
  runId: z.string().regex(/^\d+$/),
  runAttempt: z.number().int().positive(),
  actor: GithubIdentity,
  environment: z.string().min(1).nullable(),
});
export type WorkflowIdentity = z.infer<typeof WorkflowIdentity>;

/**
 * A durable, service-observed record that the SINGLE allowlisted pinned workflow
 * requested THIS exact report for THIS exact envelope, from THIS exact workflow ref,
 * run, and attempt. It is the ordering proof a sign-off attestation binds to: a
 * report can pre-exist from an earlier idempotent analysis, so a real approval must
 * still be preceded by the current workflow attempt's own request observation.
 *
 * `requestId` is content-bound over the identity fields (excluding the volatile
 * `observedAt`), so an exact retry recomputes the same id and is idempotent, while a
 * neighbouring report/run/attempt yields a distinct id and never collides.
 */
export const ReleaseReportRequestObservation = z.object({
  requestVersion: z.literal("1"),
  requestId: z.string().regex(/^rrq_[0-9a-f]{64}$/),
  reportId: z.string().min(1),
  envelope: ReleaseReportSubject,
  workflowRef: z.string().min(1),
  runId: z.string().regex(/^\d+$/),
  runAttempt: z.number().int().positive(),
  /** Service-observed request time (our clock). NOT a provider field. */
  observedAt: z.string().datetime(),
});
export type ReleaseReportRequestObservation = z.infer<typeof ReleaseReportRequestObservation>;
export type ReleaseReportRequestObservationContent = Omit<
  ReleaseReportRequestObservation,
  "requestId" | "observedAt"
>;

export function computeReportRequestId(content: ReleaseReportRequestObservationContent): string {
  return digest("rrq", content);
}

/**
 * How the service verified a protected-Environment approval. GitHub establishes the
 * reviewer, state, and Environment; it supplies NO review timestamp, so provenance
 * records the verification source and the run attempt the approval was read at —
 * never a fabricated provider time.
 */
export const ApprovalVerificationProvenance = z.object({
  source: z.literal("github-actions-approval-history"),
  approvalState: z.literal("approved"),
  runAttempt: z.number().int().positive(),
});
export type ApprovalVerificationProvenance = z.infer<typeof ApprovalVerificationProvenance>;

/**
 * Historical attestation shape (schema v1). It carried a `reviewedAt` that was
 * mapped from a GitHub field the provider does not actually expose. Retained solely
 * so historical rows remain audit-readable; it is structurally INELIGIBLE for new
 * terminal authorization under the current contract.
 */
export const ReleaseApprovalAttestationV1 = z.object({
  attestationVersion: z.literal("1"),
  attestationId: z.string().regex(/^ra_[0-9a-f]{64}$/),
  reportId: z.string().min(1),
  envelope: ReleaseReportSubject,
  approvalEnvironment: z.string().min(1),
  workflow: WorkflowIdentity,
  rationale: z.string().trim().min(1).max(4000),
  responsibilityAccepted: z.literal(true),
  responsibilityAccepter: GithubIdentity,
  reviewer: GithubIdentity,
  reviewedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type ReleaseApprovalAttestationV1 = z.infer<typeof ReleaseApprovalAttestationV1>;

/**
 * The active attestation (schema v2). It binds the exact report, envelope, and
 * pinned workflow identity to the durable prior report-request observation, records
 * the actual GitHub reviewer, and stamps an HONEST service-owned approval
 * verification timestamp plus verification provenance. It never claims a
 * GitHub-supplied review time.
 */
export const ReleaseApprovalAttestation = z.object({
  attestationVersion: z.literal("2"),
  attestationId: z.string().regex(/^ra_[0-9a-f]{64}$/),
  reportId: z.string().min(1),
  envelope: ReleaseReportSubject,
  approvalEnvironment: z.string().min(1),
  workflow: WorkflowIdentity,
  /** The durable report-request observation this approval is ordered behind. */
  requestObservationId: z.string().regex(/^rrq_[0-9a-f]{64}$/),
  rationale: z.string().trim().min(1).max(4000),
  responsibilityAccepted: z.literal(true),
  responsibilityAccepter: GithubIdentity,
  reviewer: GithubIdentity,
  /** Service-owned time at which the GitHub approval was verified. NOT GitHub's. */
  approvalVerifiedAt: z.string().datetime(),
  verificationProvenance: ApprovalVerificationProvenance,
  createdAt: z.string().datetime(),
});
export type ReleaseApprovalAttestation = z.infer<typeof ReleaseApprovalAttestation>;
export type ReleaseApprovalAttestationContent = Omit<
  ReleaseApprovalAttestation,
  "attestationId" | "approvalVerifiedAt" | "createdAt"
>;

/**
 * The stored-attestation read boundary: raw jsonb may be either historical v1 or
 * active v2. Terminal authorization narrows on `attestationVersion` and refuses v1.
 */
export const StoredReleaseApprovalAttestation = z.discriminatedUnion("attestationVersion", [
  ReleaseApprovalAttestationV1,
  ReleaseApprovalAttestation,
]);
export type StoredReleaseApprovalAttestation = z.infer<typeof StoredReleaseApprovalAttestation>;

export const ReleaseShadowAuthorization = z.object({
  authorizationVersion: z.literal("1"),
  authorizationId: z.string().regex(/^auth_[0-9a-f]{64}$/),
  reportId: z.string().min(1),
  envelope: ReleaseReportSubject,
  outcome: z.enum(["ship", "sign-off-required"]),
  attestationId: z
    .string()
    .regex(/^ra_[0-9a-f]{64}$/)
    .nullable(),
  workflow: WorkflowIdentity,
  shadowOnly: z.literal(true),
  authorizedAt: z.string().datetime(),
});
export type ReleaseShadowAuthorization = z.infer<typeof ReleaseShadowAuthorization>;
export type ReleaseShadowAuthorizationContent = Omit<
  ReleaseShadowAuthorization,
  "authorizationId" | "authorizedAt"
>;

export const CreateAttestationInput = z.object({
  rationale: z.string().trim().min(1).max(4000),
  responsibilityAccepted: z.literal(true),
  responsibilityAccepter: GithubIdentity,
});
export type CreateAttestationInput = z.infer<typeof CreateAttestationInput>;

export const CreateAuthorizationInput = z.object({
  envelope: ReleaseReportSubject,
  attestationId: z
    .string()
    .regex(/^ra_[0-9a-f]{64}$/)
    .nullable()
    .optional(),
});
export type CreateAuthorizationInput = z.infer<typeof CreateAuthorizationInput>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function digest(prefix: string, content: unknown): string {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(canonicalize(content)))
    .digest("hex")}`;
}

export function computeAttestationId(content: ReleaseApprovalAttestationContent): string {
  return digest("ra", content);
}

export function computeAuthorizationId(content: ReleaseShadowAuthorizationContent): string {
  return digest("auth", content);
}

export function sameGithubIdentity(left: GithubIdentity, right: GithubIdentity): boolean {
  return left.id === right.id && left.login.toLowerCase() === right.login.toLowerCase();
}
