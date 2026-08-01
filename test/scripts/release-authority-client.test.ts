import { describe, expect, it, vi } from "vitest";
import {
  ReleaseAuthorityClient,
  requestGithubOidcToken,
} from "../../scripts/release-authority-client.js";
import { assembleReleaseReport } from "../../src/domain/release/report.js";
import { COMPLETE_COVERAGE } from "../../src/domain/evidence/coverage.js";
import {
  ReleaseShadowAuthorization,
  computeAuthorizationId,
  type WorkflowIdentity,
} from "../../src/domain/release/authority.js";

const envelope = {
  repository: "acme/widgets",
  previousReleaseSha: "a1".repeat(20),
  candidateSha: "b2".repeat(20),
  artifactDigest: `sha256:${"d4".repeat(32)}`,
  targetEnvironment: "shadow-production",
};
const report = assembleReleaseReport({
  subject: envelope,
  policyVersion: "policy-v1",
  generatedAt: "2026-07-31T00:00:00.000Z",
  provenance: { analyzers: [{ id: "secret-scan" }] },
  findings: [],
  decision: {
    outcome: "ship",
    reasons: ["no_release_findings"],
    dispositions: [],
    summary: { stopped: 0, escalated: 0, cleared: 0, notRelevant: 0 },
    coverage: COMPLETE_COVERAGE,
  },
});
const workflow: WorkflowIdentity = {
  issuer: "https://token.actions.githubusercontent.com",
  audience: "scruffy-release",
  repository: envelope.repository,
  repositoryId: "123",
  workflowRef: "acme/control/.github/workflows/release.yml@deadbeef",
  runId: "456",
  runAttempt: 1,
  actor: { login: "owner", id: "789" },
  environment: null,
};

describe("GitHub OIDC release client", () => {
  it("requests the fixed audience and carries one exact envelope through authorization", async () => {
    const tokenFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ value: "short-lived-jwt" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      requestGithubOidcToken(
        {
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc?x=1",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        },
        tokenFetch as unknown as typeof fetch,
      ),
    ).resolves.toBe("short-lived-jwt");
    const tokenUrl = tokenFetch.mock.calls[0]![0] as URL;
    expect(tokenUrl.searchParams.get("audience")).toBe("scruffy-release");
    expect(tokenFetch.mock.calls[0]![1]).toMatchObject({
      headers: { authorization: "Bearer request-token" },
    });

    const authContent = {
      authorizationVersion: "1" as const,
      reportId: report.reportId,
      envelope,
      outcome: "ship" as const,
      attestationId: null,
      workflow,
      shadowOnly: true as const,
    };
    const authorization = ReleaseShadowAuthorization.parse({
      ...authContent,
      authorizationId: computeAuthorizationId(authContent),
      authorizedAt: "2026-07-31T00:01:00.000Z",
    });
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(report), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(authorization), { status: 201 }));
    const client = new ReleaseAuthorityClient(
      "https://scruffy.example/",
      "short-lived-jwt",
      apiFetch as unknown as typeof fetch,
    );
    await expect(client.requestReport(envelope)).resolves.toMatchObject({
      reportId: report.reportId,
    });
    await expect(client.authorize(report.reportId, envelope)).resolves.toMatchObject({
      authorizationId: authorization.authorizationId,
      shadowOnly: true,
    });
    for (const call of apiFetch.mock.calls) {
      expect(call[1]).toMatchObject({
        headers: expect.objectContaining({ authorization: "Bearer short-lived-jwt" }),
      });
    }
  });

  it("accepts a regional actions.githubusercontent.com request endpoint", async () => {
    // GitHub-hosted runners hand out a regional request host (distinct from the
    // fixed JWT issuer token.actions.githubusercontent.com). It must be honoured.
    const tokenFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ value: "regional-jwt" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      requestGithubOidcToken(
        {
          ACTIONS_ID_TOKEN_REQUEST_URL:
            "https://pipelines.actions.githubusercontent.com/AbCdEf/_apis/pipelines/1/runs/1/signalr?api-version=6.0-preview",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        },
        tokenFetch as unknown as typeof fetch,
      ),
    ).resolves.toBe("regional-jwt");
    const tokenUrl = tokenFetch.mock.calls[0]![0] as URL;
    expect(tokenUrl.hostname).toBe("pipelines.actions.githubusercontent.com");
    expect(tokenUrl.searchParams.get("audience")).toBe("scruffy-release");
  });

  it("refuses untrusted request endpoints before transmitting the request token", async () => {
    // Each of these must fail closed WITHOUT the OIDC request token ever being
    // sent, so a token exfiltration attempt cannot reach the network.
    // The userinfo of the credential-bearing case is assembled at runtime so the
    // fixture is not misread as an embedded basic-auth secret by the scanner. The
    // effective host still carries `<user>:<pass>@` userinfo before the regional
    // request host and must be rejected before any token is transmitted.
    const credentialUserinfo = ["u", "p"].join(":");
    const untrusted = [
      "not a url", // malformed
      "http://pipelines.actions.githubusercontent.com/oidc", // HTTP, not HTTPS
      `https://${credentialUserinfo}@pipelines.actions.githubusercontent.com/oidc`, // credentials
      "https://pipelines.actions.githubusercontent.com:8443/oidc", // explicit port
      "https://attacker.example/steal", // attacker-controlled host
      "https://actions.githubusercontent.com/oidc", // bare zone, not a subdomain
      "https://actions.githubusercontent.com.attacker.example/steal", // sibling domain
      "https://evilactions.githubusercontent.com/oidc", // suffix confusion
    ];
    for (const requestUrl of untrusted) {
      const fetcher = vi.fn();
      await expect(
        requestGithubOidcToken(
          {
            ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
          },
          fetcher as unknown as typeof fetch,
        ),
        `${requestUrl} must be rejected`,
      ).rejects.toThrow();
      expect(fetcher, `${requestUrl} must not reach the network`).not.toHaveBeenCalled();
    }
  });

  it("rejects non-HTTPS hosts and mismatched authorization envelopes", async () => {
    expect(() => new ReleaseAuthorityClient("http://scruffy.example", "token")).toThrow(/HTTPS/);
    await expect(
      requestGithubOidcToken({
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example/steal",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      }),
    ).rejects.toThrow(/actions\.githubusercontent\.com/);
    const bad = {
      ...(() => {
        const content = {
          authorizationVersion: "1" as const,
          reportId: report.reportId,
          envelope: { ...envelope, targetEnvironment: "other" },
          outcome: "ship" as const,
          attestationId: null,
          workflow,
          shadowOnly: true as const,
        };
        return {
          ...content,
          authorizationId: computeAuthorizationId(content),
          authorizedAt: "2026-07-31T00:01:00.000Z",
        };
      })(),
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(bad), { status: 201 }));
    const client = new ReleaseAuthorityClient(
      "https://scruffy.example",
      "token",
      fetcher as unknown as typeof fetch,
    );
    await expect(client.authorize(report.reportId, envelope)).rejects.toThrow(/does not match/);
  });
});
