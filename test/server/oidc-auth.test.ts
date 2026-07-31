import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  GithubActionsOidcVerifier,
  githubActionsOidcTrustFromEnv,
  type GithubActionsOidcTrust,
} from "../../src/providers/identity/github-actions-oidc.js";

const TRUST: GithubActionsOidcTrust = {
  audience: "scruffy-release",
  repository: "acme/widgets",
  repositoryId: "123",
  workflowRef: "acme/control/.github/workflows/release.yml@0123456789abcdef",
  targetEnvironment: "shadow-production",
  approvalEnvironment: "scruffy-production-signoff",
};
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
});

async function token(overrides: Record<string, unknown> = {}, key = privateKey, kid = "key-1") {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: "repo:acme/widgets:environment:scruffy-production-signoff",
    repository: TRUST.repository,
    repository_id: TRUST.repositoryId,
    job_workflow_ref: TRUST.workflowRef,
    run_id: "456",
    run_attempt: "2",
    actor: "release-owner",
    actor_id: "789",
    environment: TRUST.approvalEnvironment,
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer((overrides.iss as string | undefined) ?? GITHUB_ACTIONS_OIDC_ISSUER)
    .setAudience((overrides.aud as string | undefined) ?? TRUST.audience)
    .setIssuedAt((overrides.iat as number | undefined) ?? now)
    .setExpirationTime((overrides.exp as number | undefined) ?? now + 300)
    .sign(key);
}

describe("GitHub Actions OIDC trust pressure", () => {
  it("requires service-owned workflow trust to be pinned to a full commit SHA", () => {
    const base = {
      SCRUFFY_RELEASE_OIDC_REPOSITORY: "acme/widgets",
      SCRUFFY_RELEASE_OIDC_REPOSITORY_ID: "123",
      SCRUFFY_RELEASE_TARGET_ENVIRONMENT: "shadow-production",
      SCRUFFY_RELEASE_APPROVAL_ENVIRONMENT: "scruffy-production-signoff",
    };
    expect(() =>
      githubActionsOidcTrustFromEnv({
        ...base,
        SCRUFFY_RELEASE_OIDC_WORKFLOW_REF:
          "acme/control/.github/workflows/release.yml@refs/heads/main",
      }),
    ).toThrow(/not pinned/);
    expect(
      githubActionsOidcTrustFromEnv({
        ...base,
        SCRUFFY_RELEASE_OIDC_WORKFLOW_REF: `acme/control/.github/workflows/release.yml@${"a".repeat(40)}`,
      }),
    ).toMatchObject({ repository: "acme/widgets", repositoryId: "123" });
  });

  it("accepts only the complete allowlisted workflow identity", async () => {
    const verifier = new GithubActionsOidcVerifier(TRUST, createLocalJWKSet({ keys: [jwk] }));
    await expect(
      verifier.verify(await token(), { requireEnvironment: TRUST.approvalEnvironment }),
    ).resolves.toMatchObject({
      repository: TRUST.repository,
      repositoryId: TRUST.repositoryId,
      workflowRef: TRUST.workflowRef,
      runId: "456",
      runAttempt: 2,
      actor: { login: "release-owner", id: "789" },
    });
  });

  it.each([
    ["repository", "evil/widgets"],
    ["repository_id", "999"],
    ["job_workflow_ref", "evil/workflow@deadbeef"],
    ["environment", "unprotected"],
    ["actor", ""],
    ["actor_id", "not-numeric"],
    ["run_id", "not-numeric"],
  ])("rejects a mutated %s claim", async (claim, value) => {
    const verifier = new GithubActionsOidcVerifier(TRUST, createLocalJWKSet({ keys: [jwk] }));
    await expect(
      verifier.verify(await token({ [claim]: value }), {
        requireEnvironment: TRUST.approvalEnvironment,
      }),
    ).rejects.toThrow(/OIDC/);
  });

  it("rejects wrong audience, issuer, expiry, and unknown signing key", async () => {
    const verifier = new GithubActionsOidcVerifier(TRUST, createLocalJWKSet({ keys: [jwk] }));
    await expect(verifier.verify(await token({ aud: "other" }))).rejects.toThrow(/OIDC/);
    await expect(verifier.verify(await token({ iss: "https://issuer.invalid" }))).rejects.toThrow(
      /OIDC/,
    );
    await expect(verifier.verify(await token({ exp: 1 }))).rejects.toThrow(/OIDC/);
    await expect(verifier.verify(await token({}, privateKey, "unknown"))).rejects.toThrow(/OIDC/);
  });

  it("accepts a safely rotated known signing key", async () => {
    const rotated = await generateKeyPair("RS256");
    const rotatedJwk = {
      ...(await exportJWK(rotated.publicKey)),
      kid: "key-2",
      alg: "RS256",
      use: "sig",
    };
    const verifier = new GithubActionsOidcVerifier(
      TRUST,
      createLocalJWKSet({ keys: [jwk, rotatedJwk] }),
    );
    await expect(
      verifier.verify(await token({}, rotated.privateKey, "key-2")),
    ).resolves.toMatchObject({
      runId: "456",
    });
  });
});
