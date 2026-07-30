# Opt-in repository integration

## Status

Accepted product direction for the initial Scruffy rollout.

Scruffy is an opt-in GitHub integration operated by repository maintainers. It
protects maintainers from unsafe changes, untrusted contributors, and accidental
release mistakes. It does not attempt to prevent a trusted repository maintainer
or administrator from intentionally disabling or bypassing Scruffy.

This trust decision removes the need for a custom administrative control plane
in the initial product. GitHub App installation, repository settings, protected
workflows, and GitHub Environments provide enrollment, authority selection,
approval identity, and operator-visible audit history.

## Trust model

Scruffy trusts:

- repository administrators and maintainers who are allowed to install Apps,
  configure branch protection, manage Actions workflows, and publish releases;
- the centrally maintained Scruffy service and its immutable policy versions;
- GitHub's installation, permissions, protected-environment, and audit controls.

Scruffy does not trust:

- pull-request authors or reviewed repository content;
- analyzer or model output without schema and evidence validation;
- repository code with Scruffy policy authority;
- workflow inputs as proof of an immutable revision without resolving and
  validating them through GitHub;
- generated fixes with merge or policy-administration authority.

A maintainer can deliberately remove a required check, change a workflow, bypass
branch protection where GitHub permits it, or uninstall the App. That is an
accepted administrative action in the opt-in model, not an attack Scruffy tries
to defeat. GitHub should record that action through its normal settings and audit
history.

## Enrollment and opt-out

GitHub App installation is enrollment.

A maintainer opts a repository in by:

1. installing the Scruffy GitHub App for the repository;
2. running Scruffy in shadow mode while its precision and coverage are measured;
3. optionally making `scruffy/poison` a required check when the repository has
   earned authoritative poison-gate use;
4. enabling the centrally maintained nightly trigger for the repository's
   default integration branch;
5. enabling the centrally maintained release workflow and a protected GitHub
   Environment when release gating is desired.

A maintainer opts out by uninstalling or removing the repository from the App
installation and removing any required-check/workflow configuration. Scruffy
must stop accepting new work for a repository once GitHub reports that it is no
longer installed. Historical decisions remain as audit records.

No separate enrollment API, administrator UI, role database, or custom login is
required initially.

## Policy ownership

Scruffy owns the effective review policy:

- gate semantics and escalation rules;
- blockable, reportable, fixable, and release-stop classes;
- analyzer, validator, model, and prompt versions;
- coverage and evidence requirements;
- shadow-versus-authoritative capability rules;
- sandbox and tool permissions.

The initial policy is global and immutable by version. A run records the policy
version it used. Repository content cannot weaken this policy.

GitHub repository settings select whether the repository consumes a capability:
installation opts into Scruffy, branch protection grants poison authority, and a
protected release workflow grants release authority. Scruffy does not need to
mirror those settings in an administrative control plane.

If repository-specific configuration is introduced later, it must remain narrow,
be parsed as untrusted input, and never reduce the service-owned minimum policy.
Configuration files that affect integration behavior should be protected by
CODEOWNERS and branch protection, but those repository controls are not a
substitute for Scruffy's service-owned decision semantics.

## Poison gate

The GitHub App receives pull-request and, when implemented, merge-group events.
It resolves the immutable candidate revision, records and evaluates the poison
run, and posts `scruffy/poison`.

Authority is selected in GitHub:

- shadow: the check is visible but not required;
- authoritative: a maintainer marks `scruffy/poison` as required in the branch
  ruleset after the shadow experiment meets its pre-registered thresholds.

Scruffy posts its honest outcome in either mode. It does not silently change a
repository's branch protection.

## Nightly gate

Nightly reviews the day's merged changes on the repository's default integration
branch. The branch is resolved from GitHub rather than hardcoded as `main`, so
repositories using `master`, `develop`, or another default are supported.

The implemented trigger is a small Scruffy scheduler over installed repositories,
enabled centrally by one cadence setting (`SCRUFFY_NIGHTLY_CADENCE_MS`; see
`docs/product/github-app-setup.md`). There is no per-repository enrollment record
and no administrative UI:

- App installation is the repository list, read through the installation's own
  paginated repository endpoint;
- GitHub is the source of the current default branch and immutable head SHA;
- the durable watermark remains keyed by repository and branch, and each range
  starts at the last **completely reviewed** head — never at the last attempted
  one;
- each attempt holds a per-repository/branch lease, so overlapping ticks, a second
  process, or a restart mid-run cannot duplicate a run, an issue graph, a
  remediation attempt, or a pull request;
- a listing failure schedules nothing and is reported as a failure; it is never
  converted into a clean run;
- nightly never blocks and never auto-merges;
- fix PRs run through the repository's normal CI.

Manual branch selection remains useful for development and explicit backfills,
but normal scheduled operation targets one default integration branch per
repository. The manual command prints the same summary the scheduled run
publishes, so a controlled run and a scheduled run cannot describe the same night
differently.

### Self-review and fixing loop

Each scheduled range runs the whole loop, and every step is durable before any
GitHub write:

1. analyze the immutable `(last complete head, head]` range, adversarially
   validate findings, and deduplicate them;
2. persist the report, its coverage, and the intended work graph;
3. publish **one parent issue** per range that has actionable work, with a native
   child sub-issue for **every surviving finding** and **every required coverage
   gap**. A complete, clean night publishes no issue at all — only its check;
4. attempt a fix for every surviving finding: a registered deterministic fixer
   when one applies, otherwise a schema-constrained model proposal validated
   against real file content at the reviewed SHA and reviewed by a critic;
5. open a linked pull request when a bounded patch can be applied safely —
   **ready for review** when the proposal is independently confirmed, **draft**
   when it is structurally safe and policy-compliant but unconfirmed. Malformed,
   conflicting, stale, or policy-weakening output opens no PR and leaves the child
   issue actionable with an explicit reason;
6. reconcile repository CI, human merges, and human issue closures; a merged fix
   moves its child to *awaiting verification*, and only a verification against the
   immutable post-merge head clears it;
7. close the parent only when required coverage is complete and every child is
   verified resolved or explicitly dismissed.

A refuted finding stays in the audit record and never becomes an issue. A required
coverage gap holds the complete-review watermark, so a partially reviewed range
stays owed and is re-reviewed by a later bounded attempt instead of being titled
as clean.

### The morning process (human)

A maintainer arriving in the morning has two surfaces, rendered from the same
persisted state: the **parent nightly issue** and the advisory `scruffy/nightly`
check. Both lead with coverage, then finding counts, then every child issue and
pull request with its delivery, CI, and merge state, and then any work Scruffy
failed to do.

The human decisions are:

- **merge** a fix PR you agree with (read it first — a draft PR is explicitly
  marked as not independently confirmed). Scruffy never merges its own PRs and
  never changes branch protection;
- **close** a fix PR you do not want. The child issue stays actionable;
- **dismiss** an item by closing its child issue. Scruffy records the GitHub actor
  and state reason as an explicit human dismissal and does not relabel it as a
  verified fix;
- **fix by hand** anything no patch was proposed for; the next verified range
  clears it.

Merging is not resolution. Green CI is supporting evidence, not proof: a merged
fix clears its finding only after Scruffy verifies the defect is gone at the
immutable post-merge head, and an indeterminate verification keeps the item open.

## Release workflow

Release authority belongs in a controlled workflow, not in a custom Scruffy
approval UI.

The target behavior is:

1. a maintainer starts a controlled release workflow for an immutable candidate;
2. the workflow invokes Scruffy's release gate before publication;
3. `ship` permits the workflow to continue;
4. `stop` fails the workflow and prevents publication;
5. `sign-off-required` enters a protected GitHub Environment and requires an
   authorized reviewer;
6. after approval, the workflow records the approving GitHub identity and
   publishes the release;
7. `indeterminate` never publishes automatically.

The authoritative workflow must be centrally maintained or call a centrally
maintained reusable workflow pinned to an immutable revision. Ordinary
contributors must not be able to replace the release decision or publication
steps in the same change being released. Repository maintainers remain trusted
to change or remove the integration deliberately.

The workflow must not expose the GitHub App private key, database credential, or
other Scruffy control-plane secrets to repository-controlled code. The preferred
long-term shape is a hosted Scruffy release endpoint authenticated by a narrowly
scoped GitHub identity or OIDC assertion; choosing that request protocol belongs
to the release-workflow implementation slice.

A published GitHub Release event is not a pre-release gate. Publication happens
only after the controlled workflow reaches an allowed outcome.

## Authentication and audit

The initial integration uses GitHub identity rather than a custom human
authentication system:

- App installation identifies enrolled repositories;
- GitHub permissions govern installation and repository settings;
- branch rulesets govern poison authority;
- protected Environments govern release approvers;
- workflow and repository audit history record administrative changes;
- Scruffy Postgres records immutable subjects, policy versions, evidence,
  decisions, transitions, attempts, and effects.

Scruffy may later validate workflow-to-service requests through GitHub OIDC or a
GitHub App-mediated protocol. That is machine authentication for a narrow release
operation, not a general administrative control plane.

## Operational placement

Scruffy remains an external modular-monolith service for the initial scale:

- webhook listener and reconciliation engine;
- trusted analysis modules;
- effects dispatcher with the narrow GitHub write credential;
- PostgreSQL durable state;
- separately isolated hostile execution when a gate requires it.

No Scruffy authority credential belongs in a reviewed repository. Reusable
workflows are integration clients; the service remains the decision authority.

## Deferred capabilities

Do not build these until observed operational pressure justifies them:

- an administrative API or UI;
- a custom user, role, or organization database;
- delegated Scruffy administrators;
- a generalized approval engine;
- cross-repository waiver administration;
- repository-specific policy weakening;
- non-GitHub identity-provider selection.

Revisit a dedicated control plane when Scruffy supports delegated operators,
frequent repository-specific policy, organization-wide waivers, multiple SCMs,
or compliance requirements that GitHub's controls and Scruffy's run history
cannot satisfy.

## Initial delivery sequence

1. Make the App-backed read/write path selectable and prove an outward check run
   against a controlled repository.
2. Keep poison in shadow mode and collect the pre-registered corpus and live
   measurements.
3. Wire optional model analysis into deeper gates without putting it on poison's
   deterministic critical path.
4. Add default-branch nightly scheduling for installed repositories. *(Built:
   the scheduler, the durable self-review/fix lifecycle, and the morning
   parent/check summary. Not yet exercised against a live GitHub installation.)*
5. Build the controlled release workflow and protected-environment sign-off.
6. Grant authority only after the corresponding shadow evidence meets the product
   thresholds.
