// omo mod-style extension (candidate v4): in-memory patch of the running senpi,
// no file on disk changes. Remove the extension and reload/restart -> stock senpi.
//
// What it changes
// - senpi's session getCompactionModel returns settings `compaction.model` only when
//   the session provider is spent. ExtensionRunner.bindCore is wrapped so the runner's
//   copy returns the override whenever it resolves and has auth; the builtin
//   compaction (hook route, idle/speculative, overflow) then summarizes with it.
//
// Safeguards
// - Same-attempt fallback: dispatchEmit for session_before_compact is re-implemented
//   with the stock loop semantics; only the `<builtin:compaction>` handler is re-run,
//   once, with the session model when its override attempt cancels, throws, returns a
//   deterministic-fallback checkpoint, or trips the watchdog. Other handlers (user
//   PreCompact hooks) run exactly once.
// - Watchdog: the override attempt is aborted when no summary text arrives for
//   OMO_COMPACTION_MODEL_IDLE_MS (default 120 s) or it runs past
//   OMO_COMPACTION_MODEL_MAX_MS (default 300 s); the session model then gets senpi's
//   own full budget.
// - Tool-call guard: summarization requests to a non-Anthropic override drop the
//   forwarded agent tools, because some relays (Ollama) ignore tool_choice "none" and
//   answer the summary prompt with a tool call.
// - Cooldown: after an override failure the session model is used for 30 minutes.
// - Shape guard: missing senpi internals -> no patch, stock behaviour, one receipt line.
// - Kill switch: OMO_COMPACTION_MODEL_PATCH=0.

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ExtensionRunner } from "@code-yeongyu/senpi";

interface ModelLike { provider: string; id: string; api?: string }

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ExtensionLike { path: string; handlers: Map<string, Handler[]> }

interface RunnerLike {
  extensions?: ExtensionLike[];
  createContext?: (path: string) => unknown;
  emitError?: (error: { extensionPath: string; event: string; error: string; stack?: string }) => void;
  getModel?: () => ModelLike | undefined;
  getCompactionSettingsFn?: () => { model?: string } | undefined;
  getCompactionModelFn?: () => ModelLike | undefined;
  updateCompactionFn?: (options: unknown) => unknown;
  modelRegistry?: { find(provider: string, id: string): ModelLike | undefined; hasConfiguredAuth?(model: ModelLike): boolean };
}

interface CompactEvent { type?: string; reason?: string; requestId?: string; signal?: AbortSignal }

interface HandlerResult {
  cancel?: boolean;
  reason?: string;
  compaction?: { details?: { schema?: unknown; failureKind?: unknown } };
}

interface Attempt {
  forceSession: boolean;
  usedOverride?: string;
  lastProgressAt: number;
}

interface PatchState {
  installed: boolean;
  liveGenerations: number;
  cooldownUntil: number;
  attempts: AsyncLocalStorage<Attempt>;
}

const BUILTIN_COMPACTION = "<builtin:compaction>";
const COOLDOWN_MS = 30 * 60_000;
const STATE_KEY = Symbol.for("omo.compaction-model.patch.v4");

const globalStore = globalThis as unknown as Record<symbol, PatchState | undefined>;
const state: PatchState = globalStore[STATE_KEY] ??= {
  installed: false,
  liveGenerations: 0,
  cooldownUntil: 0,
  attempts: new AsyncLocalStorage<Attempt>(),
};

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function receiptPath(): string | undefined {
  if (process.env.OMO_COMPACTION_MODEL_RECEIPT) return process.env.OMO_COMPACTION_MODEL_RECEIPT;
  const agentDir = process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR;
  if (!agentDir) return undefined;
  const logs = join(agentDir, "logs");
  mkdirSync(logs, { recursive: true });
  return join(logs, "omo-compaction-model.jsonl");
}

function receipt(record: Record<string, unknown>): void {
  try {
    const path = receiptPath();
    if (!path) return;
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    // diagnostics only
  }
}

const label = (model: ModelLike | undefined) => (model ? `${model.provider}/${model.id}` : null);

function resolveOverride(runner: RunnerLike, session: ModelLike): ModelLike | undefined {
  const override = runner.getCompactionSettingsFn?.()?.model;
  const slash = typeof override === "string" ? override.indexOf("/") : -1;
  if (!override || slash <= 0) return undefined;
  const model = runner.modelRegistry?.find(override.slice(0, slash), override.slice(slash + 1));
  if (!model || (model.provider === session.provider && model.id === session.id)) return undefined;
  if (runner.modelRegistry?.hasConfiguredAuth && !runner.modelRegistry.hasConfiguredAuth(model)) return undefined;
  return model;
}

function pickModel(runner: RunnerLike, base: () => ModelLike | undefined): ModelLike | undefined {
  const fallback = base();
  if (state.liveGenerations <= 0) return fallback;
  const attempt = state.attempts.getStore();
  if (attempt?.forceSession) return fallback;
  const session = runner.getModel?.();
  // A spent session provider already gets core's own resolution; keep it.
  if (!session || fallback !== session) return fallback;
  if (Date.now() < state.cooldownUntil) return fallback;
  const model = resolveOverride(runner, session);
  if (!model) return fallback;
  if (attempt) attempt.usedOverride = label(model) ?? undefined;
  return model;
}

function canDispatchSafely(runner: RunnerLike): boolean {
  return Array.isArray(runner.extensions) && typeof runner.createContext === "function" && typeof runner.emitError === "function";
}

function wrapRunner(runner: RunnerLike): void {
  const base = runner.getCompactionModelFn;
  if (typeof base === "function" && typeof runner.getModel === "function" && !(base as { omo?: boolean }).omo) {
    const wrapped = () => (canDispatchSafely(runner) ? pickModel(runner, base) : base());
    (wrapped as { omo?: boolean }).omo = true;
    runner.getCompactionModelFn = wrapped;
  }
  const update = runner.updateCompactionFn;
  if (typeof update === "function" && !(update as { omo?: boolean }).omo) {
    const wrapped = (options: unknown) => {
      const attempt = state.attempts.getStore();
      if (attempt) attempt.lastProgressAt = Date.now();
      return update(options);
    };
    (wrapped as { omo?: boolean }).omo = true;
    runner.updateCompactionFn = wrapped;
  }
}

function overrideFailure(result: HandlerResult | undefined): string | undefined {
  if (result?.cancel) return `cancel: ${result.reason ?? "no reason"}`;
  const schema = result?.compaction?.details?.schema;
  if (typeof schema === "string" && schema.includes("deterministic-fallback")) {
    return `deterministic fallback: ${String(result?.compaction?.details?.failureKind ?? "unknown")}`;
  }
  return undefined;
}

async function runBuiltinCompaction(runner: RunnerLike, ext: ExtensionLike, handler: Handler, event: CompactEvent): Promise<unknown> {
  const idleMs = envMs("OMO_COMPACTION_MODEL_IDLE_MS", 120_000);
  const maxMs = envMs("OMO_COMPACTION_MODEL_MAX_MS", 300_000);
  const startedAt = Date.now();
  const first: Attempt = { forceSession: false, lastProgressAt: startedAt };
  const controller = new AbortController();
  const parent = event.signal;
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", forwardAbort, { once: true });

  let tripped: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const now = Date.now();
    const due = Math.min(first.lastProgressAt + idleMs, startedAt + maxMs);
    timer = setTimeout(() => {
      const at = Date.now();
      if (!first.usedOverride) return arm();
      if (at >= startedAt + maxMs) tripped = `watchdog: over ${maxMs} ms`;
      else if (at >= first.lastProgressAt + idleMs) tripped = `watchdog: no summary text for ${idleMs} ms`;
      if (tripped) controller.abort(new Error(tripped));
      else arm();
    }, Math.max(250, due - now));
  };
  arm();

  let result: unknown;
  let thrown: unknown;
  try {
    result = await state.attempts.run(first, () => handler({ ...event, signal: controller.signal }, runner.createContext!(ext.path)));
  } catch (error) {
    thrown = error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", forwardAbort);
  }

  if (!first.usedOverride) {
    if (thrown !== undefined) throw thrown;
    return result;
  }
  const failure = tripped
    ?? (thrown !== undefined ? `threw: ${thrown instanceof Error ? thrown.message : String(thrown)}` : overrideFailure(result as HandlerResult));
  if (!failure) {
    receipt({ patch: "override-summary", requestId: event.requestId, reason: event.reason, model: first.usedOverride, ms: Date.now() - startedAt });
    return result;
  }
  state.cooldownUntil = Date.now() + COOLDOWN_MS;
  if (parent?.aborted) {
    receipt({ patch: "override-failed-caller-aborted", requestId: event.requestId, failure });
    if (thrown !== undefined) throw thrown;
    return result;
  }
  receipt({ patch: "override-failed-retry-session-model", requestId: event.requestId, reason: event.reason, model: first.usedOverride, failure, ms: Date.now() - startedAt });
  const retry: Attempt = { forceSession: true, lastProgressAt: Date.now() };
  const retried = await state.attempts.run(retry, () => handler(event, runner.createContext!(ext.path)));
  receipt({ patch: "session-model-retry-result", requestId: event.requestId, outcome: overrideFailure(retried as HandlerResult) ?? "summary" });
  return retried;
}

async function dispatchSessionBeforeCompact(runner: RunnerLike, event: CompactEvent): Promise<unknown> {
  let result: HandlerResult | undefined;
  for (const ext of runner.extensions!) {
    const handlers = ext.handlers.get("session_before_compact")?.slice() ?? [];
    for (const handler of handlers) {
      try {
        const handlerResult = ext.path === BUILTIN_COMPACTION
          ? await runBuiltinCompaction(runner, ext, handler, event)
          : await handler(event, runner.createContext!(ext.path));
        if (handlerResult) {
          result = handlerResult as HandlerResult;
          if (result.cancel) return result;
        }
      } catch (err) {
        runner.emitError!({
          extensionPath: ext.path,
          event: "session_before_compact",
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
  }
  return result;
}

function installPatch(): void {
  if (state.installed) return;
  if (process.env.OMO_COMPACTION_MODEL_PATCH === "0") {
    receipt({ patch: "disabled-by-env" });
    return;
  }
  const proto = (ExtensionRunner as unknown as { prototype?: Record<string, unknown> })?.prototype;
  const originalBindCore = proto?.bindCore;
  const originalDispatch = proto?.dispatchEmit;
  if (!proto || typeof originalBindCore !== "function" || typeof originalDispatch !== "function") {
    receipt({ patch: "shape-mismatch", bindCore: typeof originalBindCore, dispatchEmit: typeof originalDispatch });
    return;
  }
  proto.bindCore = function patchedBindCore(this: RunnerLike, ...args: unknown[]) {
    const bound = originalBindCore.apply(this, args);
    wrapRunner(this);
    return bound;
  };
  proto.dispatchEmit = function patchedDispatchEmit(this: RunnerLike, event: CompactEvent, ...rest: unknown[]) {
    if (event?.type !== "session_before_compact" || event.reason === "branch" || state.liveGenerations <= 0) {
      return originalDispatch.call(this, event, ...rest);
    }
    if (!canDispatchSafely(this)) {
      return state.attempts.run({ forceSession: true, lastProgressAt: Date.now() }, () => originalDispatch.call(this, event, ...rest));
    }
    return dispatchSessionBeforeCompact(this, event);
  };
  state.installed = true;
  receipt({ patch: "installed" });
}

function stripToolsFromOverrideSummary(event: { payload?: Record<string, unknown> }, ctx: any): unknown {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object" || !("tools" in payload) || state.liveGenerations <= 0) return undefined;
  const override = ctx?.getCompactionSettings?.()?.model;
  const slash = typeof override === "string" ? override.indexOf("/") : -1;
  if (!override || slash <= 0) return undefined;
  const overrideId = override.slice(slash + 1);
  if (payload.model !== overrideId || ctx?.model?.id === overrideId) return undefined;
  const model: ModelLike | undefined = ctx?.modelRegistry?.find?.(override.slice(0, slash), overrideId);
  if (!model || String(model.api ?? "").startsWith("anthropic")) return undefined;
  const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, ...rest } = payload;
  receipt({ patch: "summary-tools-stripped", model: label(model), api: model.api ?? null });
  return rest;
}

export default function omoCompactionModelPatch(pi: {
  on: (event: string, handler: (event: any, ctx: any) => unknown) => void;
}) {
  installPatch();
  if (!state.installed) return;
  state.liveGenerations += 1;
  let released = false;
  pi.on("session_shutdown", () => {
    if (released) return;
    released = true;
    state.liveGenerations -= 1;
  });
  pi.on("before_provider_request", (event, ctx) => stripToolsFromOverrideSummary(event, ctx));
  pi.on("session_start", (_event, ctx) => {
    receipt({ patch: "session-start", sessionModel: label(ctx?.model), compactionModelNow: label(ctx?.getCompactionModel?.()) });
  });
}
