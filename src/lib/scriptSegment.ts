import type { Knex } from "knex";
import u from "@/utils";

export interface ScriptSegmentInput {
  sort: number;
  title: string;
  content: string;
  summary?: string;
  startAnchor?: string;
  endAnchor?: string;
}

export interface ScriptSegmentRow extends ScriptSegmentInput {
  id: number;
  scriptId: number;
  projectId: number;
  createTime: number;
  updateTime: number;
}

function cleanText(value: string) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function toTitle(segmentText: string, index: number) {
  const firstLine = cleanText(segmentText)
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean);
  if (!firstLine) return `片段${index}`;
  const compact = firstLine.replace(/^[#*\-•\d.、\s【\[（(]+/, "").replace(/[】\]）)]$/, "").trim();
  return compact.slice(0, 24) || `片段${index}`;
}

function toSummary(segmentText: string) {
  const normalized = cleanText(segmentText).replace(/\n+/g, " ");
  if (!normalized) return "";
  const sentence = normalized.split(/[。！？!?]/).map((item) => item.trim()).find(Boolean);
  return (sentence || normalized).slice(0, 80);
}

function pickAnchor(segmentText: string, position: "start" | "end") {
  const lines = cleanText(segmentText)
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  return position === "start" ? lines[0].slice(0, 60) : lines[lines.length - 1].slice(0, 60);
}

function splitByHeading(content: string): string[] {
  const lines = cleanText(content).split("\n");
  const chunks: string[][] = [];
  let current: string[] = [];

  const isHeading = (line: string) =>
    /^(?:第[一二三四五六七八九十百零\d]+[幕场集章节回]|场景[：:\s]|\[场景|\【场景|※|#)/.test(line.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length > 0 && current[current.length - 1] !== "") current.push("");
      continue;
    }
    if (isHeading(trimmed) && current.length > 0) {
      chunks.push(current);
      current = [];
    }
    current.push(trimmed);
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((item) => item.join("\n")).filter(Boolean);
}

function splitByParagraph(content: string): string[] {
  return cleanText(content)
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeSmallChunks(chunks: string[], targetCount: number): string[] {
  if (chunks.length <= targetCount) return chunks;
  const totalLength = chunks.reduce((sum, item) => sum + item.length, 0);
  const targetLength = Math.max(160, Math.floor(totalLength / targetCount));
  const merged: string[] = [];
  let current = "";

  for (const chunk of chunks) {
    const next = current ? `${current}\n\n${chunk}` : chunk;
    if (current && next.length > targetLength && merged.length < targetCount - 1) {
      merged.push(current);
      current = chunk;
    } else {
      current = next;
    }
  }
  if (current) merged.push(current);
  return merged;
}

export function buildScriptSegments(content: string, targetCount?: number): ScriptSegmentInput[] {
  const normalized = cleanText(content);
  if (!normalized) return [];

  const headingChunks = splitByHeading(normalized);
  const baseChunks = headingChunks.length >= 2 ? headingChunks : splitByParagraph(normalized);
  const roughChunks = baseChunks.length > 0 ? baseChunks : [normalized];

  const desiredCount = Number.isFinite(targetCount)
    ? Math.max(2, Math.min(12, Math.trunc(Number(targetCount))))
    : Math.max(4, Math.min(8, Math.ceil(normalized.length / 700)));
  const chunks = mergeSmallChunks(roughChunks, desiredCount);

  return chunks
    .map((item) => cleanText(item))
    .filter(Boolean)
    .map((item, index) => ({
      sort: index + 1,
      title: toTitle(item, index + 1),
      content: item,
      summary: toSummary(item),
      startAnchor: pickAnchor(item, "start"),
      endAnchor: pickAnchor(item, "end"),
    }));
}

export async function getScriptSegments(scriptId: number) {
  return (await u.db("t_scriptSegment").where({ scriptId }).orderBy("sort", "asc").select("*")) as ScriptSegmentRow[];
}

export async function replaceScriptSegments(
  knexOrDb: Knex | typeof u.db,
  scriptId: number,
  projectId: number,
  segments: ScriptSegmentInput[],
) {
  const now = Date.now();
  const executor = knexOrDb as any;
  await executor("t_scriptSegment").where({ scriptId }).delete();

  if (segments.length === 0) return [];

  const maxIdResult = (await executor("t_scriptSegment").max("id as maxId").first()) as { maxId?: number } | undefined;
  let nextId = Number(maxIdResult?.maxId || 0) + 1;
  const rows = segments.map((item) => ({
    id: nextId++,
    scriptId,
    projectId,
    sort: item.sort,
    title: item.title,
    content: item.content,
    summary: item.summary || "",
    startAnchor: item.startAnchor || "",
    endAnchor: item.endAnchor || "",
    createTime: now,
    updateTime: now,
  }));
  await executor("t_scriptSegment").insert(rows);
  return rows as ScriptSegmentRow[];
}
