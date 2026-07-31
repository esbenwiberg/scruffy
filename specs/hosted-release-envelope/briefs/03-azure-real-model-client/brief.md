---
title: "Wire a keyless Foundry backend and disposable OIDC release client"
touches:
  - src/providers/models/azure-foundry.ts
  - src/providers/models/factory.ts
  - src/server/main.ts
  - package.json
  - package-lock.json
  - infra/azure/main.bicep
  - scripts/deploy-azure-shadow.sh
  - scripts/
  - test/providers/
  - test/server/
  - test/infra/
  - docs/product/azure-shadow-deployment.md
  - docs/product/cd-release-gate.md
  - docs/product/github-app-setup.md
does_not_touch:
  - src/gates/release/decision.ts
  - migrations/
  - live GitHub repository settings
  - live Azure resources
---

## Task

Make the existing Azure shadow deployment capable of running brief 02's hosted
release protocol with an explicitly configured real Microsoft Foundry Claude
backend, and add a disposable GitHub Actions client seam that obtains an OIDC
token and calls that protocol. Prepare deterministic implementation and
infrastructure validation; do not perform paid/model provisioning, permission
changes, deployment, administrator-bypass changes, or live workflow execution
inside the pod.

Replace the current uninstalled/dynamically assumed Foundry path with the
supported official TypeScript Foundry SDK and Microsoft Entra authentication.
Use `DefaultAzureCredential`/managed identity and scope
`https://ai.azure.com/.default`; do not add an API-key secret to Key Vault or the
Container App. Make endpoint/base URL and deployment name explicit deployment
configuration. A configured `SCRUFFY_MODEL_BACKEND=azure` must fail at boot when
SDK/config/auth initialization is unavailable; it must never fall back to fake.
Retain truncation detection and provider/model provenance.

Update Bicep/deployment tooling so the Container App's dedicated identity can be
assigned only the inference role required on an explicitly selected existing
Foundry resource (normally `Cognitive Services User`) and receives the endpoint
and deployment name as non-secret configuration. Keep image pull and Key Vault
identities/permissions separated as today. Parameterize the external Foundry
resource rather than silently purchasing/subscribing to a Marketplace offer.

Add a small controlled client/CLI suitable for a centrally maintained reusable
GitHub workflow. It must request a GitHub OIDC token with the fixed Scruffy
audience, send it only over HTTPS to the configured Scruffy host, submit the
exact repository/range/artifact/environment envelope, retrieve the durable
report, submit rationale/acceptance after the protected-environment gate when
required, and request terminal shadow authorization. It must fail `stop`,
`indeterminate`, authentication mismatch, and envelope mismatch. It never
publishes or deploys.

## Constraints

- Preserve the campaign contract reproduced in the series `purpose.md` and `design.md`; this pod does not grant authority.
- Use official supported SDK packages as normal production dependencies, not an
  indirect dynamic import that is absent from the image.
- Keyless managed identity is the hosted default. Do not add an API key unless a
  separately approved deviation records why official keyless auth is impossible.
- Do not provision a model/Marketplace subscription or spend money.
- Do not activate Azure roles, assign live RBAC, change the GitHub App, disable
  bypass, deploy, or run a live model/workflow from the pod.
- Validate HTTPS origin and never print OIDC JWTs, GitHub tokens, model secrets,
  private report bodies, or approval rationale to uncontrolled logs.
- Do not place GitHub App private key/database credentials in the reusable
  workflow; only the short-lived OIDC token crosses to Scruffy.
- Keep the Container App `authority: shadow-only`, one replica, and zero real
  publication/deployment effects.
- Preserve local fake/Claude/Anthropic test and development backends.

## Test expectations

Create focused tests named:

- `"Azure Foundry managed identity backend"`: the provider requests the exact
  Entra scope, uses configured Foundry base URL/deployment, returns model
  provenance, rejects truncation/empty-invalid responses, and fails loudly on
  missing configuration; no API key is required or read.
- `"Azure shadow real model configuration"`: infrastructure configuration no
  longer hardcodes fake when real mode is selected, passes explicit endpoint and
  deployment, uses managed identity/least-privileged inference role, contains no
  Foundry API-key secret, and preserves shadow-only tags/no deployment effect.
- `"GitHub OIDC release client"`: mocked GitHub token endpoint receives the fixed
  audience; mocked Scruffy calls carry the same exact envelope/report through
  review, optional attestation, and terminal authorization; wrong host,
  `stop`/`indeterminate`, report mismatch, or authorization mismatch fails.
- Existing model-factory/server wiring tests prove `azure` does not silently
  resolve to fake and other backends remain compatible.

The obvious broken model implementation still reads `AZURE_FOUNDRY_API_KEY` or
hardcodes a model/resource; the managed-identity/config tests must fail it. The
obvious broken infra implementation leaves `SCRUFFY_MODEL_BACKEND=fake`; the
infra fact must fail it. The obvious broken client trusts a report body with a
different digest/environment; the end-to-end mocked-envelope mutation must fail
it.

## Operator handoff

Update the runbooks with an explicit, ordered human-gated checklist:

1. choose/provision an eligible Foundry Claude deployment and accept applicable
   Marketplace terms;
2. approve/assign least-privileged managed-identity inference access;
3. approve GitHub App `Actions: read` and update installation permissions;
4. configure service-owned OIDC allowlists and the disposable workflow;
5. review Azure what-if, then separately approve deployment;
6. disable administrator bypass and verify required reviewer configuration;
7. run one disposable `ship` and one human-exception path;
8. verify real model provenance, durable hosted records, full-envelope equality,
   actual reviewer identity, zero SCM/publication/deployment effects, and restore
   safe cadence/configuration.

Commands not run due these gates must be listed, not represented as validation.

## Wrap-up

1. Run focused model, infra, and client facts plus full profile validation.
2. Run an offline Bicep compile/what-if only when credentials/tooling make it
   read-only; do not deploy.
3. Record external gates and exact not-run live commands.
4. Commit and push.
