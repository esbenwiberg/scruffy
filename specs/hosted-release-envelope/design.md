# Hosted release-envelope authority — Design

## Approach

Extend the existing release-report boundary rather than creating a parallel
workflow-owned authority object. A versioned deployment envelope becomes part of
the report content and identity. PostgreSQL remains the sole durable authority
for reports, verified exception attestations, and shadow authorization records.
The existing decision kernel remains unchanged.

Expose a narrow release protocol from the existing Node HTTP service. GitHub
Actions jobs acquire short-lived OIDC tokens with a fixed Scruffy audience. The
service verifies GitHub's signature and claims against service-owned repository,
workflow, ref, and environment allowlists before driving release work. For an
exception, workflow input carries rationale and explicit responsibility
acceptance, while a new least-privileged GitHub reader queries workflow-run
approval history to establish the actual Environment reviewer. Terminal
authorization re-reads durable state and compares every envelope field.

The Azure service uses managed identity and Microsoft Entra ID to call an
explicitly configured existing Microsoft Foundry Claude deployment. Provisioning
or purchasing that model, assigning roles, changing GitHub App permissions,
disabling administrator bypass, deploying the revision, and running live proof
remain explicit human operations after implementation validation.

## Contracts

### Deployment envelope

The versioned report subject must bind at least:

```ts
interface ReleaseDeploymentEnvelope {
  repository: string;
  previousReleaseSha: string | null;
  candidateSha: string;
  artifactDigest: `sha256:${string}`;
  targetEnvironment: string;
}
```

- Parse SHA/digest/environment at every inbound boundary.
- Artifact digest is an immutable content digest, not an image tag or URL.
- Report identity includes this envelope plus existing report content.
- Historical v1 reports remain readable but can never satisfy a v2 full-envelope
  authorization.
- Same candidate + different artifact/environment is distinct durable work.

### Hosted operations

Names may be adjusted consistently by the owning pod, but the protocol must have
these separate semantics:

```text
POST /v1/release-reports
  authenticated OIDC request for one exact envelope
  -> durable parsed report and routing outcome

GET /v1/release-reports/{reportId}
  authenticated retrieval of the exact persisted report

POST /v1/release-reports/{reportId}/attestations
  authenticated rationale + explicit acceptance + workflow run identity
  -> GitHub approval-history verification + durable exact attestation

POST /v1/release-reports/{reportId}/authorizations
  authenticated exact envelope + workflow run identity
  -> terminal durable-state revalidation + persisted shadow authorization/refusal
```

The API returns generic authentication/internal failures to callers and logs
controlled diagnostics. It never publishes, deploys, emits an SCM effect, or
returns a credential. Report retrieval is not public.

### OIDC trust

- Issuer: `https://token.actions.githubusercontent.com`.
- Audience: a fixed service-owned value, default `scruffy-release`.
- Verify JWT signature through issuer discovery/JWKS with bounded cache and safe
  key rotation behavior.
- Verify expiry/not-before/issued-at and reject unknown/missing required claims.
- Bind repository name and stable repository identity, `job_workflow_ref`,
  workflow run id/attempt, actor identity, and configured Environment posture.
- Trust configuration is environment/configuration owned by Scruffy, not request
  body or reviewed repository policy.
- A token valid for another repository/workflow/ref/run/environment is not a
  partially trusted token; reject it before driving release work.

### Approval attestation

A durable attestation includes at least:

- report ID and complete deployment envelope;
- protected approval environment;
- workflow run ID and attempt;
- non-empty exception rationale;
- explicit responsibility acceptance;
- OIDC actor name and stable ID;
- actual reviewer name and stable ID from GitHub approval history;
- review timestamp and durable attestation identity;
- relevant verification provenance.

The OIDC actor, responsibility accepter, and actual reviewer must be equal.
Caller-supplied reviewer text is never authoritative. GitHub history unavailable,
ambiguous, rejected, or mismatched means no attestation.

### Shadow authorization

A durable authorization includes the report, envelope, outcome, matching
attestation ID when required, authorizing workflow run identity, timestamp, and
an explicit `shadowOnly: true`. Exact idempotent retries return the same record.
`ship` needs no attestation; `sign-off-required` needs one exact attestation;
`stop` and `indeterminate` are structurally ineligible.

## Architecture

### Brief 01 — envelope identity and persistence

Likely touches:

- `src/domain/release/report.ts`, `signoff.ts`, and release report tests;
- `src/gates/release/service.ts` and `src/app/scruffy.ts` input threading;
- `src/persistence/runs.ts` plus additive migration(s);
- scripts/harnesses that construct release input;
- dedicated database-backed envelope persistence tests.

It owns the public domain/persistence seam consumed by briefs 02 and 03.

### Brief 02 — OIDC hosted protocol and authorization

Likely introduces:

- a GitHub OIDC verifier port/provider;
- a least-privileged workflow-approval reader port and GitHub App adapter;
- typed report, attestation, and authorization stores/application services;
- narrow routes in `src/server/http.ts` and wiring in `src/server/main.ts`;
- local signed-token/JWKS fixtures and HTTP/database pressure tests;
- GitHub App permission/runbook updates for `Actions: read`.

It consumes brief 01's complete-envelope schema and store.

### Brief 03 — real hosted model and disposable client

Likely touches:

- `src/providers/models/azure-foundry.ts`, factory tests, and package dependencies;
- `infra/azure/main.bicep` and `scripts/deploy-azure-shadow.sh`;
- a controlled GitHub Actions OIDC client/CLI or reusable-workflow seam;
- hosted deployment/release runbooks and validation records.

Use the official Anthropic SDK/API shape supported by Microsoft Foundry. Prefer
managed identity with `DefaultAzureCredential`, token scope
`https://ai.azure.com/.default`, and least-privileged `Cognitive Services User`
over an API key. Require explicit endpoint/deployment configuration and fail boot
on missing/invalid real-backend configuration.

## Authority invariants

1. Canonical report identity includes the complete deployment envelope plus policy, provenance, evidence, and decision.
2. Replacing any envelope field invalidates report, approval, and authorization.
3. Distinct artifacts or environments for one candidate remain distinct durable subjects.
4. Stored report, approval, and authorization data is runtime-schema parsed at every read boundary.
5. OIDC verifies signature, issuer, fixed audience, lifetime, repository, workflow/ref, run, actor, and configured Environment posture; unknown or missing claims fail closed.
6. Workflow input supplies rationale/acceptance, while GitHub approval history establishes the actual reviewer.
7. Sign-off requires non-empty rationale and equality of OIDC actor, responsibility accepter, and actual reviewer stable identities.
8. `stop` and `indeterminate` never authorize.
9. `ship` needs no approval; `sign-off-required` always needs the exact attestation.
10. Terminal authorization re-reads durable state and revalidates every envelope field immediately before success.
11. Real-model failure, malformed output, or truncation remains an explicit gap and cannot silently ship.
12. Every authorization is shadow-only and the service holds no publication/deployment credential.

## Constraints

- Preserve the authority fence, invariants, pressure behavior, and non-goals reproduced in this runtime spec; pods may not relax them to finish.
- Migrations are additive; never rewrite historical migrations or stored v1
  reports.
- Keep the pure release decision kernel authoritative and outcome vocabulary
  unchanged.
- Analysis/model code never receives GitHub publication/deployment credentials.
- The hosted API does not become a general administration plane.
- No public report endpoint and no static secret in repository workflows.
- Avoid repository-controlled allowlists or policy weakening.
- OIDC and approval failures fail closed before authorization.
- Existing poison/nightly behavior and CD report-only behavior remain compatible.
- Full reports stay out of PR checks.
- Cloud or external permission changes are validation gates, not assumptions a
  pod may silently satisfy or waive.

## Risks

| Risk                                                                 | Likelihood | Mitigation                                                                                                                  |
| -------------------------------------------------------------------- | ---------: | --------------------------------------------------------------------------------------------------------------------------- |
| Candidate-only run uniqueness collapses two artifacts/environments   |       high | Make the complete envelope the durable release subject and prove same-SHA divergence in DB tests.                           |
| OIDC token is valid but from an unintended workflow                  |       high | Fixed audience plus repository ID, workflow ref, run, actor, and environment claim checks from service-owned allowlists.    |
| Workflow lies about the approver                                     |       high | Read actual workflow-run approvals through GitHub App `Actions: read`; compare stable identities.                           |
| Old approval authorizes successor report                             |       high | Bind attestation to exact report/envelope and terminally re-read current durable authority.                                 |
| Report endpoint leaks source/security findings                       |     medium | Require OIDC for retrieval; no public capability URL or browser UI in this slice.                                           |
| Foundry adapter silently uses fake or wrong deployment               |       high | Explicit backend/endpoint/deployment, managed-identity auth, provider provenance, and fail-fast boot.                       |
| Marketplace/model deployment creates cost or unsupported-region work |     medium | Treat provisioning, terms, roles, and live calls as human gates; implementation accepts an existing deployment.             |
| GitHub App permission expansion broadens authority                   |     medium | Add read-only Actions permission only; no workflow writes or deployment writes.                                             |
| External API/JWKS outage blocks releases                             |     medium | Bounded cache/retry, explicit failure, and no fabricated authorization.                                                     |
| Scope drifts into real deployment                                    |       high | Persist `shadowOnly`, return no deployment credential/effect, and verify zero publication/deployment effects in live proof. |

## Alternatives considered

- **Static shared workflow secret:** rejected because it is long-lived, weakly
  identifies the calling workflow, and contradicts the accepted OIDC direction.
- **Trust workflow-supplied reviewer fields:** rejected because the protected
  Environment's actual reviewer is independently available from GitHub.
- **Public report page with opaque ID:** rejected because report IDs are not an
  authorization mechanism and reports can contain sensitive findings.
- **Custom Scruffy approval UI/identity database:** rejected by existing product
  direction; GitHub Environment remains the human authority surface.
- **API-key Foundry authentication:** retained only as a documented emergency
  alternative if managed identity is proven unsupported; keyless Entra ID is the
  required default for hosted deployment.
- **One candidate equals one release run:** rejected because one commit can be
  built into multiple artifacts and target multiple environments.

## Reference evidence

- `docs/product/cd-release-gate.md`
- `docs/product/release-risk-report.md`
- `docs/product/opt-in-repository-integration.md`
- `docs/product/azure-shadow-deployment.md`
- `docs/campaigns/C002-hosted-release-envelope-authority.md`
- GitHub OIDC reusable workflow guidance:
  `https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows`
- GitHub workflow-run approvals API:
  `https://docs.github.com/en/rest/actions/workflow-runs`
- Microsoft Foundry Claude deployment/authentication:
  `https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude`
- Microsoft Foundry keyless authentication:
  `https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/configure-entra-id`

## Open questions

No implementation-blocking architecture question remains. Exact route/module/
table names and the internal successor-report representation are delegated to
the owning pods, provided the contracts and pressure behavior above hold.
