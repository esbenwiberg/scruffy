import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Structural safety facts for the service-controlled reusable release-authority
 * workflow. These parse the YAML (not just grep) and assert the trust-boundary
 * invariants that must hold BEFORE any caller pins the workflow by full SHA.
 * They are not a substitute for the later live GitHub run.
 */

const ENDPOINT = "https://scruffy-shadow.gentlebeach-f5d64525.swedencentral.azurecontainerapps.io";
const AUDIENCE = "scruffy-release";
const APPROVAL_ENVIRONMENT = "scruffy-production-signoff";
const REVIEW_JOB = "review-and-ship-authorize";
const EXCEPTION_JOB = "attest-and-authorize-exception";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/release-authority-shadow.yml", import.meta.url),
);
const raw = readFileSync(workflowPath, "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = parse(raw) as any;
// The YAML 1.2 core schema keeps `on` a string key; guard against a 1.1-style
// boolean coercion just in case a different parser is ever swapped in.
const on = doc.on ?? doc[true as unknown as string] ?? doc["on"];

function job(name: string): Record<string, unknown> {
  const j = doc.jobs?.[name];
  expect(j, `job ${name} must exist`).toBeTruthy();
  return j as Record<string, unknown>;
}

function runScript(jobName: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const steps = (job(jobName).steps as any[]) ?? [];
  const scripts = steps.map((s) => s?.run).filter((r): r is string => typeof r === "string");
  expect(scripts.length, `job ${jobName} must have at least one run step`).toBeGreaterThan(0);
  return scripts.join("\n");
}

function stepEnv(jobName: string): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const steps = (job(jobName).steps as any[]) ?? [];
  return Object.assign({}, ...steps.map((s) => s?.env ?? {})) as Record<string, unknown>;
}

const EXPECTED_INPUTS = [
  "candidate_sha",
  "previous_release_sha",
  "artifact_digest",
  "target_environment",
  "exception_rationale",
  "responsibility_accepted",
].sort();

const LEAST_PRIVILEGE = { contents: "read", "id-token": "write" };

describe("release-authority-shadow reusable workflow", () => {
  it("pins the reusable OIDC trust boundary", () => {
    // Reusable via workflow_call, never directly dispatched or pushed.
    expect(Object.keys(on)).toEqual(["workflow_call"]);
    expect(on.workflow_call).toBeTruthy();
    expect(on.workflow_dispatch).toBeUndefined();
    expect(on.push).toBeUndefined();
    expect(on.pull_request).toBeUndefined();
    expect(on.schedule).toBeUndefined();

    // Caller inputs are exactly the one-envelope set — no endpoint, audience,
    // approval Environment, repository, actor, reviewer, workflow ref,
    // authorization result, or policy input.
    const inputs = on.workflow_call.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(EXPECTED_INPUTS);
    for (const forbidden of [
      "endpoint",
      "audience",
      "reviewer",
      "repository",
      "workflow_ref",
      "workflowref",
      "approval",
      "authorization",
      "result",
      "policy",
      "actor",
    ]) {
      for (const name of Object.keys(inputs)) {
        expect(name.toLowerCase()).not.toContain(forbidden);
      }
    }

    // Least-privilege permissions at workflow level and every job level: only
    // contents:read and id-token:write, no write authority beyond id-token.
    expect(doc.permissions).toEqual(LEAST_PRIVILEGE);
    for (const jobName of [REVIEW_JOB, EXCEPTION_JOB]) {
      expect(job(jobName).permissions).toEqual(LEAST_PRIVILEGE);
    }

    // The Scruffy endpoint and OIDC audience are fixed literals, not inputs.
    for (const jobName of [REVIEW_JOB, EXCEPTION_JOB]) {
      const env = stepEnv(jobName);
      expect(env.SCRUFFY_ENDPOINT).toBe(ENDPOINT);
      expect(env.SCRUFFY_AUDIENCE).toBe(AUDIENCE);
      // literals, not caller-controlled expressions
      expect(String(env.SCRUFFY_ENDPOINT)).not.toContain("${{");
      expect(String(env.SCRUFFY_AUDIENCE)).not.toContain("${{");
      expect(String(env.SCRUFFY_ENDPOINT)).not.toContain("inputs.");
    }

    // The runner-provided token-request endpoint is validated as a subdomain of
    // the Actions service zone (NOT gated on the JWT issuer), with the fixed
    // audience appended. Both jobs must apply the same bounded validation before
    // any request token is transmitted.
    for (const jobName of [REVIEW_JOB, EXCEPTION_JOB]) {
      const script = runScript(jobName);
      // The request host is bounded to a genuine subdomain of the Actions zone.
      expect(script).toContain("assert_trusted_oidc_request_url");
      expect(script).toContain("*.actions.githubusercontent.com)");
      expect(script).toContain(
        "OIDC token request host is not a subdomain of actions.githubusercontent.com",
      );
      // HTTP, embedded credentials, and explicit ports are all refused.
      expect(script).toContain("OIDC token request URL must use HTTPS");
      expect(script).toContain("OIDC token request URL must not contain credentials");
      expect(script).toContain("OIDC token request URL must not specify a port");
      // The request endpoint is NOT confused with the fixed JWT issuer: the old
      // issuer-equality gate on the request URL must be gone.
      expect(script).not.toContain("https://token.actions.githubusercontent.com/*)");
      expect(script).not.toContain("OIDC token endpoint is not the expected GitHub issuer");
      // Validation of the request URL precedes its use to fetch a token.
      const validation = script.indexOf(
        'assert_trusted_oidc_request_url "$ACTIONS_ID_TOKEN_REQUEST_URL"',
      );
      const tokenFetch = script.indexOf("audience=${SCRUFFY_AUDIENCE}");
      expect(validation).toBeGreaterThanOrEqual(0);
      expect(tokenFetch).toBeGreaterThan(validation);
    }
  });

  it("keeps report request outside an Environment and routes every outcome", () => {
    const review = job(REVIEW_JOB);
    // The report-request job carries NO GitHub Environment claim.
    expect(review.environment).toBeUndefined();

    const script = runScript(REVIEW_JOB);

    // Complete-envelope validation precedes OIDC token acquisition.
    const firstValidation = script.indexOf("candidate_sha must be a full");
    const shaValidation = script.indexOf("=~ ^[0-9a-f]{40}$");
    const tokenAcquisition = script.indexOf("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(firstValidation).toBeGreaterThanOrEqual(0);
    expect(shaValidation).toBeGreaterThanOrEqual(0);
    expect(tokenAcquisition).toBeGreaterThan(shaValidation);
    expect(tokenAcquisition).toBeGreaterThan(firstValidation);
    // The full envelope is validated: candidate, previous, digest, target, repo.
    expect(script).toContain("artifact_digest must be sha256:");
    expect(script).toContain("previous_release_sha must be empty or a full");
    expect(script).toContain("target_environment is malformed");
    expect(script).toContain("repository is malformed");

    // The report is requested for the exact envelope and its subject re-checked.
    expect(script).toContain("/v1/release-reports");
    expect(script).toContain(".subject == $expected[0]");
    expect(script).toContain("report subject does not match the requested envelope");

    // Every outcome path is explicit.
    expect(script).toMatch(/case\s+"\$outcome"\s+in/);
    // ship -> terminal authorization with null attestation, shadowOnly required
    expect(script).toContain("/authorizations");
    expect(script).toContain(".attestationId == null and .shadowOnly == true");
    // sign-off-required routes to the protected job (no authorization here)
    expect(script).toContain("sign-off-required)");
    expect(script).toContain("routing to the protected sign-off Environment");
    // stop / indeterminate / unknown all fail without authorizing
    expect(script).toContain("stop|indeterminate)");
    expect(script).toContain("never authorizes");
    expect(script).toContain("unknown report outcome");
    // malformed / mismatched responses fail
    expect(script).toContain("report response is missing an outcome");
    expect(script).toContain("report id is malformed");

    // The protected job only runs for an exact sign-off-required outcome.
    expect(job(EXCEPTION_JOB).if).toBe(
      `needs.${REVIEW_JOB}.outputs.outcome == 'sign-off-required'`,
    );
  });

  it("attests and authorizes sign-off in the same protected job", () => {
    const exception = job(EXCEPTION_JOB);

    // Fixed protected Environment and a dependency on the report job.
    expect(exception.environment).toBe(APPROVAL_ENVIRONMENT);
    const needs = Array.isArray(exception.needs) ? exception.needs : [exception.needs];
    expect(needs).toContain(REVIEW_JOB);
    expect(exception.if).toBe(`needs.${REVIEW_JOB}.outputs.outcome == 'sign-off-required'`);

    const script = runScript(EXCEPTION_JOB);

    // Sign-off requires non-empty rationale and explicit responsibility acceptance.
    expect(script).toContain("exception_rationale must be non-empty");
    expect(script).toContain("responsibility_accepted must be true");
    expect(script).toContain('[[ "$RESPONSIBILITY_ACCEPTED" == "true" ]]');

    // The responsibility accepter is the runner actor identity, never caller text.
    expect(script).toContain("$GITHUB_ACTOR");
    expect(script).toContain("$GITHUB_ACTOR_ID");
    expect(script).toContain("responsibilityAccepter: {login: $login, id: $id}");
    // There is no reviewer input anywhere for the accepter to come from.
    expect(Object.keys(on.workflow_call.inputs)).not.toContain("reviewer");

    // Attestation and terminal authorization both happen in this ONE job/step.
    const env = stepEnv(EXCEPTION_JOB);
    expect(env.SCRUFFY_ENDPOINT).toBe(ENDPOINT);
    expect(script).toContain("/attestations");
    expect(script).toContain("/authorizations");
    // The token is acquired inside this protected job (after the Environment gate).
    expect(script).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");

    // Attestation binds the exact report and envelope.
    expect(script).toContain(".reportId == $reportId and .envelope == $expected[0]");
    expect(script).toContain("attestation id is malformed");

    // Success requires exact report, envelope, attestation id, outcome, shadowOnly.
    expect(script).toContain(
      '.reportId == $reportId and .envelope == $expected[0] and .outcome == "sign-off-required" and .attestationId == $attestationId and .shadowOnly == true',
    );
  });

  it("exposes no publication authority or sensitive workflow output", () => {
    // No write authority beyond id-token, at workflow or job scope.
    const forbiddenPerms = [
      "actions",
      "deployments",
      "checks",
      "issues",
      "pull-requests",
      "packages",
      "statuses",
      "contents-write",
    ];
    for (const scope of [
      doc.permissions,
      job(REVIEW_JOB).permissions,
      job(EXCEPTION_JOB).permissions,
    ]) {
      expect(scope).toEqual(LEAST_PRIVILEGE);
      for (const perm of forbiddenPerms) {
        expect(Object.prototype.hasOwnProperty.call(scope, perm)).toBe(false);
      }
      // contents must be read, never write.
      expect((scope as Record<string, string>).contents).toBe("read");
    }

    // No publication / deployment / SCM command exists anywhere.
    for (const pattern of [
      /\bgit\s+push\b/,
      /\bgit\s+commit\b/,
      /\bgit\s+tag\b/,
      /\bgh\s+release\b/,
      /\bgh\s+pr\b/,
      /\bgh\s+issue\b/,
      /\bgh\s+api\b/,
      /\bnpm\s+publish\b/,
      /\bdocker\s+push\b/,
      /\bdocker\s+build\b/,
      /\bkubectl\b/,
      /\bhelm\b/,
      /az\s+containerapp\s+update/,
      /az\s+deployment/,
    ]) {
      expect(raw, `must not contain ${pattern}`).not.toMatch(pattern);
    }

    for (const jobName of [REVIEW_JOB, EXCEPTION_JOB]) {
      const script = runScript(jobName);
      // Hardened shell: strict mode, restrictive umask, cleanup trap, no tracing.
      expect(script).toContain("set -Eeuo pipefail");
      expect(script).toContain("umask 077");
      expect(script).toContain("trap 'rm -rf \"$workdir\"' EXIT");
      expect(script).not.toContain("set -x");
      expect(script).not.toContain("set -o xtrace");
      // Bounded curl with redirect refusal and connect/overall timeouts.
      expect(script).toContain("--max-redirs 0");
      expect(script).toContain("--connect-timeout 10");
      expect(script).toContain("--max-time 30");
      expect(script).toContain("--proto '=https'");
      // Auth header travels through a permission-restricted config file, never
      // an inline curl argument that would surface in process listings/logs.
      expect(script).toContain("--config");
      expect(script).not.toMatch(/--header\s+"Authorization/);
      expect(script).not.toMatch(/-H\s+"Authorization/);
      // The JWT is never echoed.
      expect(script).not.toMatch(/echo\s+["']?\$\{?jwt/i);
    }

    // Reusable outputs expose only bounded evidence — never a JWT or full report.
    const outputs = on.workflow_call.outputs ?? {};
    expect(Object.keys(outputs).sort()).toEqual(
      ["authorization_id", "outcome", "report_id", "signoff_used"].sort(),
    );
    for (const [name, spec] of Object.entries(outputs)) {
      const value = String((spec as Record<string, unknown>).value ?? "");
      for (const leak of ["jwt", "token", ".value", "report_file", "auth.cfg", "Bearer"]) {
        expect(value.toLowerCase(), `output ${name} must not leak ${leak}`).not.toContain(
          leak.toLowerCase(),
        );
      }
    }
  });

  it("documents the fake-backend proof as partial", () => {
    const cd = readFileSync(
      fileURLToPath(new URL("../../docs/product/cd-release-gate.md", import.meta.url)),
      "utf8",
    );
    const azure = readFileSync(
      fileURLToPath(new URL("../../docs/product/azure-shadow-deployment.md", import.meta.url)),
      "utf8",
    );

    for (const docText of [cd, azure]) {
      // Reusable workflow now available, pinned by full SHA, with a caller example.
      expect(docText).toContain(".github/workflows/release-authority-shadow.yml");
      expect(docText).toContain(
        "uses: esbenwiberg/scruffy/.github/workflows/release-authority-shadow.yml@",
      );
      // Immediate proof is fake/no-model and cannot satisfy the real-model criterion.
      expect(docText.toLowerCase()).toContain("fake");
      expect(docText.toLowerCase()).toMatch(/no[- ]model/);
      expect(docText.toLowerCase()).toContain("real-model");
      // Foundry deferred until a separately provisioned resource exists.
      expect(docText).toContain("Foundry");
      expect(docText.toLowerCase()).toContain("deferred until a separately provisioned");
      // Endpoint is service-controlled and must never become a caller input.
      expect(docText.toLowerCase()).toContain("never become a caller input");
      // External caller/Azure/Environment/live-run steps stay separate human gates.
      expect(docText.toLowerCase()).toContain("human gate");
      expect(docText.toLowerCase()).toContain("allowlist");
      expect(docText.toLowerCase()).toContain("administrator-bypass");
    }
  });
});
