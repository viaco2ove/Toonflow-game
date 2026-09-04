/**
 * 任务模式 Agent 共享工具：读取 prompt
 *
 * 优先级：t_prompts.customValue > def.prompts.ts 默认值 > fallback (硬编码)
 */

import { getPromptByCode } from "@/lib/promptHelper";

const promptCache = new Map<string, string>();

/**
 * 读取指定 code 的 prompt，未命中则使用 fallback
 */
export async function loadTaskPrompt(code: string, fallback: string): Promise<string> {
  if (promptCache.has(code)) {
    return promptCache.get(code) || fallback;
  }
  try {
    const value = await getPromptByCode(code);
    const finalValue = value || fallback;
    promptCache.set(code, finalValue);
    return finalValue;
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