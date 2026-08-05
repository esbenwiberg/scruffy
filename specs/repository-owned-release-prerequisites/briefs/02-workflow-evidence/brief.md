---
title: "Read and classify exact required GitHub workflow runs"
touches:
  - src/providers/scm/port.ts
  - src/providers/scm/factory.ts
  - src/providers/scm/github-app-reader.ts
  - src/providers/scm/fake.ts
  - src/domain/release/
  - test/providers/
  - test/domain/
does_not_touch:
  - src/persistence/
  - src/server/http.ts
  - .github/workflows/release-authority-shadow.yml
---

## Task

Add the narrow read-only GitHub Actions workflow-run evidence capability from the parent design. Resolve each configured workflow path to provider workflow identity and its current applicable run/attempt for the exact candidate SHA and repository default branch. Persistable evidence must include workflow ID/path, run ID/attempt, event, branch, candidate SHA, status, conclusion, and URL.

Use workflow ID/path as identity, never display name or check context. Support service-owned v1 events `push` and `workflow_dispatch`; reject or report absent runs from other events. Select the current applicable run deterministically and conservatively. A rerun's current attempt supersedes its earlier attempt. Ambiguous runs, malformed provider data, incomplete pagination, or API failure are `unverifiable`, never empty/green.

Implement provider-neutral classification into `passed`, `terminal-failed`, `pending`, `absent`, and `unverifiable`, plus aggregation over multiple configured workflows. Only completed `success` passes. Completed terminal non-success is exception-eligible. Pending, absent, and unverifiable are not.

## Constraints

- Use the GitHub App's existing Actions read-only transport; add no write permission or mutation call.
- Do not trust caller-supplied run IDs, conclusions, workflow IDs, branch, event, or SHA.
- Bind every record to the exact candidate and default branch.
- Preserve provider failure versus genuine absence.
- Do not infer workflow identity from check-run/status names.
- Keep adapter pagination bounded and complete-or-throw.
- Follow parent purpose/design and brief 01's parsed config contract.

## Test expectations

Create focused tests named:

- `"required workflow run identity"`: exact path/ID/candidate/default-branch/event matching and display-name collision pressure.
- `"required workflow state classification"`: success, every terminal non-success, pending states, absent, malformed, ambiguous, and provider failure.
- `"required workflow rerun selection"`: current attempt wins; a newer pending attempt invalidates an older success/failure.
- `"multiple required workflow aggregation"`: all passed, terminal failure, pending, absent, and unverifiable precedence.

The obvious broken implementation reads check names or chooses any prior successful attempt; collision and rerun tests must fail it.

## Wrap-up

Run focused facts and full validation. Record exact read-only GitHub endpoints used. Commit without changing App permissions or live workflows.
