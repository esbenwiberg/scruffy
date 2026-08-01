import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  ReleaseApprovalAttestation,
  ReleaseShadowAuthorization,
} from "../src/domain/release/authority.js";
import { ReleaseRiskReport, ReleaseReportSubject } from "../src/domain/release/report.js";
import { DEFAULT_RELEASE_OIDC_AUDIENCE } from "../src/providers/identity/github-actions-oidc.js";

export type FetchLike = typeof fetch;

// The GitHub-hosted Actions service hands each runner a *regional* token-request
// endpoint under `*.actions.githubusercontent.com` (for example
// `pipelines.actions.githubusercontent.com`). That request host is NOT the JWT
// issuer: the issued token's `iss` is fixed to
// `https://token.actions.githubusercontent.com`, which the hosted verifier in
// `src/providers/identity/github-actions-oidc.ts` checks independently. Here we
// only trust the runner-provided *request* URL, so we bound it to an HTTPS host
// that is a genuine subdomain of `.actions.githubusercontent.com` — with no
// credentials, no explicit port, and no malformed/sibling/suffix-confusion host —
// before the OIDC request token is ever sent, so it can never be exfiltrated.
const OIDC_REQUEST_HOST_SUFFIX = ".actions.githubusercontent.com";

function isTrustedOidcRequestHostname(hostname: string): boolean {
  if (!hostname.endsWith(OIDC_REQUEST_HOST_SUFFIX)) return false;
  const subdomain = hostname.slice(0, -OIDC_REQUEST_HOST_SUFFIX.length);
  // Require at least one non-empty DNS label before the trusted zone. This
  // rejects the bare `actions.githubusercontent.com`, a leading empty label, and
  // suffix-confusion hosts such as `evilactions.githubusercontent.com`.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(subdomain);
}

export function assertTrustedOidcRequestUrl(requestUrl: string): URL {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new Error("ACTIONS_ID_TOKEN_REQUEST_URL is not a valid URL");
  }
  // Parse the raw authority so an explicit port (including the default `:443`)
  // or embedded credentials are rejected even where WHATWG URL would normalise
  // them away.
  const authority = requestUrl.slice(requestUrl.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    authority.includes("@") ||
    authority.includes(":") ||
    !isTrustedOidcRequestHostname(url.hostname)
  ) {
    throw new Error(
      "GitHub OIDC token request URL must be an HTTPS subdomain of actions.githubusercontent.com with no credentials or explicit port",
    );
  }
  return url;
}

export async function requestGithubOidcToken(
  env: Record<string, string | undefined> = process.env,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const requestUrl = required(env, "ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = required(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const url = assertTrustedOidcRequestUrl(requestUrl);
  url.searchParams.set(
    "audience",
    env.SCRUFFY_RELEASE_OIDC_AUDIENCE ?? DEFAULT_RELEASE_OIDC_AUDIENCE,
  );
  const response = await fetcher(url, {
    redirect: "error",
    headers: { authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`GitHub OIDC token request failed with HTTP ${response.status}`);
  const parsed = z.object({ value: z.string().min(1) }).parse(await response.json());
  return parsed.value;
}

export class ReleaseAuthorityClient {
  readonly #endpoint: URL;
  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.#endpoint = new URL(endpoint);
    if (this.#endpoint.protocol !== "https:")
      throw new Error("Scruffy release endpoint must use HTTPS");
    if (this.#endpoint.username || this.#endpoint.password) {
      throw new Error("Scruffy release endpoint must not contain credentials");
    }
  }

  async requestReport(envelope: z.input<typeof ReleaseReportSubject>) {
    return ReleaseRiskReport.parse(await this.#json("/v1/release-reports", "POST", envelope));
  }

  async getReport(reportId: string) {
    return ReleaseRiskReport.parse(
      await this.#json(`/v1/release-reports/${encodeURIComponent(reportId)}`, "GET"),
    );
  }

  async attest(
    reportId: string,
    input: {
      rationale: string;
      responsibilityAccepted: true;
      responsibilityAccepter: { login: string; id: string };
    },
  ) {
    return ReleaseApprovalAttestation.parse(
      await this.#json(
        `/v1/release-reports/${encodeURIComponent(reportId)}/attestations`,
        "POST",
        input,
      ),
    );
  }

  async authorize(
    reportId: string,
    envelope: z.input<typeof ReleaseReportSubject>,
    attestationId: string | null = null,
  ) {
    const authorization = ReleaseShadowAuthorization.parse(
      await this.#json(
        `/v1/release-reports/${encodeURIComponent(reportId)}/authorizations`,
        "POST",
        { envelope, attestationId },
      ),
    );
    const expected = ReleaseReportSubject.parse(envelope);
    if (
      authorization.reportId !== reportId ||
      JSON.stringify(authorization.envelope) !== JSON.stringify(expected) ||
      authorization.attestationId !== attestationId ||
      authorization.shadowOnly !== true
    ) {
      throw new Error("Scruffy authorization response does not match the requested envelope");
    }
    return authorization;
  }

  async #json(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const response = await this.fetcher(new URL(path, this.#endpoint), {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const message = z.object({ error: z.string() }).safeParse(payload);
      throw new Error(
        `Scruffy release authority returned HTTP ${response.status}: ${message.success ? message.data.error : "request failed"}`,
      );
    }
    return payload;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const endpoint = required(process.env, "SCRUFFY_RELEASE_ENDPOINT");
  const token = await requestGithubOidcToken();
  const client = new ReleaseAuthorityClient(endpoint, token);
  const repository = required(process.env, "GITHUB_REPOSITORY");

  if (command === "review") {
    const [candidateSha, artifactDigest, targetEnvironment, previousReleaseSha] = args;
    if (!candidateSha || !artifactDigest || !targetEnvironment) usage();
    const report = await client.requestReport({
      repository,
      candidateSha,
      previousReleaseSha: previousReleaseSha ?? null,
      artifactDigest,
      targetEnvironment,
    });
    console.log(JSON.stringify({ reportId: report.reportId, outcome: report.decision.outcome }));
    return;
  }
  if (command === "attest") {
    const [reportId] = args;
    if (!reportId) usage();
    if (required(process.env, "SCRUFFY_RELEASE_RESPONSIBILITY_ACCEPTED") !== "true") {
      throw new Error("SCRUFFY_RELEASE_RESPONSIBILITY_ACCEPTED must be exactly 'true'");
    }
    const attestation = await client.attest(reportId, {
      rationale: required(process.env, "SCRUFFY_RELEASE_RATIONALE"),
      responsibilityAccepted: true,
      responsibilityAccepter: {
        login: required(process.env, "GITHUB_ACTOR"),
        id: required(process.env, "GITHUB_ACTOR_ID"),
      },
    });
    console.log(JSON.stringify({ attestationId: attestation.attestationId }));
    return;
  }
  if (command === "authorize") {
    const [reportId, candidateSha, artifactDigest, targetEnvironment] = args;
    if (!reportId || !candidateSha || !artifactDigest || !targetEnvironment) usage();
    const authorization = await client.authorize(
      reportId,
      {
        repository,
        candidateSha,
        previousReleaseSha: process.env.SCRUFFY_PREVIOUS_RELEASE_SHA ?? null,
        artifactDigest,
        targetEnvironment,
      },
      process.env.SCRUFFY_RELEASE_ATTESTATION_ID ?? null,
    );
    console.log(
      JSON.stringify({ authorizationId: authorization.authorizationId, shadowOnly: true }),
    );
    return;
  }
  usage();
}

function usage(): never {
  throw new Error(
    "usage: release-authority-client <review|attest|authorize> ... (see docs/product/cd-release-gate.md)",
  );
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
