---
slug: claude-cli-completion-integrity
reported_at: 2026-07-26
severity: medium
status: fix-ready
affected_packages:
  - scruffy
---

## Symptom

The opt-in `claude-cli` model backend treats any `claude -p` process that exits
zero as a successful model completion. Because it requests plain-text output,
it discards the CLI's terminal metadata and cannot distinguish a complete reply
from one stopped at an output limit or for another non-terminal reason.

No real truncated Scruffy review has been observed. This is a latent fail-open
condition raised by a review agent, not a production incident. A deterministic
stub demonstrates the unsafe adapter behavior, while a live probe demonstrates
that the current CLI provides the metadata needed to close it.

The invocation also leaves Claude Code's agent tools and ambient project/user
configuration available even though `ModelProvider.complete()` expects a pure
prompt-in/text-out operation. Untrusted review input therefore reaches an
agentic process with capabilities the analyzer does not need.

Steps to reproduce:

1. Construct `ClaudeCliModelProvider` with an executable stub that prints a
   partial response and exits zero.
2. Call `complete()`.
3. Observe that the provider returns the partial response as a normal success.
4. Separately run `claude -p --output-format json --tools '' --no-session-persistence`
   with a small prompt on Claude Code 2.1.220.
5. Observe a JSON envelope containing `result`, `stop_reason`, `is_error`, and
   `subtype`; the live probe returned `stop_reason: "end_turn"`.

Frequency: always for a zero-exit stub; real max-token frequency unknown and not reproduced
Environment: local/dev `claude-cli` backend only

## Regression

The raw-text, exit-code-only behavior has existed since the provider was
introduced in commit `deab542`. Commit `bc6c50d` documented and tested the
incorrect assumption that `claude -p` cannot expose `stop_reason`, turning the
latent gap into an intentionally pinned limitation rather than closing it.

The current live CLI is Claude Code 2.1.220. Scruffy does not pin a minimum
Claude Code version. The fix should target the current structured-output
contract and fail closed when an older or incompatible CLI omits required
completion metadata.

## Location

- `src/providers/models/claude-cli.ts:42-53` — invokes only `-p`, then returns
  trimmed raw stdout after exit zero.
- `src/providers/models/claude-cli.ts:18-29` — documents the now-disproved claim
  that the CLI cannot expose `stop_reason`.
- `test/providers/claude-cli.test.ts:41-78` — pins acceptance of partial output as
  expected behavior.
- `src/providers/analyzers/model-analyzer.ts:215-238` — converts provider throws
  into an explicit `provider_unavailable` coverage gap, the safe downstream
  outcome for a rejected incomplete envelope.
- `src/providers/validation/model-validator.ts:93-108` — converts provider throws
  into `failed` validation, also fail-closed.

## Root Cause

The adapter assumes process exit status is the complete model-call contract.
That assumption is too weak: process success only says the CLI ran successfully,
not that the model reached a terminal, trustworthy completion. The adapter
chooses the CLI's default text output even though current Claude Code supports a
JSON result envelope carrying `stop_reason` and `result`.

A second contract mismatch is that the adapter invokes an agentic coding CLI
with ambient built-in/MCP capabilities for a port that requires only a model
completion. Prompt fencing reduces instruction-following risk but is not a
capability boundary. The CLI reference states that `--tools ""` disables
built-in tools but does not disable MCP tools; those need separate exclusion or
strict MCP configuration.

## Blast Radius

- `ModelAnalyzer` can silently under-report if a partial reply happens to contain
  a shorter schema-valid findings array. Invalid partial JSON already becomes an
  explicit `unparseable_output` gap.
- `ModelValidator` can misclassify an interrupted but schema-valid partial result;
  malformed output safely becomes `failed`.
- Default Claude Code tools, MCP servers, hooks, plugins, and repository/user
  instructions add local side-effect and nondeterminism risk around untrusted
  review input.
- The backend is opt-in and documented for local development. Tests, harnesses,
  deterministic corpus runs, and deployed Azure operation do not use it by
  default, limiting exposure.
- SDK-based Anthropic and Azure adapters are unaffected; both explicitly use
  `max_tokens: 4096` and reject `stop_reason === "max_tokens"`. The CLI adapter
  sets no token cap; the live Opus 5 envelope reported a model maximum output of
  64,000 tokens.

## Fix

**Proposed:** invoke Claude Code in structured JSON mode with tools and MCP access
disabled. Parse and validate the result envelope, returning only its `result`
for a successful terminal completion. Reject max-token, tool-use, error,
malformed, missing-metadata, and other non-terminal envelopes so existing callers
record an abstention/coverage gap. Isolate the scripted invocation from ambient
Claude Code customization where the current CLI can do so without losing the
authenticated session.

At minimum, the argument contract should request `--output-format json`, pass
`--tools ""`, and prevent ambient MCP tools (for example with strict empty MCP
configuration). Any stronger safe-mode flag must preserve the backend's defining
property: reuse of the user's authenticated Claude Code session.

**Risk:** low to medium — the source change is localized and failures already
flow to safe downstream outcomes. The main compatibility risk is older Claude
Code versions or future envelope changes; those should fail closed with a useful
error rather than silently reverting to raw-text trust. Isolation flags can vary
by CLI version and therefore need an argv contract test plus a current-CLI smoke
check during implementation.

**Alternatives considered:**

- Keep text output and validate only the returned JSON: rejected because a
  shorter truncated findings array can itself be valid JSON.
- Accept envelopes without `stop_reason` for backward compatibility: rejected
  because it recreates the exact fail-open condition.
- Run a live 64,000-token truncation experiment: rejected as costly and
  unnecessary; deterministic envelope tests can pin the adapter contract.
- Switch this backend to the Anthropic SDK: rejected because `claude-cli` exists
  specifically to reuse the interactive CLI authentication path.

**Watch out for:**

- `--tools ""` does not disable MCP tools by itself.
- A zero exit code and `subtype: "success"` are not sufficient: Claude Code issue
  reports include a successful envelope with `stop_reason: "tool_use"` and an
  empty result.
- Do not parse findings in this provider. It should validate transport/completion
  integrity and leave analyzer-specific schemas to existing consumers.
- Preserve timeout, output-size bounds, UTF-8 decoding, stderr bounds, non-zero
  exit handling, and EPIPE handling.

## Evidence

- Live local probe, Claude Code 2.1.220 (2026-07-26): structured output included
  `result: "[]"`, `stop_reason: "end_turn"`, `is_error: false`, and
  `subtype: "success"`.
- Official Claude Code headless documentation:
  https://code.claude.com/docs/en/headless
- Official CLI flag reference, including JSON output and tool/MCP restrictions:
  https://code.claude.com/docs/en/cli-reference
- Reported successful non-terminal `tool_use` envelope:
  https://github.com/anthropics/claude-code/issues/40432
