# Hosted release-envelope authority — Purpose

**Status:** Ready for approval
**Date:** 2026-07-31

## Problem

Scruffy's CD experiment can route `ship` and `sign-off-required`, but the
analysis runs outside the hosted service, can use ephemeral report storage, and
binds artifact/environment only in workflow artifacts rather than the report's
canonical identity. The Azure service exposes no authenticated release API,
forces the fake model backend, and cannot durably establish the actual protected-
environment reviewer before returning an authorization result.

## Goal

For one controlled GitHub repository, make the Azure-hosted Scruffy service
produce a durable shadow authorization bound to repository, release range,
artifact digest, target environment, and report. A `sign-off-required`
authorization must additionally bind a non-empty rationale and explicit
responsibility acceptance to the actual GitHub Environment reviewer.

## Goals

- Include artifact digest and target environment in canonical report identity.
- Persist and retrieve distinct full-envelope reports without candidate-only
  collisions.
- Authenticate controlled GitHub Actions callers with GitHub OIDC and fixed
  service-owned trust rules.
- Persist verified approval attestations and terminal shadow authorizations.
- Revalidate the complete envelope immediately before authorization.
- Run hosted release analysis with a real Azure Foundry model backend.
- Prepare a disposable OIDC CD client and runbook for later human-approved live
  proof.

## Non-goals

- Real publication or deployment.
- Production authority or a required release gate.
- A custom approval/user/role/admin UI or generalized waiver system.
- Public report access.
- Static workflow credentials.
- New release outcomes or model-authored authority.
- Implementing every future release evidence lane.
- Performing Azure/GitHub permission changes or live deployment inside an
  implementation pod without the explicit human gates in C002.

## Success criteria

- Exact replay is idempotent, while every deployment-envelope mutation changes
  identity and invalidates approval/authorization.
- Valid OIDC requests from the allowlisted workflow can drive and retrieve hosted
  reports; malformed or unauthorized claims fail before work is driven.
- `ship` authorizes without sign-off, `sign-off-required` authorizes only with a
  verified matching attestation, and `stop`/`indeterminate` never authorize.
- The Azure deployment can select a real, keyless Foundry backend and fails boot
  rather than silently falling back to fake when configured incorrectly.
- Full deterministic validation passes. Live Azure, App-permission,
  environment-bypass, and disposable workflow proof remain separately gated and
  are reported honestly if not run.

## Governing campaign

Parent Pi prepared the living campaign record at
`docs/campaigns/C002-hosted-release-envelope-authority.md`. This runtime spec
reproduces its earned gain, authority fence, invariants, pressure behavior, exit
evidence, and non-goals so execution does not depend on an uncommitted local
artifact. A pod may not relax that contract to finish.

## Stakeholders

- Scruffy service operator
- Maintainers of the controlled GitHub repository and release workflow
- Authorized protected-environment reviewer
- Future publication-workflow owner evaluating whether shadow evidence earns
  greater authority
