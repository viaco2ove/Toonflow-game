# AI Agent 工作流文档

> 描述 Toonflow 游戏中所有 AI Agent 的完整工作流程，包括触发条件、数据流、关键节点。

---

## Mermaid 流程图索引

| 图表 | 文件 | 说明 |
|------|------|------|
| 主流程图 | [mmd/01_主流程图.mmd](mmd/01_%E4%B8%BB%E6%B5%81%E7%A8%8B.mmd) | 完整工作流状态机 |
| 时序图 | [mmd/02_时序图.mmd](mmd/02_%E6%97%B6%E5%BA%8F%E5%9B%BE.mmd) | 各组件交互时序 |
| 数据流图 | [mmd/03_数据流图.mmd](mmd/03_%E6%95%B0%E6%8D%AE%E6%B5%81%E5%9B%BE.mmd) | 数据存储关系 |
| AI模型调用 | [mmd/04_AI模型调用流程.mmd](mmd/04_AI%E6%A8%A1%E5%9E%8B%E8%B0%83%E7%94%A8%E6%B5%81%E7%A8%8B.mmd) | 多模型选择与降级 |

---

## 一、工作流总览

```
用户消息 → 预处理 → 意图分析 → 分流调度 → 各Agent执行 → 结果返回 → 后处理
```

### 核心入口
- **前端入口**：`ScenePlay.vue` 中的 `sendMessage()` / `sendOptionMessage()`
- **后端入口**：`MiniGameController.ts` 的 `/session/continue` 接口

---

## 二、用户消息预处理

**文件**：`ScenePlay.vue` L2675+ `prepareMessage()`

**处理步骤**：

1. **命令解析** (`isMiniGameCommand()`)  
   检测 `#开任务` / `#任务` / `#退出` 等命令前缀

2. **选项解析** (`isOptionPrefix()`)  
   检测数字选项前缀 `1.` `2.` 等

3. **消息清理**  
   去除命令前缀，保留纯内容

4. **上下文注入**  
   注入当前 miniGame 状态、executingTask 信息

---

## 三、意图分析 Agent

**文件**：`src/agents/intentAnalyzer/index.ts`

**触发时机**：每条用户消息都会经过意图分析

### 意图分类

| 意图 | 说明 | 置信度阈值 |
|------|------|-----------|
| `create_task` | 用户想创建任务 | 0.7 |
| `exit_task` | 用户想退出任务 | 0.7 |
| `query_progress` | 用户查询任务进度 | 0.7 |
| `game_action` | 执行游戏选项/动作 | 0.7 |
| `normal_dialog` | 普通对话（兜底） | - |

### 分析输入

```typescript
{
  userMessage: string,
  recentMessages: Message[],      // 最近 20 条对话
  activeTask: Task | null,       // 当前任务（如果有）
  miniGameState: MiniGame,
  chapterContext: {
    outline: string,
    stage: string,
    options: string[]
  }
}
```

### 分析输出

```typescript
{
  intent: IntentType,
  confidence: number,            // 0-1
  reasoning: string,             // 分析理由
  extractedParams?: {            // 意图参数
    taskName?: string,
    taskGoal?: string,
    exitReason?: string
  }
}
```

### 执行逻辑

```typescript
// src/agents/intentAnalyzer/index.ts
export async function analyzeIntent(ctx: IntentContext): Promise<IntentResult> {
  // 1. 规则预检（快速路径）
  if (isForceQuitCommand(ctx.message)) {
    return { intent: 'exit_task', confidence: 1.0, reasoning: '退出命令' };
  }
  if (isTaskCreateCommand(ctx.message)) {
    return { intent: 'create_task', confidence: 1.0, reasoning: '创建任务命令' };
  }
  if (isOptionNumber(ctx.message)) {
    return { intent: 'game_action', confidence: 0.9, reasoning: '选项选择' };
  }

  // 2. AI 分类（慢速路径）
  const prompt = buildIntentPrompt(ctx);
  const response = await callAiModel('intent-classifier', prompt);
  return parseIntentResponse(response);
}
```

---

## 四、分流调度

**文件**：`MiniGameController.ts` L140+ `handleSessionContinue()`

### 分流逻辑

```
意图 = create_task → 创建任务流程
意图 = exit_task → 退出任务流程
意图 = query_progress → 查询进度流程
意图 = game_action → 执行游戏动作
意图 = normal_dialog → 普通剧情流程
```

### 分流代码示例

```typescript
const intent = await analyzeIntent(ctx);

switch (intent.intent) {
  case 'create_task':
    return await handleCreateTask(ctx, intent.extractedParams);
  case 'exit_task':
    return await handleExitTask(ctx, intent.extractedParams);
  case 'query_progress':
    return await handleQueryProgress(ctx);
  case 'game_action':
    return await handleGameAction(ctx);
  default:
    return await handleNormalDialog(ctx);
}
```

---

## 五、创建任务流程 (create_task)

**文件**：`FreeChapterTaskService.ts` `generateFreeChapterTaskBlueprintByAi()`

### 流程步骤

```
1. 构建任务蓝图生成提示
2. 调用 AI 生成任务结构
3. 验证任务蓝图格式
4. 创建 Task 实例
5. 激活任务事件
6. 返回任务面板渲染数据
```

### 输入数据

```typescript
{
  characterName: string,
  characterPersonality: string,
  worldSetting: string,
  recentNarrative: string,        // 最近剧情上下文
  userRequest: string,           // 用户想创建的任务描述
  taskOptions: string[]           // 可选的任务类型
}
```

### 输出数据

```typescript
{
  taskId: string,
  taskName: string,
  taskGoal: string,              // 任务目标
  taskDescription: string,       // 详细描述
  stages: TaskStage[],            // 阶段定义
  successConditions: string[],   // 成功条件
  failureConditions: string[],   // 失败条件
  estimatedDuration: string,      // 预计时长
  reward: TaskReward              // 奖励
}
```

### AI 提示词模板

```
你是任务设计师。根据用户需求和当前剧情上下文，设计一个有趣的任务。

角色信息：
- 角色名：{characterName}
- 角色性格：{characterPersonality}
- 世界设定：{worldSetting}

最近剧情：
{recentNarrative}

用户需求：{userRequest}

请设计一个包含以下要素的任务：
1. 任务名称（简洁有力）
2. 任务目标（清晰可衡量）
3. 阶段划分（3-5个阶段）
4. 每个阶段的选项（每个阶段2-4个选项）
5. 成功条件和失败条件
6. 奖励机制

以 JSON 格式输出。
```

---

## 六、执行游戏动作 (game_action)

**文件**：`SessionService.ts` L580+ `continueSessionNarrative()`

### 流程步骤

```
1. 解析用户选择的选项编号
2. 获取选项对应的实际内容
3. 将选项内容追加到对话历史
4. 调用剧情生成 Agent
5. 处理生成的剧情内容
6. 更新会话状态
7. 检查任务进度
8. 返回渲染数据
```

### 关键代码

```typescript
// src/modules/game-runtime/services/SessionService.ts
async continueSessionNarrative(sessionId: string, userMessage: string) {
  // 1. 解析选项
  const optionNumber = parseOptionNumber(userMessage);
  const actualContent = resolveOptionContent(optionNumber);

  // 2. 更新对话历史
  await this.appendUserMessage(sessionId, actualContent);

  // 3. 生成剧情
  const narrative = await this.generateNarrative(sessionId);

  // 4. 检查任务进度
  const taskProgress = await TaskProgressEngine.evaluate(sessionId);

  // 5. 返回结果
  return {
    narrative,
    taskProgress,
    newOptions: narrative.options
  };
}
```

### 剧情生成 Agent

**文件**：`src/agents/storyboard/index.ts`

**输入**：
- 对话历史（最近 N 条）
- 角色设定
- 世界设定
- 当前剧情阶段
- 可用选项

**输出**：
- 剧情叙述文本
- 新选项列表
- 状态变化

---

## 七、任务进度评估

**文件**：`TaskProgressEngine.ts` `evaluate()`

### 评估触发时机

1. 每次剧情生成后自动触发
2. 用户查询进度时主动触发
3. 任务阶段完成时触发

### 评估方式

```typescript
enum EvaluationMode {
  AI_EVALUATION = 'ai',        // AI 智能评估
  RULE_BASED = 'rule',         // 规则评估
  STATIC_CONDITION = 'static'  // 静态条件
}

// 优先级：static > rule > ai
async evaluate(sessionId: string): Promise<TaskProgressResult> {
  // 1. 检查静态条件
  const staticResult = this.evaluateStatic(sessionId);
  if (staticResult.completed) return staticResult;

  // 2. 检查规则
  const ruleResult = this.evaluateByRules(sessionId);
  if (ruleResult.completed) return ruleResult;

  // 3. AI 评估
  return await this.evaluateByAi(sessionId);
}
```

### 评估输出

```typescript
{
  progress: number,            // 0-100
  currentStage: string,
  stageProgress: number,       // 当前阶段进度
  isCompleted: boolean,
  isFailed: boolean,
  nextMilestone: string,
  hints: string[],              // 提示信息
  recommendedAction: string    // 建议行动
}
```

---

## 八、查询进度流程 (query_progress)

**文件**：`MiniGameController.ts` `handleQueryProgress()`

### 流程

```
1. 获取当前任务状态
2. 调用 TaskProgressEngine 获取进度
3. 生成进度报告
4. 返回给用户
```

### 输出格式

```markdown
📋 任务进度报告

任务：{taskName}
阶段：{currentStage} ({stageIndex}/{totalStages})
进度：████████░░ 80%

当前目标：{taskGoal}
已完成：{completedItems}
待完成：{pendingItems}

建议：{recommendedAction}
```

---

## 九、退出任务流程 (exit_task)

**文件**：`MiniGameController.ts` `handleExitTask()`

### 触发条件

1. 用户发送 `#退出` / `#exit` 命令
2. AI 判断用户想放弃当前任务
3. 任务失败后自动触发

### 流程

```
1. 确认退出意图（如果置信度 < 1.0）
2. 记录退出原因
3. 清理任务状态
4. 发送放弃剧情
5. 返回主剧情
```

### 数据记录

```typescript
{
  taskId: string,
  exitReason: string,
  exitStage: string,
  progressAtExit: number,
  timestamp: Date
}
```

---

## 十、普通剧情流程 (normal_dialog)

**文件**：`SessionService.ts` `continueSessionNarrative()`

### 流程

```
1. 用户消息追加到历史
2. 构建剧情生成提示
3. 调用 Storyboard Agent
4. 解析生成结果
5. 更新会话状态
6. 检查是否有任务触发点
7. 返回剧情和选项
```

### 特殊处理

- **任务触发点检测**：如果剧情中出现 `runtimeOutline` 配置的任务选项，触发任务推荐 UI
- **剧情分支**：根据用户选择和剧情发展，动态调整后续选项

---

## 十一、剧情生成 Agent (Storyboard)

**文件**：`src/agents/storyboard/index.ts`

### 核心方法

```typescript
class StoryboardAgent {
  // 主方法：生成剧情
  async generateNarrative(ctx: StoryContext): Promise<NarrativeResult> {
    // 1. 构建提示
    const prompt = this.buildPrompt(ctx);

    // 2. 调用 AI
    const response = await callAiModel('storyboard', prompt);

    // 3. 解析结果
    return this.parseResponse(response);
  }

  // 构建提示
  buildPrompt(ctx: StoryContext): string {
    return `
你是剧情导演。根据以下信息生成下一段剧情：

角色：${ctx.character.name}
性格：${ctx.character.personality}
当前场景：${ctx.scene.description}
剧情阶段：${ctx.stage}
最近对话：${ctx.recentMessages.map(m => `${m.role}: ${m.content}`).join('\n')}

要求：
1. 保持角色一致性
2. 推动剧情发展
3. 提供有意义的选择
4. 适当埋下伏笔

请以 JSON 格式输出剧情和选项。
    `;
  }
}
```

### 输出格式

```typescript
{
  narrative: string,           // 剧情文本
  options: NarrativeOption[],  // 选项列表
  stateChanges: StateChange[], // 状态变化
  metadata: {
    stage: string,
    mood: string,
    tension: number
  }
}
```

---

## 十二、剧情大纲 Agent (Outline Script)

**文件**：`src/agents/outlineScript/index.ts`

### 用途

用于生成章节的整体大纲和任务蓝图

### 核心方法

```typescript
async generateOutlineScript(params: {
  storyPremise: string,
  characterProfiles: Character[],
  worldSetting: string,
  targetChapters: number
}): Promise<OutlineScript>
```

### 输出

```typescript
{
  chapters: Chapter[],
  characterArcs: CharacterArc[],
  plotThreads: PlotThread[],
  taskBlueprints: TaskBlueprint[]
}
```

---

## 十三、AI 模型配置

**文件**：`src/utils/ai/text/index.ts`

### 模型类型

| 模型 Key | 用途 | 默认模型 |
|----------|------|----------|
| `storyboard` | 剧情生成 | GPT-4 |
| `intent-classifier` | 意图分类 | GPT-4 |
| `task-evaluator` | 任务评估 | GPT-4 |
| `outline-generator` | 大纲生成 | GPT-4 |

### 配置方式

```typescript
// src/utils/getPromptAi.ts
const STRICT_MODEL_KEYS = {
  'storyboard': 'gpt-4',
  'intent-classifier': 'gpt-4',
  'task-evaluator': 'gpt-4',
  'outline-generator': 'gpt-4'
};

// 支持覆盖
interface ModelConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'lm-studio';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}
```

---

## 十四、工作流图表

详细时序图请查看：[mmd/02_时序图.mmd](mmd/02_%E6%97%B6%E5%BA%8F%E5%9B%BE.mmd)

```
用户发送消息 → 消息预处理 → 意图分析 → 分流调度 → 各 Agent 执行 → 结果返回
```

详细流程图请查看：
- [mmd/01_主流程图.mmd](mmd/01_%E4%B8%BB%E6%B5%81%E7%A8%8B.mmd) - 状态机流程
- [mmd/03_数据流图.mmd](mmd/03_%E6%95%B0%E6%8D%AE%E6%B5%81%E5%9B%BE.mmd) - 数据存储关系

---

## 十五、错误处理

### 意图分析失败

```typescript
// 降级策略：默认视为 normal_dialog
async analyzeIntentSafe(ctx: IntentContext): Promise<IntentResult> {
  try {
    return await analyzeIntent(ctx);
  } catch (error) {
    console.error('Intent analysis failed:', error);
    return {
      intent: 'normal_dialog',
      confidence: 0,
      reasoning: 'Analysis failed, defaulting to dialog'
    };
  }
}
```

### AI 调用失败

```typescript
// 重试 + 降级
async callAiWithFallback(prompt: string, model: string): Promise<string> {
  // 1. 尝试指定模型
  try {
    return await callAi(model, prompt);
  } catch (e) {
    // 2. 降级到默认模型
    return await callAi('gpt-4', prompt);
  }
}
```

### 任务生成失败

```typescript
// 返回错误提示，让用户重新描述
{
  error: 'TASK_GENERATION_FAILED',
  message: '抱歉，无法理解您的任务需求，请尝试更详细地描述。'
}
```

---

## 十六、监控与日志

### 关键日志点

1. **意图分析**：记录输入消息、输出意图、置信度
2. **AI 调用**：记录模型、tokens 消耗、响应时间
3. **任务状态**：记录任务创建、进度更新、完成/失败

### 日志格式

```typescript
{
  timestamp: Date,
  event: string,
  data: object,
  duration?: number,
  error?: Error
}
```

---

## 十七、扩展点

### 添加新意图

1. 在 `IntentType` 枚举中添加新类型
2. 在 `analyzeIntent()` 中添加处理逻辑
3. 在 `MiniGameController` 中添加分流处理

### 添加新 Agent

1. 在 `src/agents/` 下创建新目录
2. 实现 `Agent` 接口
3. 在相应的工作流节点调用

### 模型切换

1. 修改 `getPromptAi.ts` 中的模型映射
2. 或通过环境变量动态配置
3. 支持本地模型（Ollama、LM Studio）

---

*文档版本：1.0*
*最后更新：2025-01*