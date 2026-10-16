# compaction-model-always - isolated receipt (2026-10-17)

## Cause (installed senpi 2026.10.16, dist/core)
- agent-session.js:7674 `getCompactionModel: () => this.model && this._retryFallback.isProviderSpent(this.model.provider) ? this._resolveCompactionModel(this.model) : this.model`
  -> extensions see the override only when the session provider is spent.
- builtin compaction (extensions/builtin/compaction/index.js:532) handles `session_before_compact` and generates with `ctx.model`; speculative.js:143 picks `context.getCompactionModel?.() ?? snapshot.model`.
- core _compact (agent-session.js:6292) resolves the override, but only uses it when no handler returned a compaction (the builtin always does).
- Load order: builtins first, user extensions after (resource-loader.js orderedExtensions.unshift(...factoryExtensions)); runner.dispatchEmit keeps the last non-cancel result.

## Candidate
- candidate/omo-compaction-model.ts: user-extension handler after the builtin; summarizes with settings compaction.model via ctx.modelRegistry.complete and returns it. Any failure -> undefined (builtin session-model summary kept).
- Known cost: builtin still generates its own session-model summary first (2 summary requests per compaction).

## Isolated runs (temp agent dir, deleted after each run; RPC, manual /compact = hook route)
- run-03 (PASS): receipt.jsonl line outcome=override-summary, summaryModel=<override-model>, responseModel=<override-model>; ctx.getCompactionModel() reported <session-model> (the session model); session_compact accepted, details.summaryModel=<override-model>.
- run-02 (fallback evidence): without models-store.json the override did not resolve ("model not found"); compaction still accepted with the builtin session-model summary (origin core-route).

## v2 (mod-style in-memory patch) - candidate/omo-compaction-model-v2.ts
- Wraps ExtensionRunner.prototype.bindCore (imported from the running bundle via "@code-yeongyu/senpi") so runner.getCompactionModelFn returns compaction.model when it resolves and has auth. No file on disk changes; extension removed + reload/restart = stock (liveness counter).
- One summary request per compaction (builtin itself uses the override; no double call).
- run-05-v2 (PASS): override-selected <override-model>; only auth lookup at compaction = <override-model>; ctx.getCompactionModel() = <override-model>; builtin summary schema senpi.compaction.summary.v1 accepted.
- run-04-v2 (request went to the override model, but it answered with a tool call - stopReason toolUse - so builtin applied its deterministic fallback checkpoint; accepted, detail reduced). After this run a cooldown on deterministic fallback was added (not re-run: failure is intermittent).

## v3 (v2 + safeguards) - candidate/omo-compaction-model-v3.ts  <- recommended
- Same-attempt fallback: ExtensionRunner.prototype.dispatchEmit wrapped for session_before_compact (AsyncLocalStorage per attempt). If the override was used and the result is cancel or deterministic-fallback, the dispatch re-runs once with the session model. Cooldown 30 min after an override failure. Shape guard (no patch if bindCore/dispatchEmit missing). Kill switch OMO_COMPACTION_MODEL_PATCH=0. Liveness counter for removal.
- run-06-v3-fail (PASS): override omo-test-dead/dead (temp-only dead provider) -> "cancel: compaction generator failed: Connection error." -> retry with <session-model> -> real summary (schema summary.v1) accepted. Delay ~7 s.
- run-08-v3-ok (PASS): only auth lookup at compaction = <override-model>; patch override-summary; summary.v1 accepted; 0 extension_error.
- run-09-v3-killswitch (PASS): OMO_COMPACTION_MODEL_PATCH=0 -> disabled-by-env; summary used <session-model> (stock behaviour).
- run-07-v3-ok: rejected stale-revision - test-driver race (compact sent before prompt 2 finished); driver fixed to wait for agent_idle after the prompt's own user message; run-08 is the rerun.
- Limits: a retry re-runs every session_before_compact handler (user PreCompact hooks run twice on failure); a hanging override waits up to compaction.summarizationMaxDurationMs (900000 ms in live settings) before fallback; shape guard not exercised against a changed senpi.

## v4 (closes v3 limits) - candidate/omo-compaction-model-v4.ts  <- recommended
- Cause of the run-04 empty summary: builtin forwards the agent tools in the summary request (cache-friendly prefix) and already retries once with toolChoice "none" after a toolUse reply (speculative.js toolUseRetrySpent); the override's OpenAI-compatible relay still answered with a tool call, so the summary was empty -> deterministic checkpoint.
- Fix: before_provider_request handler drops tools/tool_choice from summary requests addressed to a non-Anthropic override (payload.model == override id, session model differs). The summary request is prepared through runner.prepareProviderRequest -> emitBeforeProviderRequest, so extensions can rewrite it.
- Hang fix: watchdog aborts the override attempt (derived signal) after 120 s without summary text or 300 s total (env OMO_COMPACTION_MODEL_IDLE_MS / OMO_COMPACTION_MODEL_MAX_MS); progress comes from wrapping runner.updateCompactionFn. Stock limits were 300 s idle / settings max 900 s.
- Double-hook fix: dispatchEmit for session_before_compact re-implements the stock loop; only <builtin:compaction> is retried. Shape guard: if runner.extensions/createContext/emitError are missing the stock dispatch runs with the session model.
- run-10-v4-ok (PASS): summary payload to <override-model> carried 0 tools; override-summary 1462 ms; summary.v1 accepted; 0 extension_error.
- run-11-v4-hang (PASS): temp-only TCP server that never answers; watchdog (8 s in test) tripped at 8002 ms; session-model retry summary accepted; probe (another session_before_compact handler) ran once.
- run-12-v4-dead (PASS): connection refused -> builtin cancel after its own retries (6.8 s) -> session-model retry summary accepted; probe ran once.
- Not verified: automatic threshold/overflow triggers in a real long session (tests used manual /compact on the same hook route), shape guard against a changed senpi, removal by reload in the same process, the v4 kill switch (same code as v3, run-09).

## v4 automatic trigger + retry check (2026-10-17)
- run-15-v4-auto (PASS): no /compact sent. Temp-only models.json set <session-model> contextWindow 72000 (start minimum 63213); two prompts with ~20k-token logs. senpi started compaction itself (compaction_start reason "extension" = builtin idle/speculative route). Auth lookup + summary payload went to <override-model> with 0 tools; accepted, summary.v1, saved 18237 of 32348 tokens. 0 extension_error. (EXIT=1 is the driver's auto-mode exit code, not a failure.)
- run-13/14: driver bugs (window below start minimum; turn-end matcher missed escaped newlines). Fixed; run-15 is the rerun.
- Retry: builtin already retries transient summary errors MAX_SUMMARIZATION_ATTEMPT_RETRIES = 3 times (summarization-retry.js, base delay 1 s, total budget half the attempt budget), on the override model too. run-12-v4-dead shows 4 requests to the dead model (1 + 3 retries) before the session-model fallback. Not retried by design: idle/stream timeouts, empty summary, credential failover.
- Idle/speculative route does not pass through the hook dispatch, so the v4 watchdog and same-attempt fallback do not wrap it; a failure there applies nothing and the later hook route (wrapped) compacts.
