# ADR 0002: Initial language scope

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Scruffy is intended for heterogeneous internal repositories, but claiming universal semantic coverage in v1 would hide large differences in parsing, dependency resolution, security tooling, persistence frameworks, and code context.

The architecture should remain extensible without forcing the initial implementation to support every language poorly.

## Decision

V1 provides explicit semantic-analysis support for:

1. JavaScript and TypeScript on Node.js;
2. Python;
3. C#/.NET;
4. Go.

Language support is implemented behind adapters that can provide:

- language and project detection;
- symbol-aware context selection;
- dependency and call-site discovery;
- language-specific security analysis;
- persistence and migration heuristics;
- test-file association;
- patch construction;
- deterministic analyzer integration.

SCM integration, gate policy, evidence representation, scheduling, sandboxing, and release orchestration remain language-neutral.

Unsupported languages may receive shallow, language-independent checks, but Scruffy must label the reduced coverage in every result. Unsupported coverage must never be presented as a clean semantic review.

Repositories continue to own build and test execution for all languages. Language adapters do not become alternative build systems.

## Rationale

These four ecosystems provide broad organizational coverage while remaining a tractable initial set. Explicit adapters allow higher-quality semantic context and language-specific evidence without embedding framework-specific behavior throughout the service.

## Consequences

### Positive

- V1 scope and assurance claims are honest and measurable.
- New languages can be added without changing policy and SCM layers.
- Deterministic analyzers can be selected by ecosystem.
- Build and test ownership remains with repositories.

### Negative

- Some enrolled repositories receive reduced initial coverage.
- Adapter behavior and evaluation datasets must be maintained separately.
- Framework-specific blind spots will remain even within supported languages.

## Unresolved questions

- Which parsers, symbol indexes, and deterministic analyzers should back each adapter?
- What minimum capability qualifies a language as supported?
- Which frameworks and persistence systems should be included in each v1 evaluation corpus?
- Should JavaScript and TypeScript have separate assurance labels?
- What is the priority order for the next language adapters?
