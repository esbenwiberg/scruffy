# Repository-owned release prerequisites — Purpose

## Problem

Scruffy's hosted release path currently requires the globally hardcoded candidate-CI contexts `ci/build` and `ci/test`. Repositories use different GitHub Actions workflows and job names, so those defaults make release authority difficult to adopt without first reshaping repository CI.

The existing candidate-CI behavior is also broader than the intended contract: any missing, pending, or failed context becomes `sign-off-required`, and evidence is identified by check/status name rather than by an exact GitHub Actions workflow run. That does not distinguish a completed failed workflow from one that has not run, is still running, or cannot be verified.

## Intent

Let each enrolled repository declare its existing required GitHub Actions workflows in a narrow repository-owned file while Scruffy retains control of release semantics.

A team can adopt Scruffy incrementally:

1. add one existing workflow to the repository configuration;
2. approve the first release to establish a baseline;
3. allow subsequent clean, green releases to follow the normal automatic path;
4. add further workflows over time, with each configuration or workflow-authority change requiring explicit sign-off;
5. retain a protected, audited exception path for workflows that completed unsuccessfully.

## Desired outcome

For an exact release candidate and artifact:

- all configured required workflows completed successfully permits the normal Scruffy outcome;
- one or more completed terminal non-success workflows forces `sign-off-required`;
- a required workflow that is pending, absent, mismatched, or unverifiable cannot be approved prematurely;
- a change to repository release configuration or GitHub workflow authority forces `sign-off-required`, even if current workflow runs are green;
- a confirmed Scruffy `stop` remains non-overridable;
- every report and authorization identifies the exact workflow runs and configuration baseline it relied on;
- a workflow rerun or changed evidence invalidates stale reports and approvals.

## Product boundary

Repository configuration selects which repository-owned workflows provide release-prerequisite evidence. It does not define Scruffy outcomes, waive evidence, make a `stop` approvable, select arbitrary endpoints, or supply authoritative workflow results.

Scruffy owns and enforces:

- configuration schema and minimum requirements;
- workflow identity and exact-candidate verification;
- state classification and aggregation;
- change-to-sign-off behavior;
- approval and authorization semantics;
- freshness and successor-report rules;
- audit representation.

## Non-goals

- A general policy administration API or UI.
- Automatic discovery of every workflow or check in a repository.
- Repository-controlled weakening of Scruffy's source-analysis or stop policy.
- Treating a workflow name or caller-supplied conclusion as authoritative.
- Supporting arbitrary external CI/status providers in the first increment.
- Publishing releases or deploying artifacts from the Scruffy service.
