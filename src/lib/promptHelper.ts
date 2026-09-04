/**
 * Prompt 读取 helper
 *
 * 新的读取顺序（取代旧的 t_prompts.customValue || t_prompts.defaultValue）：
 *   1) t_prompts.customValue  （用户在前端编辑覆盖的，保留 t_prompts 表的用户编辑能力）
 *   2) DEFAULT_PROMPTS[code]  （代码里的默认值，def.prompts.ts 统一管理）
 *   3) 空字符串
 *
 * 旧行为里 t_prompts.defaultValue 字段被 fixDB 反复 update，新行为下：
 *   - 代码侧：永不读取 t_prompts.defaultValue
 *   - 数据库侧：defaultValue 列保留写入但只是历史展示用
 *   - 修改默认提示词：只改 src/lib/def.prompts.ts，不需要发版数据库迁移
 */
import u from "@/utils";
import { DEFAULT_PROMPTS } from "@/lib/def.prompts";

/**
 * 同步读取：仅查 def.prompts.ts 的默认值（不查数据库）。
 * 用于已经 import 了 def.prompts.ts 的代码路径，例如 build-time 编译路径。
 */
export function getDefaultPrompt(code: string): string {
  return DEFAULT_PROMPTS[code] ?? "";
}

/**
 * 异步读取单个 prompt：
 *   customValue 优先，否则用 def.prompts.ts 的默认。
 */
export async function getPromptByCode(code: string): Promise<string> {
  const custom = await loadCustomValue(code);
  if (custom) return custom;
  return getDefaultPrompt(code);
}

/**
 * 批量读取多个 code 的 prompt 值，返回 Map<code, value>。
 * 缺值返回空字符串，不抛错。
 */
export async function loadPromptsByCodes(codes: string[]): Promise<Map<string, string>> {
  if (!codes || codes.length === 0) return new Map();
  const uniqueCodes = Array.from(new Set(codes));
  const rows = (await u
    .db("t_prompts")
    .whereIn("code", uniqueCodes)
    .select("code", "customValue")
    .catch(() => [])) as Array<{ code: string; customValue: string | null }>;
  const customMap = new Map<string, string>();
  for (const row of rows) {
    const v = String(row.customValue || "").trim();
    if (v) customMap.set(String(row.code), v);
  }
  const result = new Map<string, string>();
  for (const code of uniqueCodes) {
    result.set(code, customMap.get(code) || getDefaultPrompt(code));
  }
  return result;
}

async function loadCustomValue(code: string): Promise<string> {
  if (!code) return "";
  try {
    const row = (await u
      .db("t_prompts")
      .where("code", code)
      .select("customValue")
      .first()
      .catch(() => null)) as { customValue?: string | null } | null;
    return String(row?.customValue || "").trim();
  } catch {
    return "";
  }
}