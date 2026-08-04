import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Structural safety facts for the repository-owned workflow-prerequisite routing in
 * the service-controlled reusable release-authority workflow. Like its sibling
 * `release-authority-shadow.test.ts`, these parse the YAML (not just grep) and assert
 * the readiness-routing and information-flow invariants that must hold BEFORE any
 * caller pins the workflow by full SHA. They are not a substitute for a live run.
 *
 * The obvious broken workflow treats EVERY non-green hosted state as a sign-off. The
 * pending and missing/invalid facts below fail that implementation: a pending
 * prerequisite must retry-then-fail-closed and a missing/invalid one must fail closed,
 * and neither may ever reach the protected sign-off Environment.
 */

const REVIEW_JOB = "review-and-ship-authorize";
const EXCEPTION_JOB = "attest-and-authorize-exception";
const APPROVAL_ENVIRONMENT = "scruffy-production-signoff";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/release-authority-shadow.yml", import.meta.url),
);
const raw = readFileSync(workflowPath, "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = parse(raw) as any;
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

function readDoc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../docs/product/${rel}`, import.meta.url)), "utf8");
}

describe("reusable prerequisite routing", () => {
  const review = runScript(REVIEW_JOB);

  it("reusable prerequisite routing", () => {
    // The report request is issued inside a bounded retry loop that always
    // terminates — never an unbounded poll.
    expect(review).toMatch(/max_attempts=\d+/);
    expect(review).toContain("while : ;");
    expect(review).toContain("/v1/release-reports");
    // The loop bounds itself: a maximum attempt count and a capped backoff.
    const maxAttempts = Number(/max_attempts=(\d+)/.exec(review)?.[1]);
    expect(maxAttempts).toBeGreaterThan(0);
    expect(maxAttempts).toBeLessThanOrEqual(20);
    expect(review).toMatch(/backoff_cap=\d+/);
    expect(review).toContain("attempt >= max_attempts");

    // GREEN (200 ship) auto-authorizes with a null attestation and shadow-only.
    expect(review).toMatch(/case\s+"\$outcome"\s+in/);
    expect(review).toContain("/authorizations");
    expect(review).toContain(".attestationId == null and .shadowOnly == true");

    // TERMINAL FAILURE / AUTHORITY CHANGE are real 200 sign-off-required results and
    // route to the protected job — the ONLY thing that enters the protected
    // Environment.
    expect(review).toContain("sign-off-required)");
    expect(review).toContain("routing to the protected sign-off Environment");
    expect(job(EXCEPTION_JOB).if).toBe(
      `needs.${REVIEW_JOB}.outputs.outcome == 'sign-off-required'`,
    );
    expect(job(EXCEPTION_JOB).environment).toBe(APPROVAL_ENVIRONMENT);

    // PENDING (409 retryable:true) retries under backoff and then FAILS CLOSED with a
    // rerun instruction — it never sets an outcome and never routes to sign-off.
    expect(review).toContain('"$status" == "409"');
    expect(review).toContain(".retryable == true");
    expect(review).toContain("still pending after");
    expect(review).toContain("rerun");
    // The retryable branch must `continue` the loop (retry) — not fall through to an
    // outcome. The bounded exhaustion path must `fail` (fail closed).
    expect(review).toMatch(/retryable"\s*==\s*"true"[\s\S]*?continue/);

    // MISSING / INVALID / ABSENT / UNVERIFIABLE (409 retryable:false) fail closed with
    // NO retry — a fresh report is required after fixing the cause.
    expect(review).toContain("cannot be approved");
    expect(review).toContain("request a fresh report");

    // The 409 readiness handling comes BEFORE the outcome is ever extracted, so a
    // not-ready state can never be mapped onto ship/sign-off. This is precisely what
    // the "every non-green means sign-off" broken workflow gets wrong.
    const pendingBranch = review.indexOf(".retryable == true");
    const outcomeExtract = review.indexOf("outcome=\"$(jq -er '.decision.outcome'");
    expect(pendingBranch).toBeGreaterThanOrEqual(0);
    expect(outcomeExtract).toBeGreaterThan(pendingBranch);

    // STOP / INDETERMINATE never authorize; unknown/malformed/mismatched fail closed.
    expect(review).toContain("stop|indeterminate)");
    expect(review).toContain("never authorizes");
    expect(review).toContain("unknown report outcome");
    expect(review).toContain("report subject does not match the requested envelope");

    // STALE evidence: authorization binds the exact report+envelope and requires the
    // 201 success contract; the server refuses stale evidence and the workflow fails
    // closed on any non-201 rather than carrying an old approval forward.
    expect(review).toContain("ship authorization returned HTTP");
    expect(review).toContain(
      '.reportId == $reportId and .envelope == $expected[0] and .outcome == "ship" and .attestationId == null and .shadowOnly == true',
    );
  });

  it("keeps every non-approvable prerequisite out of the protected Environment", () => {
    // The protected exception job runs ONLY for an exact 200 sign-off-required outcome.
    // Pending/missing/invalid/absent/unverifiable all `fail` (exit non-zero) in the
    // review job before any outcome is set, so its dependent protected job is skipped.
    const gate = job(EXCEPTION_JOB).if as string;
    expect(gate).toBe(`needs.${REVIEW_JOB}.outputs.outcome == 'sign-off-required'`);
    // There is no alternate gate that would admit a pending/absent/unverifiable state.
    expect(gate).not.toContain("pending");
    expect(gate).not.toContain("absent");
    expect(gate).not.toContain("retryable");
    // The pending exhaustion and the non-retryable branch both fail closed.
    expect(review).toMatch(/still pending after[\s\S]*?rerun once the required workflows complete/);
    expect(review).toContain("release prerequisites cannot be approved");
  });
});

describe("prerequisite release summary redaction", () => {
  const review = runScript(REVIEW_JOB);

  it("prerequisite release summary redaction", () => {
    // The bounded summary is rendered ONLY from the typed prerequisite snapshot and a
    // fixed set of identity fields — never the whole report object.
    expect(review).toContain(".prerequisite != null");
    // Required-workflow evidence is visible: path, run link, run id, attempt,
    // status, conclusion.
    expect(review).toContain(".workflowPath");
    expect(review).toContain(".evidence.url");
    expect(review).toContain(".evidence.runId");
    expect(review).toContain(".evidence.runAttempt");
    expect(review).toContain(".evidence.status");
    expect(review).toContain(".evidence.conclusion");
    // Failed workflows are flagged prominently.
    expect(review).toContain("terminal-failed");
    expect(review).toContain("FAILED");
    // Authority-change evidence is visible: changed paths and old/new required sets.
    expect(review).toContain(".authority.changedAuthorityPaths");
    expect(review).toContain(".authority.addedRequiredWorkflows");
    expect(review).toContain(".authority.removedRequiredWorkflows");
    expect(review).toContain(".candidateConfig.requiredWorkflows");
    expect(review).toContain(".previousConfig.requiredWorkflows");
    // Why sign-off is requested (the stable reason codes).
    expect(review).toContain(".decision.reasons");
    // Report / candidate / artifact identity.
    expect(review).toContain(".reportId");
    expect(review).toContain(".subject.candidateSha");
    expect(review).toContain(".subject.artifactDigest");
    // The summary is bounded (arrays sliced) so it cannot grow without limit.
    expect(review).toContain("[:$maxwf]");

    // REDACTION: the OIDC request/JWT bearer never reaches a summary or log.
    expect(review).not.toMatch(/echo\s+["']?\$\{?jwt/i);
    expect(review).not.toMatch(/--header\s+"Authorization/);
    expect(review).not.toMatch(/-H\s+"Authorization/);
    // The unrestricted report JSON is never dumped to the summary. The rendered
    // markdown comes from a dedicated `prereq.md`, never a raw `cat`/`jq .` of the
    // report file into the summary.
    expect(review).not.toMatch(/cat\s+"\$report_file"/);
    expect(review).not.toMatch(/jq\s+[^\n]*'\s*\.\s*'\s*<\s*"\$report_file"/);
    expect(review).not.toMatch(/"\$report_file"\s*>>\s*"\$\{GITHUB_STEP_SUMMARY/);
    // The auth/token config files and the raw token value are never surfaced.
    expect(review).not.toContain('auth_cfg" >> ');
    expect(review).not.toContain('token_response" >>');
    // Sensitive model output is never referenced by the summary renderer.
    for (const sensitive of [
      ".findings",
      ".risks",
      ".observations",
      ".changeSummary",
      ".evidenceLanes",
      ".outstandingWork",
      ".dispositions",
    ]) {
      expect(review, `summary must not reference ${sensitive}`).not.toContain(sensitive);
    }
  });
});

describe("repository prerequisite adoption docs", () => {
  it("repository prerequisite adoption docs", () => {
    const cd = readDoc("cd-release-gate.md");
    const optIn = readDoc("opt-in-repository-integration.md");

    for (const [name, text] of [
      ["cd-release-gate.md", cd],
      ["opt-in-repository-integration.md", optIn],
    ] as const) {
      // The narrow repository-owned configuration file and its v1 schema.
      expect(text, `${name} names the config file`).toContain(".github/scruffy-release.yml");
      expect(text, `${name} shows the version`).toContain("version: 1");
      expect(text, `${name} shows requiredWorkflows`).toContain("requiredWorkflows");
      // The schema is path-only and narrow — it lists existing workflow files, not
      // job names, branches, or result mapping.
      expect(text).toContain(".github/workflows/");

      // First-adoption baseline sign-off.
      expect(text.toLowerCase()).toContain("baseline");
      expect(text.toLowerCase()).toMatch(/first[- ]adoption|first release/);
      // Incremental adoption of further workflows.
      expect(text.toLowerCase()).toMatch(/incremental|add(ing)? (a |another |further )?workflow/);
      // Failure exception vs pending/missing distinction.
      expect(text.toLowerCase()).toContain("sign-off");
      expect(text.toLowerCase()).toContain("pending");
      expect(text.toLowerCase()).toMatch(/absent|missing/);
      // Rerun invalidation of stale evidence/approval.
      expect(text.toLowerCase()).toContain("rerun");
      // Explicit administrator opt-out.
      expect(text.toLowerCase()).toContain("opt-out");
    }

    // The opt-in doc keeps the CODEOWNERS / branch-protection recommendation for the
    // repository-owned configuration and workflow authority.
    expect(optIn).toContain("CODEOWNERS");
    expect(optIn.toLowerCase()).toContain("branch protection");
  });
});
