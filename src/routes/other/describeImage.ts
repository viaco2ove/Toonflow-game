import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";

const router = express.Router();

/**
 * 分析图片内容，生成文字描述。
 * 利用 AI 多模态能力（支持 vision 的模型）从图片提取角色/场景描述。
 */
router.post(
  "/",
  validateFields({
    /** base64 编码的图片（data URL 或纯 base64） */
    imageBase64: z.string(),
    /** 描述类型：role | scene */
    type: z.enum(["role", "scene"]).default("role"),
  }),
  async (req, res) => {
    const { imageBase64, type } = req.body as { imageBase64: string; type: "role" | "scene" };

    try {
      const apiConfig = await u.getPromptAi("storyImageModel");
      if (!(apiConfig as any)?.manufacturer) {
        return res.status(400).send(error("请先在设置 > AI生图 中配置图像模型"));
      }

      const systemPrompt = type === "role"
        ? "你是一个专业的角色画家助手。请仔细分析参考图中的人物角色，生成一段详细的中文形象描述，包含人物的外貌特征、服装风格、表情神态、体态动作、整体气质等，用于后续 AI 生图生成同款角色。请只输出描述文字，不要输出其他内容。"
        : "你是一个专业的场景画家助手。请仔细分析参考图中的场景环境，生成一段详细的中文场景描述，包含场景的建筑风格、环境氛围、光线色调、天气时间、构图特点等，用于后续 AI 生图生成同款场景。请只输出描述文字，不要输出其他内容。";

      const result = await u.ai.text.invoke(
        {
          messages: [
            { role: "system" as const, content: systemPrompt },
            {
              role: "user" as const,
              content: [
                {
                  type: "image" as const,
                  image: imageBase64,
                },
                { type: "text" as const, text: "请描述这张图片" },
              ],
            },
          ],
          usageType: "图片识别描述",
          usageRemark: `describeImage / ${type}`,
        },
        apiConfig as any,
      );

      const description = String((result as any)?.text || result || "").trim();
      if (!description) {
        return res.status(500).send(error("图片识别失败，未返回描述内容"));
      }

      return res.status(200).send(success({ description }));
    } catch (err) {
      return res.status(500).send(error(u.error(err).message));
    }
  },
);

export default router;