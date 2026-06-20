/**
 * 意图分析 - 命令前缀正则定义
 *
 * 设计原则：
 * 1. 必须以 # 开头（与现有 #退出 / #开任务 / #exit 等命令风格一致）
 * 2. 大小写不敏感（兼容 #Task / #TASK / #退出任务）
 * 3. 容错宽松：冒号 / 全角冒号 / 空格 / 短横线 都接受
 * 4. create_task 必须带任务描述（不能空），其他命令可不带
 */

export type IntentLabel = "create_task" | "exit_task" | "query_progress" | "switch_task" | "list_tasks";

export interface IntentCommand {
  intent: IntentLabel;
  confidence: 1.0; // 命令命中就是 1.0
  params: Record<string, string | null>;
}

/**
 * 任务创建命令正则
 * 匹配: #任务:xxx / #任务 xxx / #开任务:xxx / #新建任务:xxx / #task:xxx / #mission:xxx
 * 提取: xxx 作为 task_description（必须有非空描述）
 *
 * 注意：必须排除 #任务: / #任务- / #任务 等空描述（让它们返回 null 让 AI 兜底）
 */
const CREATE_TASK_PATTERN = /^\s*#\s*(?:任务|开任务|新建任务|创建任务|task|mission)\s*[:：]\s*([\s\S]+?)\s*$/i;
const CREATE_TASK_PATTERN_HYPHEN = /^\s*#\s*(?:任务|开任务|新建任务|创建任务|task|mission)\s*\-\s*([\s\S]+?)\s*$/i;
const CREATE_TASK_PATTERN_NO_DELIM = /^\s*#\s*(?:任务|开任务|新建任务|创建任务|task|mission)\s+(\S[\s\S]*?)\s*$/i;

/**
 * 任务退出命令正则
 * 匹配: #退出任务 / #exit task / #abort task / #quit task
 * 注意：#退出 是现有 miniGame 命令的占用标识，不在本系统匹配
 */
const EXIT_TASK_PATTERN = /^\s*#\s*(?:退出任务|退出\s*任务|exit\s*task|abort\s*task|quit\s*task)\s*$/i;

/**
 * 任务进度查询命令正则
 * 匹配: #任务进度 / #进度 / #status / #task status
 */
const QUERY_PROGRESS_PATTERN = /^\s*#\s*(?:任务进度|进度|task\s*progress|task\s*status|status)\s*$/i;

/**
 * 切换任务命令正则
 * 匹配: #切换任务 task_xxx / #切到任务 task_xxx / #switch task_xxx / #switch task_xxx
 * 提取: task_xxx 作为 task_id
 */
const SWITCH_TASK_PATTERN = /^\s*#\s*(?:切换任务|切到任务|switch\s+task|switch)\s+([a-zA-Z][a-zA-Z0-9_\-]*)\s*$/i;

/**
 * 列出任务命令正则
 * 匹配: #任务列表 / #list tasks / #任务清单
 */
const LIST_TASKS_PATTERN = /^\s*#\s*(?:任务列表|任务清单|list\s*tasks)\s*$/i;

/**
 * 顺序尝试所有命令模式，命中即返回。
 * 关键：先匹配"更具体"子命令（query/list/switch/exit），再 fall through 到 create_task，
 * 否则 #任务进度 会被 create_task 误匹配。
 */
export function detectCommand(rawMessage: string): IntentCommand | null {
  const text = String(rawMessage || "").trim();
  if (!text) return null;
  // 必须以 # 开头才走命令快路径
  if (!text.startsWith("#")) return null;

  // 1) switch_task 需要带 task_id
  const switchMatch = text.match(SWITCH_TASK_PATTERN);
  if (switchMatch) {
    return {
      intent: "switch_task",
      confidence: 1.0,
      params: { task_id: String(switchMatch[1] || "").trim() },
    };
  }

  // 2) query_progress / list_tasks / exit_task 都要先于 create_task 检测
  if (EXIT_TASK_PATTERN.test(text)) {
    return {
      intent: "exit_task",
      confidence: 1.0,
      params: {},
    };
  }

  if (QUERY_PROGRESS_PATTERN.test(text)) {
    return {
      intent: "query_progress",
      confidence: 1.0,
      params: {},
    };
  }

  if (LIST_TASKS_PATTERN.test(text)) {
    return {
      intent: "list_tasks",
      confidence: 1.0,
      params: {},
    };
  }

  // 3) create_task 兜底（必须带描述）
  const createMatch =
    text.match(CREATE_TASK_PATTERN) ||
    text.match(CREATE_TASK_PATTERN_HYPHEN) ||
    text.match(CREATE_TASK_PATTERN_NO_DELIM);
  if (createMatch) {
    const description = String(createMatch[1] || "").trim();
    if (description) {
      return {
        intent: "create_task",
        confidence: 1.0,
        params: { task_description: description },
      };
    }
  }

  return null;
}

/**
 * 调试用：导出所有正则，便于单元测试和文档。
 */
export const INTENT_PATTERNS = {
  create_task: CREATE_TASK_PATTERN,
  exit_task: EXIT_TASK_PATTERN,
  query_progress: QUERY_PROGRESS_PATTERN,
  switch_task: SWITCH_TASK_PATTERN,
  list_tasks: LIST_TASKS_PATTERN,
} as const;
