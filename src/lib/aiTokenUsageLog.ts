import u from "@/utils";
import { getCurrentUserId } from "@/lib/requestContext";

export type AiTokenUsageLogPayload = {
  userId?: number;
  type?: string;
  manufacturer?: string;
  model?: string;
  channel?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  cacheReadPricePer1M?: number;
  amount?: number;
  currency?: string;
  remark?: string;
  meta?: Record<string, unknown> | null;
};

export type AiTokenUsageLogQuery = {
  startTime?: string | number | null;
  endTime?: string | number | null;
  type?: string | null;
  limit?: number | null;
};

export type AiTokenUsageStatsQuery = {
  startTime?: string | number | null;
  endTime?: string | number | null;
  type?: string | null;
  granularity?: string | null;
};

function normalizeText(input: unknown): string {
  return String(input || "").trim();
}

function normalizePositiveNumber(input: unknown): number {
  const value = Number(input || 0);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

function normalizeNonNegativeFloat(input: unknown): number {
  const value = Number(input || 0);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeCurrency(input: unknown): string {
  return normalizeText(input).toUpperCase() || "CNY";
}

function computeUsageAmount(input: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  inputPricePer1M: number;
  outputPricePer1M: number;
  cacheReadPricePer1M: number;
}): number {
  const effectiveInputTokens = Math.max(0, input.inputTokens - input.cacheReadTokens);
  const amount =
    effectiveInputTokens * input.inputPricePer1M / 1_000_000
    + input.outputTokens * input.outputPricePer1M / 1_000_000
    + input.cacheReadTokens * input.cacheReadPricePer1M / 1_000_000;
  return normalizeNonNegativeFloat(amount);
}

function parseTimeFilterValue(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  }
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
  }
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return Math.round(timestamp);
}

function resolveChannel(input: { channel?: string; manufacturer?: string }): string {
  const explicit = normalizeText(input.channel);
  if (explicit) return explicit;
  const manufacturer = normalizeText(input.manufacturer);
  return manufacturer || "unknown";
}

function resolveBucketExpression(granularity: string) {
  if (granularity === "hour") {
    return "strftime('%Y-%m-%d %H:00', createTime / 1000, 'unixepoch', 'localtime')";
  }
  if (granularity === "month") {
    return "strftime('%Y-%m', createTime / 1000, 'unixepoch', 'localtime')";
  }
  return "strftime('%Y-%m-%d', createTime / 1000, 'unixepoch', 'localtime')";
}

export async function writeAiTokenUsageLog(payload: AiTokenUsageLogPayload): Promise<void> {
  const userId = normalizePositiveNumber(payload.userId || getCurrentUserId());
  if (userId <= 0) return;
  const totalTokens = normalizePositiveNumber(payload.totalTokens);
  const inputTokens = normalizePositiveNumber(payload.inputTokens);
  const outputTokens = normalizePositiveNumber(payload.outputTokens);
  const reasoningTokens = normalizePositiveNumber(payload.reasoningTokens);
  const cacheReadTokens = normalizePositiveNumber(payload.cacheReadTokens);
  const inputPricePer1M = normalizeNonNegativeFloat(payload.inputPricePer1M);
  const outputPricePer1M = normalizeNonNegativeFloat(payload.outputPricePer1M);
  const cacheReadPricePer1M = normalizeNonNegativeFloat(payload.cacheReadPricePer1M);
  const currency = normalizeCurrency(payload.currency);
  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0 && reasoningTokens <= 0 && cacheReadTokens <= 0) {
    return;
  }
  const amount = normalizeNonNegativeFloat(
    payload.amount !== undefined
      ? payload.amount
      : computeUsageAmount({
        inputTokens,
        outputTokens,
        cacheReadTokens,
        inputPricePer1M,
        outputPricePer1M,
        cacheReadPricePer1M,
      }),
  );
  await u.db("t_aiTokenUsageLog").insert({
    userId,
    createTime: Date.now(),
    type: normalizeText(payload.type) || "通用文本",
    manufacturer: normalizeText(payload.manufacturer),
    model: normalizeText(payload.model),
    channel: resolveChannel(payload),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
    inputPricePer1M,
    outputPricePer1M,
    cacheReadPricePer1M,
    amount,
    currency,
    remark: normalizeText(payload.remark),
    meta: payload.meta ? JSON.stringify(payload.meta) : "",
  });
}

export async function getAiTokenUsageLogList(query: AiTokenUsageLogQuery) {
  const userId = normalizePositiveNumber(getCurrentUserId());
  const startTime = parseTimeFilterValue(query.startTime);
  const endTime = parseTimeFilterValue(query.endTime);
  const type = normalizeText(query.type);
  const limit = Math.min(Math.max(normalizePositiveNumber(query.limit || 200), 1), 1000);
  const builder = u
    .db("t_aiTokenUsageLog")
    .where("userId", userId)
    .modify((qb: any) => {
      if (startTime) qb.where("createTime", ">=", startTime);
      if (endTime) qb.where("createTime", "<=", endTime);
      if (type) qb.where("type", type);
    })
    .select(
      "id",
      "createTime",
      "type",
      "manufacturer",
      "model",
      "channel",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheReadTokens",
      "totalTokens",
      "inputPricePer1M",
      "outputPricePer1M",
      "cacheReadPricePer1M",
      "amount",
      "currency",
      "remark",
    )
    .orderBy("createTime", "desc")
    .limit(limit);
  const rows = await builder;
  return rows.map((row: any) => ({
    id: normalizePositiveNumber(row.id),
    createTime: normalizePositiveNumber(row.createTime),
    type: normalizeText(row.type),
    manufacturer: normalizeText(row.manufacturer),
    model: normalizeText(row.model),
    channel: normalizeText(row.channel),
    inputTokens: normalizePositiveNumber(row.inputTokens),
    outputTokens: normalizePositiveNumber(row.outputTokens),
    reasoningTokens: normalizePositiveNumber(row.reasoningTokens),
    cacheReadTokens: normalizePositiveNumber(row.cacheReadTokens),
    totalTokens: normalizePositiveNumber(row.totalTokens),
    inputPricePer1M: normalizeNonNegativeFloat(row.inputPricePer1M),
    outputPricePer1M: normalizeNonNegativeFloat(row.outputPricePer1M),
    cacheReadPricePer1M: normalizeNonNegativeFloat(row.cacheReadPricePer1M),
    amount: normalizeNonNegativeFloat(row.amount),
    currency: normalizeCurrency(row.currency),
    remark: normalizeText(row.remark),
  }));
}

export async function getAiTokenUsageStatsList(query: AiTokenUsageStatsQuery) {
  const userId = normalizePositiveNumber(getCurrentUserId());
  const startTime = parseTimeFilterValue(query.startTime);
  const endTime = parseTimeFilterValue(query.endTime);
  const type = normalizeText(query.type);
  const granularity = ["hour", "month"].includes(normalizeText(query.granularity)) ? normalizeText(query.granularity) : "day";
  const bucketExpr = resolveBucketExpression(granularity);
  const rows = await u
    .db("t_aiTokenUsageLog")
    .where("userId", userId)
    .modify((qb: any) => {
      if (startTime) qb.where("createTime", ">=", startTime);
      if (endTime) qb.where("createTime", "<=", endTime);
      if (type) qb.where("type", type);
    })
    .select(
      u.db.raw(`${bucketExpr} as bucketTime`),
      "type",
      "manufacturer",
      "model",
      "channel",
      "currency",
      u.db.raw("sum(inputTokens) as inputTokens"),
      u.db.raw("sum(outputTokens) as outputTokens"),
      u.db.raw("sum(reasoningTokens) as reasoningTokens"),
      u.db.raw("sum(cacheReadTokens) as cacheReadTokens"),
      u.db.raw("sum(totalTokens) as totalTokens"),
      u.db.raw("sum(amount) as amount"),
      u.db.raw("count(1) as callCount"),
    )
    .groupByRaw(`${bucketExpr}, type, manufacturer, model, channel, currency`)
    .orderBy("bucketTime", "desc")
    .orderBy("amount", "desc");

  return rows.map((row: any) => ({
    bucketTime: normalizeText(row.bucketTime),
    type: normalizeText(row.type),
    manufacturer: normalizeText(row.manufacturer),
    model: normalizeText(row.model),
    channel: normalizeText(row.channel),
    currency: normalizeCurrency(row.currency),
    inputTokens: normalizePositiveNumber(row.inputTokens),
    outputTokens: normalizePositiveNumber(row.outputTokens),
    reasoningTokens: normalizePositiveNumber(row.reasoningTokens),
    cacheReadTokens: normalizePositiveNumber(row.cacheReadTokens),
    totalTokens: normalizePositiveNumber(row.totalTokens),
    amount: normalizeNonNegativeFloat(row.amount),
    callCount: normalizePositiveNumber(row.callCount),
    remark: `${normalizePositiveNumber(row.callCount)}次调用`,
  }));
}
