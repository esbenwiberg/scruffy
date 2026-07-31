import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";
import { z } from "zod";
import {
  WorkflowIdentity,
  type WorkflowIdentity as WorkflowIdentityType,
} from "../../domain/release/authority.js";

export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com" as const;
export const DEFAULT_RELEASE_OIDC_AUDIENCE = "scruffy-release";

export interface GithubActionsOidcTrust {
  audience: string;
  repository: string;
  repositoryId: string;
  workflowRef: string;
  targetEnvironment: string;
  approvalEnvironment: string;
}

export function githubActionsOidcTrustFromEnv(
  env: Record<string, string | undefined> = process.env,
): GithubActionsOidcTrust | null {
  const repository = env.SCRUFFY_RELEASE_OIDC_REPOSITORY;
  if (!repository) return null;
  const repositoryId = required(env, "SCRUFFY_RELEASE_OIDC_REPOSITORY_ID");
  const workflowRef = required(env, "SCRUFFY_RELEASE_OIDC_WORKFLOW_REF");
  const targetEnvironment = required(env, "SCRUFFY_RELEASE_TARGET_ENVIRONMENT");
  const approvalEnvironment = required(env, "SCRUFFY_RELEASE_APPROVAL_ENVIRONMENT");
  if (!/^\d+$/.test(repositoryId)) {
    throw new Error("SCRUFFY_RELEASE_OIDC_REPOSITORY_ID must be numeric");
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[^/]+\/[^/]+\/.+\.ya?ml@[0-9a-f]{40}$/.test(workflowRef)
  ) {
    throw new Error(
      "release OIDC repository/workflow configuration is malformed or workflow ref is not pinned to a full commit SHA",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(targetEnvironment)) {
    throw new Error("SCRUFFY_RELEASE_TARGET_ENVIRONMENT is malformed");
  }
  const audience = env.SCRUFFY_RELEASE_OIDC_AUDIENCE ?? DEFAULT_RELEASE_OIDC_AUDIENCE;
  if (!audience.trim()) throw new Error("SCRUFFY_RELEASE_OIDC_AUDIENCE must not be empty");
  return {
    audience,
    repository,
    repositoryId,
    workflowRef,
    targetEnvironment,
    approvalEnvironment,
  };
}

const RequiredClaims = z.object({
  repository: z.string().min(1),
  repository_id: z.string().regex(/^\d+$/),
  job_workflow_ref: z.string().min(1),
  run_id: z.string().regex(/^\d+$/),
  run_attempt: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
  actor: z.string().min(1),
  actor_id: z.string().regex(/^\d+$/),
  environment: z.string().min(1).optional(),
});

export class GithubActionsOidcError extends Error {}

export class GithubActionsOidcVerifier {
  readonly #keys: JWTVerifyGetKey;

  constructor(
    readonly trust: GithubActionsOidcTrust,
    keys: JWTVerifyGetKey = createRemoteJWKSet(
      new URL(`${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`),
      { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 },
    ),
  ) {
    this.#keys = keys;
  }

  async verify(
    token: string,
    options: { requireEnvironment?: string } = {},
  ): Promise<WorkflowIdentityType> {
    try {
      const result = await jwtVerify(token, this.#keys, {
        issuer: GITHUB_ACTIONS_OIDC_ISSUER,
        audience: this.trust.audience,
        clockTolerance: 5,
        requiredClaims: ["exp", "iat", "sub"],
      });
      return this.#claims(result.payload, options.requireEnvironment);
    } catch (error) {
      throw new GithubActionsOidcError(
        `GitHub Actions OIDC verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #claims(payload: JWTPayload, requireEnvironment?: string): WorkflowIdentityType {
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.iat === undefined ||
      payload.exp === undefined ||
      payload.iat > now + 5 ||
      payload.exp - payload.iat > 10 * 60
    ) {
      throw new GithubActionsOidcError("GitHub Actions OIDC token lifetime is invalid");
    }
    const claims = RequiredClaims.parse(payload);
    if (
      claims.repository !== this.trust.repository ||
      claims.repository_id !== this.trust.repositoryId ||
      claims.job_workflow_ref !== this.trust.workflowRef
    ) {
      throw new GithubActionsOidcError("GitHub Actions OIDC identity is not allowlisted");
    }
    if (requireEnvironment !== undefined && claims.environment !== requireEnvironment) {
      throw new GithubActionsOidcError(
        "GitHub Actions OIDC Environment does not match the protected gate",
      );
    }
    return WorkflowIdentity.parse({
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      audience: this.trust.audience,
      repository: claims.repository,
      repositoryId: claims.repository_id,
      workflowRef: claims.job_workflow_ref,
      runId: claims.run_id,
      runAttempt: Number(claims.run_attempt),
      actor: { login: claims.actor, id: claims.actor_id },
      environment: claims.environment ?? null,
    });
  }
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set when hosted release OIDC is enabled`);
  return value;
}
