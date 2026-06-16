/**
 * 任务模式 Agent 共享工具：从 t_prompts 读取 prompt
 *
 * 优先级：customValue > defaultValue > fallback (硬编码)
 */

import u from "@/utils";

const promptCache = new Map<string, string>();

/**
 * 从数据库读取指定 code 的 prompt，未命中则使用 fallback
 */
export async function loadTaskPrompt(code: string, fallback: string): Promise<string> {
  if (promptCache.has(code)) {
    return promptCache.get(code) || fallback;
  }
  try {
    const row = await u.db("t_prompts")
      .where("code", code)
      .select("defaultValue", "customValue")
      .first();
    const custom = String(row?.customValue || "").trim();
    const def = String(row?.defaultValue || "").trim();
    const value = custom || def || fallback;
    promptCache.set(code, value);
    return value;
  } catch (e) {
    console.warn(`[loadTaskPrompt] 读取失败 code=${code}：`, e);
    return fallback;
  }
}

/**
 * 清空 prompt 缓存（设置页保存后调用，避免缓存失效）
 */
export function clearTaskPromptCache(): void {
  promptCache.clear();
}