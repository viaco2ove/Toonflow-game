/**
 * 两种导入方式
 * import {
 *   WORLD_BOOK_ACTIVATED_MAX_ENTRIES,
 *   WORLD_BOOK_STICKINESS_DEFAULT
 * } from "@/constants/gobal.const";
 * import * as WB_CONST from "@/constants/gobal.const";
 */
/** 世界书注入默认Token预算，给 selectWorldBookForInjection 使用 */
export const GLOBAL_WORLD_BOOK_TOKEN_BUDGET = 200000;

// 如果需要运行时修改，不要用const，改用let
// export let GLOBAL_WORLD_BOOK_TOKEN_BUDGET = 600;

/**
 * 世界书注入条目单条大小上限（字符数）。
 *
 * 用途：
 * - 防止单个常驻条目因体积过大把整轮 token 预算吃光；
 * - 同时给前端"激活的世界书"面板一个合理的单条展示上限。
 */
export const WORLD_BOOK_ENTRY_MAX_CHARS = 20000;

/**
 * 激活世界书条目数上限。
 *
 * 用途：
 * - 编排一轮最多注入 30 条世界书条目；
 * - 防止匹配过多条目把上下文塞爆 + 给前端面板一个稳定数量上限。
 */
export const WORLD_BOOK_ACTIVATED_MAX_ENTRIES = 30;

/**
 * 常驻条目默认粘性（编排轮数）。
 *
 * 含义：
 * - 一个条目被命中（keys 匹配）后，"保持激活"3 轮编排；
 * - 这 3 轮里即使 keys 不再命中，它仍出现在激活列表里（保证上下文连贯）；
 * - 3 轮内仍未再命中，粘性归零，下一轮从激活列表里移除。
 */
export const WORLD_BOOK_STICKINESS_DEFAULT = 3;
