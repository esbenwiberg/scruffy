# Clawpatch Remediation Plan

> STATUS: COMPLETE — all 38 findings across 22 packages fixed on `fix/clawpatch-remediation`.
> Verified: `npm run typecheck` clean, `npm run test` = 234 passing (was 159; +75 new tests), `npm run build` clean.

Generated from a full clawpatch review sweep (25 features, provider=claude). All 38 findings, grouped into 22 file-disjoint work packages (no two edit the same file -> parallel-safe).

## Baseline

- Branch: `fix/clawpatch-remediation` (off `main` @ `90fcb84`)
- Pre-change: `npm run typecheck` clean, `npm run test` = 159 passing (22 files), Postgres healthy
- Findings: **38** -- 2 high, 12 medium, 24 low

## Ground rules

- One owner per package; edit only that package's files.
- Follow each finding's recommendation; add the suggested regression test.
- Type ripples: interface/return-type changes can break callers outside your files -- consolidated typecheck+test runs after all land.

---

## WP01 -- 1 finding(s) [high]

**Files:** `src/persistence/outbox.ts`

### [x] HIGH - concurrency -- claimPending releases its row locks at commit without changing status, so concurrent dispatchers re-claim and double-deliver the same effect
- **findingId:** `fnd_sig-feat-library-a7b49f936c-17f9_9f0b79dab7`
- **Problem:** `for update skip locked` only guarantees exclusivity for the lifetime of the transaction that holds the lock. `claimPending` opens a `withTransaction`, selects pending rows with `skip locked`, bumps `attempts`, then COMMITS and returns — the row status stays `'pending'` and no `lease`/`processing`/`claimed_at` marker is written. Actual delivery and the `markSent`/`markFailed` writes happen afterward on `this.pool`, outside that transaction. Once the claim transaction commits, the locks drop and 
- **Fix:** Make the claim durable across the processing window: within the same transaction that selects with `for update skip locked`, move the rows out of the claimable set (e.g. `update outbox set status='processing', attempts=attempts+1, claimed_at=now() where id = any($1)`) so a concurrent `claimPending` cannot re-select them; then have `markSent`/`markFailed` transition from `'processing'`. Alternative
- **Scope:** src/persistence/outbox.ts: change claimPending (and correspondingly markSent/markFailed guards) so a claim durably removes rows from the pending/claimable set within the claiming transaction.
- **Test:** Insert one pending outbox row, call claimPending(10) twice sequentially without an intervening markSent, and assert the second call returns an empty array (or that the row is no longer in the claimable/pending set), proving a claimed effect cannot be re-claimed before it is marked sent/failed.

---

## WP02 -- 1 finding(s) [high]

**Files:** `src/domain/evidence/types.ts`

### [x] HIGH - security -- SubjectRevision.repository regex is too permissive for its stated URL-interpolation security purpose
- **findingId:** `fnd_sig-feat-library-b54827a5b5-4ebf_df0301267b`
- **Problem:** The comment states this validation is a security boundary, enforced (not just documented) because `repository` is interpolated into `gh api` URL paths where an extra segment or '../' would retarget a different endpoint, and because repository-supplied content is treated as hostile input. The regex `/^[^/\s]+\/[^/\s]+$/` only rejects the literal slash and whitespace. It still accepts a great many URL-dangerous values: a dot-segment such as `owner/..` (no slash inside `..`, so it passes) which, on
- **Fix:** Tighten each segment to the GitHub-legal charset and forbid dot-only segments, e.g. validate owner and name separately against `/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/` with an explicit reject of `.`/`..`, rather than the broad `[^/\s]+`. Keep the single-slash structural check.
- **Scope:** Replace the repository regex in src/domain/evidence/types.ts with a per-segment allowlist that excludes dot-only segments and non-alphanumeric-boundary characters.
- **Test:** Add a schema test asserting SubjectRevision.safeParse rejects 'owner/..', 'owner/name?x=1', 'owner/%2e%2e%2fx', and a repository containing a NUL byte, while accepting 'acme/web'.

---

## WP03 -- 5 finding(s) [medium, low, low, low, low]

**Files:** `package.json`, `src/platform/clock.ts`

### [x] MEDIUM - bug -- FixedClock leaks a shared mutable Date, allowing callers to corrupt the clock's internal state
- **findingId:** `fnd_sig-feat-library-da25a734ad-043d_b457ff16b1`
- **Problem:** JavaScript Date objects are mutable. FixedClock stores the caller-supplied Date by reference in the constructor (this.#current = start) and set() (this.#current = at), and now() returns that same internal reference rather than a defensive copy. This creates two-way aliasing: (1) a caller that retains its reference to the Date passed into the constructor/set can later call start.setTime(...)/setHours(...) and silently move the clock; (2) any consumer of now() receives the live internal Date and, 
- **Fix:** Store and return defensive copies: in the constructor and set() do this.#current = new Date(at.getTime()); in now() return new Date(this.#current.getTime()). This makes FixedClock's now() match SystemClock's fresh-instance semantics and removes the aliasing.
- **Scope:** Add defensive Date copies in FixedClock's constructor, set(), and now() in src/platform/clock.ts.
- **Test:** In a vitest spec: construct FixedClock(new Date(0)); capture a = clock.now(); mutate a.setFullYear(2000); assert clock.now().getTime() === 0. Also mutate the original start Date after construction and assert the clock is unaffected.

### [x] LOW - maintainability -- No lint or format tooling configured for a TypeScript/service codebase
- **findingId:** `fnd_sig-feat-config-7528cb5b98-98687_d9f6cc100b`
- **Problem:** The scripts block defines build, typecheck, test, and numerous tsx entrypoints but no lint or format target, and devDependencies contain no linter (e.g. eslint) or formatter (e.g. prettier). Project detection confirms lint=null and format=null. For a multi-author 'service-controlled review system' that itself performs quality gating, the absence of static-analysis/style enforcement means style and a class of correctness lints are not caught in CI or locally, increasing drift and review burden as
- **Fix:** Add a linter and formatter (e.g. eslint + typescript-eslint, prettier) to devDependencies and expose `lint`/`format` scripts wired into the test/CI flow, so `npm run lint` gives a deterministic quality signal alongside `typecheck` and `test`.
- **Scope:** package.json (add devDependencies and lint/format scripts); optional eslint/prettier config files.

### [x] LOW - test-gap -- Determinism-critical clock/id module has no tests
- **findingId:** `fnd_sig-feat-library-da25a734ad-0543_06aa9f8cec`
- **Problem:** The module header states nothing in the domain may read ambient time or generate random ids directly because reconciliation replay and the harness must be reproducible, and SeededIdGenerator documents a monotonic/deterministic contract. Yet no tests are linked or present to lock in that contract: e.g. that two SeededIdGenerator instances with the same seed and same next() call sequence produce identical ids, that the counter is strictly monotonic, and that FixedClock.advance is additive. Given t
- **Fix:** Add a small vitest spec for SeededIdGenerator (same seed + sequence => identical ids; monotonic counter) and FixedClock (now/advance/set behavior), so the reproducibility contract is enforced by CI.
- **Scope:** Add a vitest spec covering SeededIdGenerator determinism/monotonicity and FixedClock advance/set; no source change required for this item.
- **Test:** clock.spec.ts asserting new SeededIdGenerator('s').next('x') === new SeededIdGenerator('s').next('x') for a matched call sequence, and that consecutive next() calls increase the numeric suffix.

### [x] LOW - build-release -- build script never cleans prior output, so stale compiled artifacts survive source renames/deletes
- **findingId:** `fnd_sig-feat-release-51170e0f9c-f7be_7e44f3f486`
- **Problem:** The build script is `tsc -p tsconfig.json` with no preceding clean step (e.g. `rimraf dist`). `tsc` only writes/overwrites outputs for currently-existing source files; it never deletes emitted files whose source was renamed or removed. Over repeated builds this leaves orphaned `.js`/`.d.ts` (and, if incremental, `.tsbuildinfo`) artifacts in the output directory. If any consumer resolves modules from the compiled output, it can load stale code that no longer corresponds to source — a classic buil
- **Fix:** Add a clean step before compilation, e.g. `"build": "rimraf dist && tsc -p tsconfig.json"` (or `"prebuild": "rimraf dist"`), so each build starts from an empty output directory. Ensure tsconfig defines a dedicated `outDir` that is safe to wipe.
- **Scope:** Edit the `build` script in package.json (line 11) to prepend a clean of the output directory, or add a `prebuild` script.
- **Test:** A CI check that runs the build, deletes/renames a source file, rebuilds, and asserts the corresponding orphaned artifact no longer exists in the output directory.

### [x] LOW - data-loss -- db:down destroys database volumes with `docker compose down -v`
- **findingId:** `fnd_sig-feat-test-suite-84ae84a25a-4_8cd8e30d62`
- **Problem:** The `db:down` script passes `-v` to `docker compose down`, which removes named and anonymous volumes associated with the compose project. If the local Postgres data is stored in a named volume (the paired `db:up` starts a `db` service and then runs `wait-for-db`, implying a persistent DB), running `db:down` irreversibly deletes all local database contents rather than just stopping the container. A developer expecting `down` to merely stop the stack can lose local data. This is a dev-workflow haz
- **Fix:** Split the destructive reset into a separate, clearly named script (e.g. `db:reset` = `docker compose down -v`) and make `db:down` a non-destructive `docker compose down`, so accidental data loss requires explicitly opting in.
- **Scope:** Rename/duplicate the `db:down` script in package.json to separate volume-destroying reset from plain teardown.

---

## WP04 -- 5 finding(s) [medium, medium, low, low, low]

**Files:** `src/corpus/all-run.ts`, `src/corpus/grounded-run.ts`, `src/corpus/run.ts`, `src/corpus/seeded.ts`, `test/corpus/grounded.test.ts`, `test/corpus/replay.test.ts`

### [x] MEDIUM - test-gap -- SEEDED_CORPUS regression pins and schema conformance are never exercised by the test suite
- **findingId:** `fnd_sig-feat-library-19eb41a200-829d_1033334369`
- **Problem:** The vitest suite (test/corpus/replay.test.ts) only imports and replays SYNTHETIC_CORPUS: the schema-conformance test parses SYNTHETIC_CORPUS (line 14) and every replayCorpus call passes SYNTHETIC_CORPUS (lines 18, 43, 55). A repository-wide search confirms SEEDED_CORPUS is referenced by no test file. Yet SEEDED_CORPUS carries the project's most security-critical regression pins: 'seeded-hardcoded-aws-key-in-config' expects `block` and 'seeded-intentional-column-removal' expects `indeterminate`, 
- **Fix:** Add a vitest case that (a) runs `Corpus.parse(SEEDED_CORPUS)` for schema conformance and (b) calls `replayCorpus([...SYNTHETIC_CORPUS, ...SEEDED_CORPUS], deps)` asserting `r.regressions` is empty and `r.confusion.false_block === 0`, mirroring the pass criteria in all-run.ts so the seeded regression pins run under CI.
- **Scope:** Add one test in test/corpus/replay.test.ts importing SEEDED_CORPUS; no production code change required.
- **Test:** In test/corpus/replay.test.ts, add: it('the seeded corpus conforms and produces no regressions/false-blocks', async () => { expect(() => Corpus.parse(SEEDED_CORPUS)).not.toThrow(); const r = await replayCorpus([...SYNTHETIC_CORPUS, ...SEEDED_CORPUS], deps); expect(r.confusion.false_block).toBe(0); e

### [x] MEDIUM - build-release -- grounded-run.ts exit gate omits poison false-block and nightly false-surface despite printing them as 'Safety checks'
- **findingId:** `fnd_sig-feat-library-aca16b5178-3798_4f5824bb83`
- **Problem:** grounded-run prints 'Safety checks:' with poison.confusion.false_block and nightly.totals.falseSurface (lines 77-78), implying they gate the run. But the failure condition only checks `regressions.length > 0 || release.metrics.unsafeShips > 0` (line 87). It never references false_block or falseSurface. Today these are caught indirectly because GROUNDED_POISON_CORPUS pins expectedOutcome:'allow' and GROUNDED_NIGHTLY_CORPUS pins expectedSummary, so a false-block/false-surface would register as a r
- **Fix:** Make the grounded-run exit condition explicitly include the printed safety metrics: fail when `poison.confusion.false_block > 0` or `nightly.totals.falseSurface > 0`, matching all-run.ts, so the gate matches the 'Safety checks' label rather than relying on regression pins.
- **Scope:** src/corpus/grounded-run.ts: broaden the failure condition to include poison false_block and nightly falseSurface.
- **Test:** A test that runs replay-style with an injected false-block/false-surface case lacking a regression pin and asserts the grounded sweep's failure condition trips (process.exitCode === 1).

### [x] LOW - bug -- Malformed unified-diff hunk header in the seeded mixed-commit type edit
- **findingId:** `fnd_sig-feat-library-19eb41a200-8297_5999de9b6f`
- **Problem:** The order.ts patch declares hunk header `@@ -10,7 +10,6 @@` but the body contains only 4 context lines and 1 deletion: old-side length is 4+1=5 (not 7) and new-side length is 4+0=4 (not 6). Unlike the other patches, this one is hand-written rather than built via newFile(), so the counts were not derived. Most unified-diff parsers ignore header counts and process only +/- markers, so this likely produces no finding either way (the case expects no finding, and there are no added lines). But a stri
- **Fix:** Correct the hunk header to reflect the actual body, e.g. `@@ -10,5 +10,4 @@ export interface Order {`, or rebuild the patch through a helper that computes counts. Once SEEDED_CORPUS is under test, a strict parse would surface any remaining mismatch.
- **Scope:** Edit the hunk header string in src/corpus/seeded.ts lines 73.
- **Test:** Covered by the seeded-corpus replay test proposed above, which would parse and replay this case through the real analyzer pipeline.

### [x] LOW - test-gap -- grounded-run.ts CI gate (exit-code logic) has no test coverage
- **findingId:** `fnd_sig-feat-library-825247a8fb-0c99_07f7d1e757`
- **Problem:** `npm run corpus:grounded` is wired as a gate that must exit non-zero on regression or unsafe ship (grounded-run.ts:81-94, and the header comment promises this). The test suite validates the corpus data and the replay reports independently, but imports only from grounded.js — never grounded-run.ts. The runner's fail signal relies solely on the aggregated `regressions` arrays plus `release.metrics.unsafeShips`; notably the nightly per-case 'MISHANDLED' verdict it computes at line 69 does NOT feed 
- **Fix:** Add a test that invokes the runner's decision logic (extract the regression/exit computation into an exported pure function) and assert exit is non-zero whenever any nightly case is MISHANDLED (correct !== 1 || falseSurface !== 0), not only when a summary regression is recorded.
- **Scope:** Extract and test the pass/fail decision in grounded-run.ts:81-94; no data-model change needed.
- **Test:** Feed a nightly result with correct=0 but a matching summary into the runner's fail-decision helper and assert it reports failure.

### [x] LOW - maintainability -- grounded-run.ts prints hardcoded per-case reassurance strings decoupled from the actual gate outcome
- **findingId:** `fnd_sig-feat-library-825247a8fb-3b46_be6694adb4`
- **Problem:** The per-case report prints the real value (p.outcome / r.outcome) padded next to a CONSTANT parenthetical. Lines 71 and 73 always emit "(out of blocking scope; no false-block)" and "(human sign-off; no silent ship, no fabricated stop)" regardless of what the gate actually decided. Only the nightly line (72) derives its label from the result (n.correct/n.falseSurface). So if poison ever regressed to a block, the runner would print a self-contradictory line like `block   (out of blocking scope; no
- **Fix:** Derive the parenthetical from the actual outcome (or at minimum only print the reassuring claim when p.outcome === "allow" / r.outcome === "sign-off-required"), mirroring how the nightly line already computes its label.
- **Scope:** grounded-run.ts lines 70-74 only.
- **Test:** Extract the per-case line formatting into a pure function and assert that a synthetic regressed poison result does not render the 'no false-block' claim.

---

## WP05 -- 3 finding(s) [medium, low, low]

**Files:** `src/gates/nightly/decision.ts`, `src/gates/nightly/fix.ts`, `src/gates/nightly/service.ts`

### [x] MEDIUM - data-loss -- fixBranch path slugging can alias distinct findings into one branch/externalId, silently dropping a fix PR
- **findingId:** `fnd_sig-feat-library-66792f4ffe-7088_36414cd104`
- **Problem:** fixBranch collapses every non-alphanumeric run in the path to a single '-' (path.replace(/[^a-zA-Z0-9]+/g, "-")). Two genuinely distinct paths with the same defectClass and startLine can slug to an identical branch — e.g. 'src/a.b.ts' and 'src/a-b.ts' both become 'src-a-b-ts', producing branch 'scruffy/fix/<class>/src-a-b-ts-L<line>'. In service.ts each fix PR effect is pushed with externalId: fix.branch, and the code comment at fix.ts:54 explicitly states the branch is 'the PR idempotency key'.
- **Fix:** Make the branch (idempotency key) injective over (defectClass, path, startLine). Either append a short stable hash of the raw path to the slug, or use a JSON/hash-based externalId for the pull_request effect distinct from the human-readable branch name, mirroring the JSON-encoding already used in dispositionKey.
- **Scope:** src/gates/nightly/fix.ts (fixBranch, and/or the externalId chosen for pull_request effects in service.ts)
- **Test:** In fix.test.ts, call generateFixes with two propose_fix findings of the same defectClass and startLine but distinct paths that slug identically (e.g. 'src/a.b.ts' and 'src/a-b.ts'); assert the two resulting fixes have different branch/externalId values.

### [x] LOW - maintainability -- A fixable-class finding that is not also listed as reportable is silently suppressed, contradicting the documented propose_fix contract
- **findingId:** `fnd_sig-feat-library-66792f4ffe-4465_640bbb4fed`
- **Problem:** The kernel doc (point 1) states propose_fix is earned when 'the finding must be a fixable class, adversarially validated, AND carry deterministic support' — it says nothing about the reportable list. But classify() returns suppress/not_reportable_class first if the class is absent from policy.reportableDefectClasses, before the fixable branch is ever reached. So a defect class configured only in fixableDefectClasses (not also in reportableDefectClasses) is silently suppressed and never fixed nor
- **Fix:** Either (a) document/enforce that fixableDefectClasses must be a subset of reportableDefectClasses (validate at policy load), or (b) treat membership in fixableDefectClasses as implying reportability so a fixable class is never suppressed by the reportable-class gate.
- **Scope:** src/gates/nightly/decision.ts (classify) and/or NightlyPolicy validation/docs.
- **Test:** Add a decision.test.ts case with a policy where a class is in fixableDefectClasses but absent from reportableDefectClasses, and assert the expected disposition (propose_fix per documented contract, or an explicit documented suppress).

### [x] LOW - api-contract -- generateFixes recomputes the summary but never re-sorts dispositions after downgrading propose_fix -> report, violating the 'ranked most-actionable first' contract
- **findingId:** `fnd_sig-feat-library-66792f4ffe-942e_aed49aae27`
- **Problem:** NightlyDecision documents dispositions as 'One entry per finding, ranked most-actionable first', and evaluateNightly sorts by DISPOSITION_PRIORITY (propose_fix=0 < report=1). generateFixes maps over the already-sorted dispositions and downgrades unpatchable propose_fix entries to report (reason fix_unavailable), then recomputes the summary via summarize(...) but does NOT re-sort. A downgraded entry keeps its front-of-list position where it was ranked as a propose_fix, so a fix_unavailable 'repor
- **Fix:** After building the downgraded dispositions, re-apply the same deterministic sort used in evaluateNightly (or factor that sort into a shared helper and call it here) before returning the adjusted decision.
- **Scope:** src/gates/nightly/fix.ts (generateFixes) — re-sort dispositions before returning.
- **Test:** Construct two fixable propose_fix findings, register a fixer that patches only one of them, and assert that after generateFixes the surviving propose_fix is ranked before the downgraded fix_unavailable report.

---

## WP06 -- 2 finding(s) [medium, low]

**Files:** `src/effects/dispatcher.ts`, `src/effects/pull-request.ts`, `test/effects/dispatcher.test.ts`

### [x] MEDIUM - test-gap -- pull_request effect path (payload parse + input mapping) is entirely untested
- **findingId:** `fnd_sig-feat-library-409c9c5701-e8a5_170eabd87f`
- **Problem:** The dispatcher test suite exercises only the check_run branch (happy path, transient failure, retry exhaustion) and the unknown-effect-type path. The pull_request branch in #apply (dispatcher.ts:70-74), the PullRequestPayload zod schema, and the toPullRequestInput field-by-field mapping are never dispatched. In the test's FlakyWriter, openPullRequest unconditionally throws "not supported" (test lines 47-49) and no test enqueues an effect with effectType = pull_request. Because toPullRequestInput
- **Fix:** Add a dispatcher test that enqueues a pull_request effect with a valid PullRequestPayload and asserts openPullRequest receives the fully-mapped PullRequestInput (all edit fields intact) and the row is marked sent; add a malformed-payload case (e.g. empty edits) asserting a permanent dead-letter, mirroring the existing unknown-effect-type test.
- **Scope:** Add pull_request test cases to test/effects/dispatcher.test.ts (extend the FlakyWriter to record openPullRequest calls). No production code change required.
- **Test:** In dispatcher.test.ts, add: it('dispatches a pull_request effect with fully-mapped input') that inserts an outbox row with effect_type='pull_request' and a valid payload (subject, externalId, branch, title, body, edits:[{path,startLine,endLine,replacement}]), uses a writer capturing openPullRequest 

### [x] LOW - bug -- Batch isolation guarantee is bypassed when outbox mark* calls throw
- **findingId:** `fnd_sig-feat-library-409c9c5701-4731_5f85b612ea`
- **Problem:** The module docstring (lines 15-19) states error isolation is load-bearing: a throw 'must never abort the batch' so a poison-pill at the front cannot starve effects behind it. #apply upholds this because #write swallows write errors. However, the outbox.markSent (line 46) and outbox.markFailed (lines 50, 53) calls run in the loop body outside any try/catch. If one of those store writes throws (a DB blip), dispatchOnce rejects and the remaining claimed records in that batch are not processed on th
- **Fix:** Wrap the per-record mark/side-effect handling in dispatchOnce in a try/catch (or a small helper) so a failing markSent/markFailed is logged and contained to that record, preserving the documented 'never abort the batch' invariant across the entire loop, not just #apply.
- **Scope:** Wrap the mark handling inside the for-loop of dispatchOnce (dispatcher.ts:44-57) in try/catch; no interface changes needed.
- **Test:** Add a test with a stub OutboxStore whose markSent throws on the first call, enqueue two check_run effects, and assert dispatchOnce does not reject and the second effect is still attempted (or at minimum both remain pending for the next pass).

---

## WP07 -- 2 finding(s) [medium, medium]

**Files:** `src/providers/scm/fake.ts`, `src/providers/scm/gh-cli.ts`, `src/providers/scm/port.ts`

### [x] MEDIUM - api-contract -- Null-base range review resolves an associated PR and compares against its base, contradicting the port contract of returning the head's own change set
- **findingId:** `fnd_sig-feat-library-423f55ea84-3e61_8e27c972bb`
- **Problem:** The port documents that when RevisionRange.baseSha is null (a branch's first-ever review) the adapter returns 'the head candidate's own change set' (port.ts 18-27), and the inline comment at gh-cli.ts 152-154 reasserts 'Use the head commit's own change set'. But the null-base branch delegates to getChangedFiles(headSha), which first calls #associatedPrBase and, if the head commit is the head of any OPEN PR, re-enters getChangedFilesInRange with baseSha = the PR base and returns the full base...h
- **Fix:** For the null-base range case, call the commit's own file list directly (the fallback body of getChangedFiles) rather than delegating to getChangedFiles, so PR resolution is bypassed and the contract holds. Alternatively, factor the 'commit's own files' logic into a private method both paths can call without triggering #associatedPrBase.
- **Scope:** gh-cli.ts getChangedFilesInRange null-base branch (lines 150-155).
- **Test:** Call getChangedFilesInRange({ baseSha: null, headSha: HEAD }) with a stub whose /pulls handler returns an open PR; assert no /compare call is made and only the commit's own files are returned.

### [x] MEDIUM - api-contract -- GhCliScm.upsertCheckRun always reports created:true and ignores externalId, diverging from the port's idempotency contract enforced by FakeScm
- **findingId:** `fnd_sig-feat-library-423f55ea84-ea6a_cf074df403`
- **Problem:** The port defines upsertCheckRun as 'Idempotent upsert keyed by (subject, externalId)' and CheckRunResult.created as 'True when this call created a new check run; false when it matched an existing one' (port.ts 40-41, 48-52, 82-83). FakeScm honors this precisely to let the harness assert that duplicate delivery does not produce duplicate effects (fake.ts 16-20, 48-60). The real GhCliScm adapter hardcodes created:true (gh-cli.ts 215) and never consults externalId; it keys idempotency implicitly on
- **Fix:** Either make GhCliScm derive `created` honestly (query existing status for (sha, context) and report false on supersede) or, if statuses genuinely have no prior-existence signal, tighten the port contract/docstring and audit every caller that branches on `created` so the real adapter's always-true value cannot cause duplicate side effects. At minimum document that `created` is not meaningful for th
- **Scope:** gh-cli.ts upsertCheckRun return value (lines 210-216) and/or the port docstring for CheckRunResult/ScmWriter.
- **Test:** Add a test posting the same CheckRunInput twice through GhCliScm and assert the documented created semantics (or, if intentional, a test pinning created:true with a comment that the effects layer must not rely on it), mirroring the FakeScm duplicate-delivery assertion.

---

## WP08 -- 2 finding(s) [medium, low]

**Files:** `src/app/scruffy.ts`, `src/domain/evaluation/types.ts`

### [x] MEDIUM - api-contract -- runNightly does not parse/validate the range `base` sha at the boundary, unlike runRelease which validates prevRelease
- **findingId:** `fnd_sig-feat-library-aca16b5178-6f4b_ca2420ca47`
- **Problem:** The runNightly doc comment states the intent explicitly: 'The head is parsed through SubjectRevision so a malformed sha is rejected at the boundary, not deep in the DB.' But only `head` is parsed. `input.base` is forwarded verbatim (`...(input.base !== undefined ? { base: input.base } : {})`) with no SubjectRevision.parse or sha validation. The sibling method runRelease deliberately validates BOTH shas — `input.prevRelease == null ? null : SubjectRevision.parse({..., commitSha: input.prevRelease
- **Fix:** Parse `base` at the boundary the same way runRelease parses prevRelease: `const base = input.base == null ? null : SubjectRevision.parse({ repository: input.repository, commitSha: input.base }).commitSha;` and pass the normalized value through, so a malformed base is rejected at the boundary with a clear error.
- **Scope:** src/app/scruffy.ts runNightly: parse input.base through SubjectRevision before forwarding to nightly.review.
- **Test:** Add a unit test asserting runNightly rejects a non-40-hex `base` with a boundary (SubjectRevision) validation error, mirroring an equivalent test for runRelease's prevRelease, using fakes for the store/services.

### [x] LOW - bug -- flushEffects loops on dispatchOnce with no progress/iteration guard
- **findingId:** `fnd_sig-feat-library-fc23de9113-98eb_b2ea3cc3ce`
- **Problem:** flushEffects repeats `sent = await dispatchOnce()` while sent > 0, trusting dispatchOnce to eventually return 0. If dispatchOnce reports a count for effects it attempted but could not remove from the outbox (e.g. a permanently-failing effect that is re-counted each batch), the loop never terminates and hot-spins. Even absent that, there is no upper bound on iterations, so a large/continuously-refilled outbox blocks the caller indefinitely in a single flush call.
- **Fix:** Base the loop-continue condition on effects actually drained/acknowledged (return 0 when nothing was removed), or add a max-iterations / max-total cap so a poison-pill effect cannot spin the loop forever.
- **Scope:** Adjust the loop termination condition in Scruffy.flushEffects (src/app/scruffy.ts) to depend on real progress or a bounded iteration count.
- **Test:** With a dispatcher whose dispatchOnce returns a positive count but leaves the same effect pending, assert flushEffects terminates (via a progress-based condition or iteration cap) rather than looping forever.

---

## WP09 -- 2 finding(s) [medium, low]

**Files:** `src/providers/registry.ts`

### [x] MEDIUM - test-gap -- Registry MUST-invariants (blockable→validator, fixable→fixer) are comment-only, unenforced by types or tests
- **findingId:** `fnd_sig-feat-library-fda1ef4de0-7d46_0fdec5377b`
- **Problem:** The file documents two hard invariants: 'Each blockable class MUST have a registered validator' (lines 19, 22-26 vs 73-79) and 'every class in NIGHTLY_FIXABLE_CLASSES must have a fixer here' (lines 82-84 vs 86-89). Both are maintained only by hand-matching string literals across separate declarations. defaultValidator() returns the widened `Validator` type and defaultFixers() returns `Record<string, Fixer>`, so the compiler never checks that the map keys cover POISON_BLOCKABLE_CLASSES / NIGHTLY_
- **Fix:** Enforce the invariants at the type level and/or with a guard test. Type level: type defaultValidator's map as `Record<(typeof POISON_BLOCKABLE_CLASSES)[number], Validator>` and defaultFixers as `Record<(typeof NIGHTLY_FIXABLE_CLASSES)[number], Fixer>` so a missing key is a compile error. Additionally add a registry test asserting every POISON_BLOCKABLE_CLASS has a validator and every NIGHTLY_FIXAB
- **Scope:** Narrow the return-type annotations of defaultValidator/defaultFixers in src/providers/registry.ts to keyed Records over the corresponding const arrays; optionally add a registry coverage test.
- **Test:** A vitest spec importing POISON_BLOCKABLE_CLASSES, NIGHTLY_FIXABLE_CLASSES, defaultValidator, defaultFixers and asserting: for each blockable class the validator resolves a non-undefined validator, and for each fixable class defaultFixers()[class] is defined.

### [x] LOW - test-gap -- Documented disjointness of RELEASE_STOP_CLASSES and RELEASE_SIGNOFF_CLASSES is not guarded
- **findingId:** `fnd_sig-feat-library-fda1ef4de0-2a69_2aae36eda5`
- **Problem:** Lines 54 and 56-57 assert 'The lists are disjoint,' but RELEASE_SIGNOFF_CLASSES splices in MODEL_DEFECT_CLASSES, which is defined in another module and could evolve to include a stop-class string. If overlap were introduced, a finding could match both the hard-stop and the sign-off path, and downstream release-gate logic that assumes disjointness would behave ambiguously (stop vs escalate). Nothing in the excerpt enforces the disjointness. Confidence is low because I cannot confirm the current M
- **Fix:** Add a lightweight test (or a compile-time assertion) that RELEASE_STOP_CLASSES and RELEASE_SIGNOFF_CLASSES share no members, so future edits to MODEL_DEFECT_CLASSES cannot silently break the invariant.
- **Scope:** Add a disjointness assertion test for the two release-class arrays.
- **Test:** A vitest spec asserting RELEASE_STOP_CLASSES.every(c => !RELEASE_SIGNOFF_CLASSES.includes(c)).

---

## WP10 -- 1 finding(s) [medium]

**Files:** `tsconfig.json`

### [x] MEDIUM - build-release -- Build emits test/ and scripts/ into dist and nests output under dist/src due to rootDir "."
- **findingId:** `fnd_sig-feat-config-0c1c23856a-952c7_fe9f10a12c`
- **Problem:** rootDir is set to "." while include lists "src", "test", and "scripts" and outDir is "dist". A plain `tsc` build therefore treats the project root as the emit root, producing dist/src/**, dist/test/**, and dist/scripts/** rather than dist/** rooted at src. Two concrete consequences: (1) With declaration:true and sourceMap:true, compiled JS, .d.ts, and .map files for the test suite and build scripts are emitted into the dist artifact — test code and helper scripts get shipped/packaged, bloating t
- **Fix:** Decide the intended emit root explicitly. If dist is a library artifact, set rootDir to "src" and restrict emit to source only (e.g. use a separate build tsconfig that includes only ["src"], or add "exclude" for test/scripts, keeping the root tsconfig with the broader include for typecheck/editor only). This yields dist/index.js and prevents test/script code and their .d.ts files from being emitte
- **Scope:** tsconfig.json (introduce a build-specific rootDir/include or exclude test+scripts from emit)
- **Test:** Add a build smoke check (CI step or test) that runs the production build and asserts the expected entry file exists at the path package.json points to (e.g. dist/index.js and dist/index.d.ts) and that dist/test and dist/scripts are absent.

---

## WP11 -- 1 finding(s) [medium]

**Files:** `src/providers/models/factory.ts`, `src/providers/models/fake.ts`

### [x] MEDIUM - bug -- Unrecognized SCRUFFY_MODEL_BACKEND silently falls back to the fake, yielding an empty (no-findings) review
- **findingId:** `fnd_sig-feat-library-85789c61b2-a0c8_388a4ae15d`
- **Problem:** resolveBackend() only accepts the four literal strings and otherwise returns "fake". A misconfigured or misspelled operator value (e.g. SCRUFFY_MODEL_BACKEND=claudecli, anthropic-cli, or AZURE) does not error — it silently selects FakeModelProvider, whose complete() returns "" for any unknown promptVersion. Downstream that empty text parses to "no findings", indistinguishable from a clean review. This directly contradicts the design intent expressed in the sibling adapters (anthropic-cli.ts / az
- **Fix:** In an operator-facing context, treat an unrecognized non-empty SCRUFFY_MODEL_BACKEND as a hard error rather than silently defaulting: keep the default-to-fake behavior only when the variable is unset/empty, and throw `unknown SCRUFFY_MODEL_BACKEND '<value>'` otherwise so a typo fails loudly.
- **Scope:** resolveBackend() in src/providers/models/factory.ts.
- **Test:** Set SCRUFFY_MODEL_BACKEND to an invalid string and assert resolveBackend()/createModelProvider() throws; assert it still returns fake when the variable is unset.

---

## WP12 -- 1 finding(s) [medium]

**Files:** `src/app/reconciler.ts`

### [x] MEDIUM - bug -- A single throwing run aborts the entire reconciliation pass (head-of-line starvation)
- **findingId:** `fnd_sig-feat-library-fc23de9113-fada_293f47be5e`
- **Problem:** reconcileOnce iterates candidates and awaits reclaimExpired, #drive, and #abandon with no per-run try/catch. Any rejection (e.g. a transient model/DB error inside poison.evaluate, nightly.reconcile, or release.reconcile) propagates out of the whole pass, so every candidate ordered after the failing one is skipped for that tick and the `acted` count is lost. Because findReconcilable(limit) returns a deterministic ordering, a run that fails consistently (permanent bad subject, poison-pill payload)
- **Fix:** Wrap the per-run body (reclaim/drive/abandon) in a try/catch inside the for-loop so a failing run is logged/counted and skipped without aborting the pass; optionally advance/park the failing run so it does not perpetually head the candidate list.
- **Scope:** Add a try/catch around the loop body in Reconciler.reconcileOnce in src/app/reconciler.ts.
- **Test:** Given two reconcilable runs where the first gate call rejects, assert reconcileOnce still attempts/drives the second run (and does not throw), i.e. the failure of one run does not prevent progress on others.

---

## WP13 -- 2 finding(s) [low, low]

**Files:** `src/corpus/release-replay.ts`, `src/corpus/release-run.ts`, `test/corpus/release-replay.test.ts`

### [x] LOW - test-gap -- `overCaution` safety metric is never exercised or asserted by any test
- **findingId:** `fnd_sig-feat-library-6e1660d6ad-9896_6e3b957278`
- **Problem:** `overCaution` is computed only for `c.truthOutcome === "ship"` cases whose outcome is stop/sign-off. Every seeded ship case (`release-ship-clean`) actually ships, so overCaution is always 0 in the seeded corpus. The one test that appears to target it (its comment at lines 47-48 says it will 'flag the ... as over-caution') actually flips a ship range's truth to `stop`, which produces an unsafeShip, not over-caution — and it only asserts `unsafeShips === 1`. No test ever constructs a truth=ship / 
- **Fix:** Add a test that tampers a ship-truth range so the gate output is stop/sign-off (or asserts `metrics.overCaution === 0` for the untampered seeded corpus and `=== 1` for a tampered case), and fix the misleading comment in the existing test which describes over-caution while asserting unsafeShips.
- **Scope:** Add/adjust one test case in test/corpus/release-replay.test.ts and correct the comment; no production code change required.
- **Test:** In release-replay.test.ts, map SEEDED_RELEASE_CORPUS flipping a genuinely-stopped range's truthOutcome to 'ship' and assert `r.metrics.overCaution === 1`; also assert the untampered run yields `overCaution === 0`.

### [x] LOW - maintainability -- Release run prints "No regressions" success message even after an unsafe-ship FAIL
- **findingId:** `fnd_sig-feat-library-6e1660d6ad-ad96_264e95516e`
- **Problem:** The unsafe-ship check and the regression check are independent branches. When `unsafeShips > 0` but `regressions.length === 0`, the run prints the FAIL line for unsafe ships and then, in the regression `else`, prints 'No regressions against expected outcomes.' as the final line. The exit code is correctly set to 1, but an operator scanning the tail of the output sees a reassuring success message immediately after a hard failure, which can mask the failure in CI logs or scrollback.
- **Fix:** Gate the 'No regressions' success message on overall run health (e.g. only print it when `process.exitCode` is not already 1), or emit a single consolidated PASS/FAIL summary line at the end that reflects both unsafe ships and regressions.
- **Scope:** Reorder/guard the final console.log in release-run.ts main() so the success message only prints when the run has no failures.
- **Test:** Refactor the summary emission into a pure function returning the lines/exit code given a report, then unit-test that an unsafeShips>0 report yields FAIL and no misleading 'No regressions' success line.

---

## WP14 -- 2 finding(s) [low, low]

**Files:** `scripts/review-pr.ts`

### [x] LOW - bug -- review-pr.ts: gh API JSON responses are consumed without any shape validation
- **findingId:** `fnd_sig-feat-library-710c9f5545-3f6e_5a32c1f88f`
- **Problem:** `gh()` returns `JSON.parse(out)` typed as `any`, and the result is immediately dereferenced as `pr.head.sha` (line 61) under a compile-time-only type annotation. If the gh response ever lacks `head` (e.g. an error object returned with exit code 0, or an unexpected payload), `pr.head.sha` throws a `TypeError` that bypasses the descriptive catch block (which only wraps the `gh(...)` call, not the `.head.sha` access), producing a confusing crash instead of the intended 'could not read PR' message. 
- **Fix:** Validate the parsed PR payload (e.g. reuse zod like `SubjectRevision`) or guard `pr?.head?.sha` and emit the same friendly error before dereferencing.
- **Scope:** scripts/review-pr.ts line 61: guard/validate `pr.head?.sha` before use.
- **Test:** Inject a fake `gh` returning a payload without `head` and assert the friendly error path (exit 1) is taken rather than an uncaught TypeError.

### [x] LOW - bug -- review-pr.ts: DB pool created and migrated outside the try/finally, so it is never closed on a migrate failure
- **findingId:** `fnd_sig-feat-library-710c9f5545-baa2_11afd71bc0`
- **Problem:** `createPool()` (line 64) and `await migrate(pool)` (line 65) run before the `try { … } finally { await pool.end() }` block that begins at line 83. The `finally` that closes the pool only guards work from line 83 onward. If `migrate(pool)` throws (bad DATABASE_URL, schema/permission error, transient connection drop), the open pool is never `end()`-ed and `main()` rejects. Combined with `await main()` at line 123 having no `.catch`, the rejection surfaces as an unhandled promise rejection with the
- **Fix:** Move the `createPool()`/`migrate()` calls inside the try block (or widen the try to start immediately after `createPool()`), so the existing `finally { await pool.end() }` covers migration failures too. Optionally add a `.catch()` to `await main()` that sets a non-zero exit code.
- **Scope:** scripts/review-pr.ts lines 64-83: relocate pool creation/migration inside the try that already ends the pool in finally.
- **Test:** Unit-test a small extraction of the setup/teardown where `migrate` is stubbed to throw and assert `pool.end()` is invoked exactly once.

---

## WP15 -- 1 finding(s) [low]

**Files:** `vitest.config.ts`

### [x] LOW - concurrency -- fileParallelism:false does not serialize test.concurrent cases, weakening the stated Postgres-isolation guarantee
- **findingId:** `fnd_sig-feat-config-57f59ddd1e-25955_b444f29bca`
- **Problem:** The comment states the intent is to keep Postgres-backed tests serial because they share a single database. `fileParallelism: false` only prevents multiple test *files* from running in parallel; it does not prevent tests declared with `test.concurrent`/`describe.concurrent` from running concurrently within a file, nor `--maxConcurrency` grouping. If any current or future test uses the concurrent API, it would run against the shared DB simultaneously and defeat the stated isolation goal, producin
- **Fix:** Document the constraint that `test.concurrent` must not be used until per-worker schemas exist, or enforce it (e.g. a lint rule / eslint-plugin-vitest no-concurrent rule). Consider `sequence: { concurrent: false }` plus `maxConcurrency: 1` and/or `poolOptions.threads.singleThread` to make the serialization intent explicit and robust rather than relying solely on file-level parallelism being off.
- **Scope:** vitest.config.ts (add explicit maxConcurrency/sequence settings) plus a short comment/lint guard; no test code change required.
- **Test:** Add a meta/lint check that fails CI if `.concurrent` appears in any Postgres-backed test file while the shared-database mode is active.

---

## WP16 -- 1 finding(s) [low]

**Files:** `src/providers/fixers/tls-fixer.ts`

### [x] LOW - bug -- JS/Go TLS transforms lack a trailing word boundary on the boolean literal, so an identifier beginning with false/true can be corrupted
- **findingId:** `fnd_sig-feat-library-33820734e5-6a83_51da0b3b8a`
- **Problem:** The Python transform deliberately anchors its value with a trailing word boundary (`False\b`) and a leading one (`\bverify`). The JS (`false`) and Go (`true`) transforms have no trailing boundary. Because `replace` rewrites the whole primaryRegion snippet, if the matched value is the prefix of a longer identifier (e.g. `rejectUnauthorized: falseByDefault` or `InsecureSkipVerify: trueFallback`), the fixer would rewrite it to `trueByDefault` / `falseFallback`, silently breaking a variable referenc
- **Fix:** Add a trailing boundary to the JS and Go value tokens for parity with the Python transform, e.g. `/(rejectUnauthorized\s*:\s*)false\b/i` and `/(InsecureSkipVerify\s*:\s*)true\b/`, so the flip can never extend into a longer identifier.
- **Scope:** Append `\b` after the `false`/`true` literals in the TLS.REJECT_UNAUTHORIZED_FALSE and TLS.GO_INSECURE_SKIP_VERIFY regexes in src/providers/fixers/tls-fixer.ts.
- **Test:** Add a case asserting `fixer.propose(finding("TLS.REJECT_UNAUTHORIZED_FALSE", "rejectUnauthorized: falseByDefault"))` does not rewrite the identifier (either returns null or leaves `falseByDefault` intact).

---

## WP17 -- 1 finding(s) [low]

**Files:** `src/corpus/grounded.ts`

### [x] LOW - maintainability -- sha() comment claims a 'per-spec prefix' guarantees no collisions, but the prefix is a constant
- **findingId:** `fnd_sig-feat-library-825247a8fb-5333_aea4edd905`
- **Problem:** The comment on sha() states 'Distinct per-spec prefix so grounded shas never collide across corpora,' but every caller passes the same literal prefix "a". The actual non-collision invariant is enforced entirely by hand-chosen numeric offsets (100+i for poison/detection subjects, 200+i for base, 300+i for head). That real mechanism is undocumented, and nightly and release deliberately reuse identical base/head offsets. Because the stated rationale (prefix) is false, a maintainer adding a third co
- **Fix:** Fix the comment to describe the real invariant (distinct numeric offset bands per corpus), or actually parameterize the prefix per corpus so the code matches the comment.
- **Scope:** grounded.ts:52 comment (and optionally thread a real prefix through the sha() call sites).
- **Test:** Assert that the union of all subject/base/head shas across GROUNDED_POISON/NIGHTLY/RELEASE corpora has no unintended duplicates beyond the intended poison==detection sharing.

---

## WP18 -- 1 finding(s) [low]

**Files:** `src/providers/models/anthropic-cli.ts`, `src/providers/models/claude-cli.ts`

### [x] LOW - test-gap -- claude-cli backend cannot detect truncation, unlike its sibling adapters
- **findingId:** `fnd_sig-feat-library-85789c61b2-4fd4_9839056e5b`
- **Problem:** Both SDK-based adapters explicitly throw when stop_reason === "max_tokens" to avoid a truncated response silently parsing to "no findings". The claude-cli adapter has no equivalent guard: `claude -p` returns only text and exit code, so a length-truncated completion is returned as a normal success and would under-report findings the same way the sibling comment warns against. This is an inherent limitation of the CLI (it does not expose stop_reason), but it is an undocumented inconsistency in the
- **Fix:** Document that the claude-cli backend cannot detect truncation (so it is unsuitable for high-assurance gates), or have callers validate that the returned text is complete/parseable JSON before trusting a 'no findings' result.
- **Scope:** Documentation/comment in src/providers/models/claude-cli.ts, or a completeness check where its output is consumed.
- **Test:** Spawn a stub binary that emits a partial/invalid completion and exits 0; assert the caller treats it as untrustworthy rather than as an empty finding set.

---

## WP19 -- 1 finding(s) [low]

**Files:** `src/providers/models/azure-foundry.ts`

### [x] LOW - bug -- Azure Foundry loader's bare catch reports every dynamic-import failure as 'package not installed'
- **findingId:** `fnd_sig-feat-library-85789c61b2-9324_0c4a9e1309`
- **Problem:** The `catch {}` around `await import(FOUNDRY_PACKAGE)` discards the actual error and unconditionally throws "requires the '@anthropic-ai/foundry-sdk' package to be installed". Dynamic import can fail for reasons other than a missing module — a broken transitive dependency, an ESM/CJS resolution error, or a throwing top-level side effect in the package. In those cases the message is misleading and the operator loses the real diagnostic, making a deployed-backend failure hard to debug.
- **Fix:** Capture the caught error and either distinguish ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND from other failures, or attach the original error (e.g. `{ cause: err }`) so the underlying reason survives.
- **Scope:** The catch block in AzureFoundryModelProvider.create in src/providers/models/azure-foundry.ts.
- **Test:** Stub the dynamic import to reject with a non-'not found' error and assert create() surfaces the original cause rather than the generic 'not installed' message.

---

## WP20 -- 1 finding(s) [low]

**Files:** `src/corpus/nightly-replay.ts`, `src/domain/findings/identity.ts`

### [x] LOW - maintainability -- nightly-replay match key uses ':'-join that identity.ts explicitly rejects as ambiguous
- **findingId:** `fnd_sig-feat-library-aca16b5178-b421_10646ffa53`
- **Problem:** nightly-replay builds its (defectClass, path) match key with `${defectClass}::${path}`. The domain identity module deliberately JSON-encodes its key components precisely because a delimiter-join aliases distinct inputs ('a space-join would alias `"a b" 1` with `"a" "b 1"`'). The same aliasing exists here: defectClass 'x', path 'a::b' collides with defectClass 'x::a', path 'b'. In practice corpus defect classes are controlled slugs and paths rarely contain '::', so the current risk is theoretical
- **Fix:** Use the same JSON.stringify keying approach as domain/findings/identity.ts (e.g. `JSON.stringify([defectClass, path])`) so the scoring key is unambiguous and consistent with the domain convention.
- **Scope:** src/corpus/nightly-replay.ts: replace the delimiter-join key with a JSON-encoded key.
- **Test:** Add a replay case with a path containing '::' and assert the expected finding still matches its counterpart (no false-surface/miss).

---

## WP21 -- 1 finding(s) [low]

**Files:** `src/domain/policy/types.ts`

### [x] LOW - api-contract -- Documented cross-list policy invariants are not enforced by the schemas
- **findingId:** `fnd_sig-feat-library-b54827a5b5-45ae_02f47936a3`
- **Problem:** Two invariants are stated as MUST/keep-disjoint requirements but nothing in the schemas enforces them. NightlyPolicy says 'Every fixable class MUST also be reportable', yet fixableDefectClasses and reportableDefectClasses are independent arrays; a fixable class absent from reportable would silently produce fix proposals for a defect class that is otherwise suppressed. ReleasePolicy says to keep stopDefectClasses and signoffDefectClasses disjoint, but overlap is accepted; the resolution ('stop wi
- **Fix:** Add zod `.refine`/`.superRefine` checks: NightlyPolicy must assert fixableDefectClasses ⊆ reportableDefectClasses; ReleasePolicy should either reject stop/signoff overlap or document that overlap is intentionally normalized, with the normalization applied at parse time.
- **Scope:** Add refinement predicates to NightlyPolicy and ReleasePolicy in src/domain/policy/types.ts; no consumer changes required.
- **Test:** Add schema tests asserting NightlyPolicy rejects a fixable class not present in reportable, and ReleasePolicy rejects (or normalizes) a class listed in both stop and signoff.

---

## WP22 -- 1 finding(s) [low]

**Files:** `src/providers/validation/migration-validator.ts`

### [x] LOW - maintainability -- MigrationValidator ESCALATE set is dead code — both branches return the same value
- **findingId:** `fnd_sig-feat-library-c7561ef6aa-c113_d0faa1cee5`
- **Problem:** The ESCALATE set (DROP_TABLE, DROP_COLUMN) is checked on line 28 and returns "indeterminate", but the default fall-through on line 29 also returns "indeterminate". The ESCALATE branch is therefore functionally dead: any rule not in CONFIRMED yields "indeterminate" regardless of ESCALATE membership. This is harmless today, but it silently masks intent: if someone later changes the default to a different outcome, or expects ESCALATE to be distinguishable, the set gives a false sense that DROP oper
- **Fix:** Either remove the ESCALATE set and its branch (documenting that unknown/DROP rules escalate by default), or give ESCALATE a distinct observable effect so the two paths are not interchangeable. If kept for documentation, add a comment or test pinning the intended semantics.
- **Scope:** Remove or differentiate the ESCALATE branch in src/providers/validation/migration-validator.ts.
- **Test:** Add a test asserting CONFIRMED rule ids map to "validated" and every other rule id (including unknown ones) maps to "indeterminate", making the intended contract explicit.

---
