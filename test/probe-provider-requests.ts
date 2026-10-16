import { appendFileSync } from "node:fs";

function log(record: Record<string, unknown>): void {
  const path = process.env.OMO_COMPACTION_MODEL_RECEIPT;
  if (path) appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), probe: true, ...record })}\n`);
}

export default function probe(pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const registry = ctx.modelRegistry;
    if (!registry || registry.__omoProbe) return;
    registry.__omoProbe = true;
    const original = registry.getApiKeyAndHeaders.bind(registry);
    registry.getApiKeyAndHeaders = async (model: any) => {
      log({ event: "getApiKeyAndHeaders", model: model ? `${model.provider}/${model.id}` : null });
      return original(model);
    };
  });
  pi.on("before_provider_request", async (event: any, ctx: any) => {
    const model = event.model ?? ctx.model;
    const payload = event.payload ?? {};
    log({
      event: "before_provider_request",
      model: model ? `${model.provider}/${model.id}` : null,
      payloadModel: payload.model ?? null,
      toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
      toolChoice: payload.tool_choice ?? null,
    });
    return undefined;
  });
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    log({
      event: "session_before_compact(probe, runs last)",
      reason: event.reason,
      requestId: event.requestId,
      sessionModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      ctxGetCompactionModel: (() => { const m = ctx.getCompactionModel?.(); return m ? `${m.provider}/${m.id}` : null; })(),
      toSummarize: event.preparation?.messagesToSummarize?.length,
    });
    return undefined;
  });
  pi.on("session_compact", async (event: any) => {
    log({
      event: "session_compact",
      accepted: event.accepted,
      rejectionCause: event.rejectionCause ?? null,
      fromExtension: event.fromExtension ?? null,
      details: event.compactionEntry?.details ?? null,
      summaryHead: event.compactionEntry?.summary?.slice(0, 160) ?? null,
    });
    return undefined;
  });
}
