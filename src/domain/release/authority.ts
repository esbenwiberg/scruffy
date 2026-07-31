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

export const ReleaseApprovalAttestation = z.object({
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
export type ReleaseApprovalAttestation = z.infer<typeof ReleaseApprovalAttestation>;
export type ReleaseApprovalAttestationContent = Omit<
  ReleaseApprovalAttestation,
  "attestationId" | "createdAt"
>;

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
