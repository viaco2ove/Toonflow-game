/**
 * POST /plugin/agentRun — 插件 agent 调试运行接口
 *
 * 用途：dev-host 拟真宿主桩（`npm run debug -- --story xxx --conn`）跑在浏览器里，
 *   自身没有 LLM 通道，必须让后端代跑插件 agent，才能验证「安装后由插件 entry.ts
 *   通过 ctx.tsApi.agent.run 直连大模型」的同一条链路。
 *   与安装后路径同源：都走 runPluginAgent（提示词 + u.ai.text.invoke）。
 *
 * 入参：{ agentName, input, aiConfigKey? }
 * 出参：{ code:200, data:{ ok, output, error } }
 */
import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { runPluginAgent } from "@/lib/plugins/PluginAgentRunner";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    agentName: z.string().min(1),
    input: z.record(z.string(), z.any()).optional(),
    aiConfigKey: z.string().optional(),
  }),
  async (req, res) => {
    const { agentName, input, aiConfigKey } = req.body as {
      agentName: string;
      input?: Record<string, unknown>;
      aiConfigKey?: string;
    };
    try {
      const r = await runPluginAgent(
        agentName,
        (input || {}) as any,
        aiConfigKey || "storyMiniGameModel"
      );
      res.status(200).send(success(r));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).send(error(`插件 agent 运行失败：${msg}`));
    }
  }
);
