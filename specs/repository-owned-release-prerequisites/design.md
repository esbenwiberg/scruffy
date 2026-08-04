# Repository-owned release prerequisites — Design

## Approach

Add a narrow repository-owned configuration file at:

```text
.github/scruffy-release.yml
```

Version 1 names one or more required GitHub Actions workflow files:

```yaml
version: 1

requiredWorkflows:
  - .github/workflows/ci.yml
  - .github/workflows/integration.yml
```

Scruffy reads and parses the file at the exact candidate SHA. It resolves provider facts—repository identity, default branch, workflow IDs, runs, attempts, event, status, conclusion, URLs, and candidate SHA—through the GitHub App. None of those facts are accepted from repository configuration or request input.

The configuration is repository-owned integration routing, not repository-owned release policy. Scruffy's fixed service semantics determine what each observed state means.

## Configuration contract

The v1 configuration schema is intentionally narrow:

```ts
interface RepositoryReleaseConfigV1 {
  version: 1;
  requiredWorkflows: string[];
}
```

Invariants:

1. `requiredWorkflows` is non-empty.
2. Entries are unique canonical repository-relative paths.
3. Every path is below `.github/workflows/` and ends in `.yml` or `.yaml`.
4. The Scruffy reusable release workflow cannot be listed as its own prerequisite.
5. Unknown keys and unknown versions are rejected.
6. YAML aliases, duplicate keys, non-string entries, and unsafe/custom tags are rejected or disabled by the parser.
7. A missing, malformed, empty, or unsupported configuration is authorization-ineligible; it is not an exception-approvable failed workflow.

The repository cannot configure branch, event, result mapping, approval behavior, freshness, endpoint, audience, environment, or waiver semantics in v1. Scruffy resolves the repository's default branch and applies its service-owned accepted event rules.

## Trust and baseline model

Repository maintainers are trusted under Scruffy's accepted opt-in model. Candidate content is still untrusted and may attempt to weaken its own prerequisites, so policy-authority changes receive mandatory human attention.

For `(previous release, candidate]`, Scruffy detects changes to:

- `.github/scruffy-release.yml`;
- `.github/workflows/**`;
- `.github/actions/**`.

Any such change forces `sign-off-required`, even when all current required workflow runs succeeded. The report presents changed paths, previous and candidate content identities, and required-workflow additions/removals.

The broad workflow/action path rule is deliberate. Looking only at directly configured workflow files can miss local reusable workflows and composite actions. Repository scripts outside `.github/` remain ordinary candidate source: required workflows execute them at the candidate SHA, while Scruffy's source-analysis policy independently evaluates the release range.

Baseline rules:

- First release, first Scruffy adoption, or no readable previous configuration requires sign-off to establish a baseline.
- After an approved release, its exact candidate becomes the comparison baseline through the next release's `previousReleaseSha`.
- Removing or emptying the configuration is invalid, not a sign-off route. Disabling Scruffy is an explicit repository-administrator opt-out outside the release protocol.

## Workflow identity and evidence

Scruffy resolves every configured path to a GitHub workflow identity and selects the applicable current run for the exact candidate SHA. Display names are never identity because they can collide or change.

Persisted evidence for each required workflow includes at least:

```ts
interface RequiredWorkflowEvidence {
  workflowId: number;
  workflowPath: string;
  runId: number;
  runAttempt: number;
  event: string;
  branch: string;
  candidateSha: string;
  status: string;
  conclusion: string | null;
  url: string;
}
```

The adapter validates provider response shapes and throws on incomplete pagination, malformed identities, or API failures. An empty result means no matching run; it never represents a provider failure.

The required-workflow reader is a narrow read-only Actions capability, separate from source reads and SCM writes. The GitHub App's existing `Actions: read` permission is sufficient; Scruffy never dispatches, reruns, cancels, approves, or modifies workflows.

## State classification

Each configured workflow resolves to exactly one service-owned state:

| State | Provider evidence | Treatment |
|---|---|---|
| `passed` | Current attempt is completed with conclusion `success` for the exact workflow and candidate | Satisfied |
| `terminal-failed` | Current attempt is completed with any terminal non-success conclusion | Exception-eligible |
| `pending` | Requested, queued, waiting, pending, or in progress | Not ready; retry later |
| `absent` | No matching run for the exact configured workflow/candidate | Fail closed; not exception-eligible |
| `unverifiable` | API/schema/pagination/identity mismatch or ambiguous current run | Indeterminate; not exception-eligible |

Terminal non-success includes failure, cancelled, timed out, action required, neutral, skipped, or stale. Only exact `success` is green.

Aggregate behavior for multiple workflows:

1. All `passed`: prerequisite lane is complete; normal Scruffy decision applies.
2. All terminal and at least one `terminal-failed`: force `sign-off-required` and identify every failed workflow.
3. Any `pending`: do not create an approvable exception; return a retryable not-ready result.
4. Any `absent` or `unverifiable`: fail closed with no authorization.
5. A confirmed Scruffy `stop` dominates every prerequisite state and remains non-overridable.
6. Existing source/model risks and terminal workflow failures combine into one exact report and, when eligible, one protected sign-off.

A completed workflow failure is an explicit observed result and may be accepted by a responsible human. Missing or unverifiable evidence is not a result and cannot be converted into approval merely by asking early.

## Report and identity

Introduce a new report schema version that carries typed repository-configuration and required-workflow evidence. Human-readable `observations` and `gaps` remain presentation, not authority.

The report identity includes:

- canonical parsed repository configuration and its content digest;
- previous and candidate configuration/workflow authority comparison;
- every required workflow identity;
- exact run ID and current attempt;
- status, conclusion, event, branch, candidate SHA, and evidence URL;
- derived prerequisite state and aggregate outcome contribution.

Historical reports remain inspectable but cannot satisfy the new workflow-prerequisite authority contract.

Stable reason codes should distinguish at least:

- `required_workflow_failed`;
- `release_authority_changed`;
- `release_authority_baseline_required`;
- `required_workflow_pending`;
- `required_workflow_absent`;
- `required_workflow_unverifiable`.

Only the first three can lead to a protected sign-off report. Pending, absent, and unverifiable results do not authorize.

## Successor reports and reruns

Current release-run uniqueness collapses one deployment envelope and policy version onto one run even when CI evidence later changes. This must change for workflow reruns.

Compute a canonical prerequisite-evidence digest over configuration authority and exact workflow run attempts. Include that digest in release-run identity so a changed current attempt creates a successor report for the same deployment envelope.

Required behavior:

1. An exact retry with unchanged evidence returns the same report.
2. A failed workflow rerun creates a new attempt and invalidates the prior evidence snapshot while pending.
3. A rerun that succeeds produces a successor report eligible for the normal path when no other reason requires sign-off.
4. A previously green workflow rerun makes its old report stale immediately; it cannot authorize while the current attempt is pending or failed.
5. A successor report supersedes previous reports for the same deployment envelope through the existing latest-report authority fence.
6. Any attestation bound to a superseded report becomes ineligible automatically.

## Authorization-time revalidation

Terminal authorization must re-fetch current workflow state immediately before persisting authorization and compare it with the report's exact evidence snapshot.

Authorization refuses when:

- a workflow has a newer run attempt;
- status or conclusion changed;
- the candidate, workflow ID/path, branch, or event no longer matches;
- release-authority files changed relative to the report;
- evidence cannot be re-read completely;
- a newer report exists for the deployment envelope.

A mismatch instructs the caller to request a fresh report. It never silently updates evidence inside an existing report or carries an old approval forward.

## Sign-off presentation

For workflow failure or release-authority change, the protected Environment summary must show:

- exact candidate and artifact digest;
- prior release SHA or first-release marker;
- every required workflow with run URL, run ID, attempt, status, and conclusion;
- every failed workflow prominently;
- changed configuration/workflow/action paths;
- old and new required workflow sets;
- all independent Scruffy risks and coverage gaps;
- the exact report ID;
- mandatory non-empty rationale and responsibility acceptance.

The existing invariant remains: OIDC actor, responsibility accepter, and actual protected-Environment reviewer must be the same stable GitHub identity.

## Architecture changes

### Repository configuration

- Add a strict YAML schema/parser under the release domain or policy boundary.
- Add exact-SHA configuration reads through `ScmReader.getFileContent`.
- Compare canonical previous/candidate configuration and authority-path changes from the immutable release range.
- Keep fixed semantics in service code; do not merge repository configuration into unrestricted `EffectivePolicy`.

### Workflow evidence provider

- Add a narrow `WorkflowRunReader` port to `src/providers/scm/port.ts`.
- Implement it for the GitHub App backend with Actions read-only API calls.
- Keep fake adapters and fixtures deterministic.
- Do not infer workflow success from check-run names when workflow identity is configured.

### Release analysis and report

- Replace hosted hardcoded `ci/build`/`ci/test` authority with repository workflow prerequisites.
- Preserve existing context-based candidate-CI behavior for local compatibility/corpus paths until separately retired.
- Add typed prerequisite evidence to the report and decision inputs.
- Add an evidence digest to release-run uniqueness and additive persistence migrations.

### Hosted authority

- Resolve prerequisites before returning an approvable report.
- Preserve pending/absent/unverifiable distinctions through HTTP responses.
- Revalidate workflow evidence before both automatic and exception authorization.
- Keep report, attestation, and authorization bound to one exact evidence snapshot.

## Delivery slices

1. **Repository configuration and authority-change detection**
   - strict `.github/scruffy-release.yml` parser;
   - exact previous/candidate reads;
   - first-use and `.github/workflows/**` / `.github/actions/**` change detection;
   - deterministic fixtures and report presentation.

2. **Exact workflow-run evidence**
   - read-only Actions port/provider;
   - workflow path-to-ID resolution;
   - exact-candidate current-attempt state classification;
   - multiple-workflow aggregation.

3. **Versioned report and persistence**
   - typed prerequisite snapshot;
   - stable reason codes;
   - report schema successor;
   - evidence-digest release-run identity and additive migration.

4. **Freshness and successor behavior**
   - workflow rerun handling;
   - successor reports and supersession;
   - stale report/attestation refusal.

5. **Hosted workflow and protected sign-off UX**
   - retry behavior for pending prerequisites;
   - failed-workflow and authority-change summaries;
   - authorization-time provider revalidation;
   - disposable caller proof for green, failed-approved, pending, changed-authority, and rerun paths.

## Required behavioral examples

- A repository can name any existing workflow paths without adopting standard job names.
- One configured workflow succeeds and an otherwise clean report ships normally.
- Two configured workflows both succeed and an otherwise clean report ships normally.
- One of two workflows completes with failure and produces `sign-off-required` with its run link.
- A pending workflow cannot enter the approval Environment.
- A missing workflow run cannot be approved as if it failed.
- A GitHub API failure cannot be approved as if the workflow failed.
- A workflow YAML change forces sign-off even when its run succeeds.
- A local reusable workflow or composite-action change forces sign-off.
- First adoption forces sign-off to establish the baseline.
- Empty or malformed configuration never ships and never becomes a workflow-failure exception.
- A confirmed deterministic Scruffy stop remains `stop` when CI failed or authority changed.
- A failed run rerun to success creates a successor report and invalidates the old approval path.
- A green run rerun before authorization invalidates the stale green report.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Candidate removes its own prerequisite | Non-empty strict schema; removal/config change forces sign-off; missing config cannot authorize |
| Candidate weakens workflow implementation | Any workflow/local-action authority change forces protected sign-off |
| Workflow display-name collision | Resolve and persist workflow ID/path, never display name alone |
| Old green survives a rerun | Evidence digest, successor report, and authorization-time current-attempt revalidation |
| Human approves before CI finishes | Pending is not exception-eligible and never enters the protected Environment |
| GitHub outage is mistaken for failure | Unverifiable is distinct from terminal failure and cannot authorize |
| Broad `.github/workflows/**` rule causes extra sign-offs | Accept conservative first-version behavior; revisit only with proven dependency-graph evidence |
| Repository config grows into policy weakening | Keep v1 path-only; reject unknown keys; service owns all semantics |

## Deferred extensions

- External CI represented only by commit statuses or third-party checks.
- Per-workflow non-waivable failure modes.
- Dependency-graph-aware authority-change detection narrower than `.github/workflows/**` and `.github/actions/**`.
- Multi-repository hosted release policy registry or administration UI.
- Non-GitHub workflow providers.
