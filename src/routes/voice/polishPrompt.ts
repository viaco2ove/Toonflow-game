import express from "express";
import u from "@/utils";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

// 语音提示词润色
export default router.post(
  "/",
  validateFields({
    text: zod.string(),
    style: zod.string().optional().nullable(),
  }),
  async (req, res) => {
    const { text, style } = req.body;
    const promptAiConfig = await u.getPromptAi("assetsPrompt");

    const systemPrompt =
      "你是语音音色提示词优化师。将用户提供的短语/角色名润色为可用于音色选择的描述，要求：1-3句，描述音色特征（年龄段、气质、语速、情绪、口吻），不要编造剧情，不要包含对话内容。";
    const userPrompt = `原始输入：${text}\n偏好风格：${style || "无"}\n请输出润色后的音色描述。`;

    try {
      const result = await u.ai.text.invoke(
        {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          output: { prompt: zod.string().describe("润色后的音色描述") },
        },
        promptAiConfig,
      );
      if (!result?.prompt) {
        return res.status(500).send(error("生成失败"));
      }
      res.status(200).send(success({ prompt: result.prompt }));
    } catch (err: any) {
      return res.status(500).send(error(err?.data?.error?.message ?? err?.message ?? "生成失败"));
    }
  },
);
