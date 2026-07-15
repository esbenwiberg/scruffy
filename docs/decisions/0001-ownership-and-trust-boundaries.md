# ADR 0001: Ownership and trust boundaries

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Scruffy reviews potentially hostile repository changes and may eventually block merges, propose fixes, and gate releases. If policy is stored in the reviewed repository, a malicious contributor or autonomous fix agent could weaken the controls evaluating its own change.

At the same time, Scruffy cannot reliably reproduce every repository's build, test, toolchain, service, and runtime conventions.

## Decision

Repositories own software execution concerns:

- application source;
- builds and tests;
- toolchain and runtime versions;
- dependency and service setup;
- test matrices;
- application-specific CI and artifacts.

Scruffy consumes repository-owned CI evidence by immutable commit SHA or PR. A generated fix is validated by opening a PR and waiting for the repository's normal checks; Scruffy does not require a second build/test command contract.

Scruffy's external control plane owns all review authority and policy:

- protected paths and risk categories;
- enabled gates;
- block, abstain, escalation, and sign-off thresholds;
- release-source semantics;
- visual QA policy, thresholds, and baseline selection;
- language support and analyzer policy;
- model, prompt, tool, and analyzer versions;
- sandbox permissions and network policy;
- exceptions and waivers;
- repository enrollment.

Repository content is untrusted and cannot weaken effective policy. It may provide hints or application-specific execution inputs, but Scruffy validates and interprets them under service-owned policy.

AI review and fix workers have read-only access to effective policy and cannot administer policy, grant exceptions, change thresholds, or disable gates. GitHub write operations occur through a separate, narrowly privileged component.

Policy changes require a separate administrative identity and produce an immutable version, actor, timestamp, reason, and before/after audit record. Weakening changes should support second-party approval.

Each gate result records the repository, immutable revision, policy version, analyzer bundle, model/prompt versions, and evidence provenance.

## Visual QA boundary

Repository-owned visual results are useful but can be influenced by reviewed code. Scruffy owns browser/runtime pinning, comparison thresholds, baseline selection, and evidence retention. Repository-provided startup and navigation inputs are treated as hostile.

## Rationale

This division preserves repository expertise without allowing repository changes or autonomous agents to redefine the policy judging them. It also makes policy auditable across the organization and keeps the poison gate independent of arbitrary build duration.

## Consequences

### Positive

- Review policy cannot be silently weakened in the reviewed PR.
- Builds and tests remain aligned with repository maintainers' actual environments.
- Scruffy avoids becoming a universal build platform.
- Gate decisions are reproducible against immutable policy and analyzer versions.
- Administrative actions have a distinct identity and audit trail.

### Negative

- Repository-owned CI is evidence, not an independent trust root; malicious changes may manipulate it.
- Scruffy needs explicit evidence provenance and trust levels.
- Visual QA requires stronger service-managed execution controls.
- A separate policy store, administration surface, and authorization model are required.

## Unresolved questions

- Which policy store and approval mechanism should be used?
- Which organization roles may enroll repositories or weaken policy?
- How should service-level policy and repository-specific overrides compose?
- Which repository-provided execution inputs are unavoidable for visual QA?
- When may repository CI be considered authoritative versus merely supporting evidence?
