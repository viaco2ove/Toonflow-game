import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

type GenerateType = "role" | "scene";

function extractBase64(content: string): Buffer {
  const match = String(content || "").match(/base64,([A-Za-z0-9+/=]+)/);
  return Buffer.from(match && match[1] ? match[1] : String(content || ""), "base64");
}

function buildPrompts(type: GenerateType, artStyle: string, name: string, prompt: string): { systemPrompt: string; userPrompt: string } {
  const safeStyle = artStyle.trim() || "未指定";
  const safeName = name.trim() || (type === "role" ? "角色" : "场景");
  if (type === "role") {
    return {
      systemPrompt: `
你是游戏角色形象生成助手。
你的任务是只输出一张清晰、可直接用于移动端故事游戏头像和立绘的角色图。
`.trim(),
      userPrompt: `
请根据以下参数生成单张角色图：

- 画风风格：${safeStyle}
- 角色名：${safeName}
- 角色设定：${prompt.trim()}

要求：
- 只生成一张图
- 人物主体明确，构图干净
- 适合移动端故事游戏头像与角色展示
- 禁止多人物、禁止水印、禁止额外文字
      `.trim(),
    };
  }

  return {
    systemPrompt: `
你是游戏场景图生成助手。
你的任务是只输出一张可直接用于故事封面或章节背景的高清场景图。
`.trim(),
    userPrompt: `
请根据以下参数生成单张场景图：

- 画风风格：${safeStyle}
- 场景名：${safeName}
- 场景描述：${prompt.trim()}

要求：
- 只生成一张图
- 画面完整，适合作为故事封面或章节背景
- 禁止水印、禁止多余文字
    `.trim(),
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    type: z.enum(["role", "scene"]),
    prompt: z.string(),
    name: z.string().optional().nullable(),
    base64: z.string().optional().nullable(),
    base64List: z.array(z.string()).optional().nullable(),
    size: z.enum(["1K", "2K", "4K"]).optional().nullable(),
    aspectRatio: z.string().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { projectId, type, prompt, name, base64, base64List } = req.body as {
        projectId: number;
        type: GenerateType;
        prompt: string;
        name?: string | null;
        base64?: string | null;
        base64List?: string[] | null;
      };
      const size = (req.body.size as "1K" | "2K" | "4K" | undefined) || "2K";
      const aspectRatio = String(req.body.aspectRatio || "").trim() || (type === "role" ? "1:1" : "16:9");
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const project = await u.db("t_project").where({ id: Number(projectId), userId }).select("id", "artStyle").first();
      if (!project) {
        return res.status(403).send(error("无权访问该项目"));
      }

      let apiConfig = await u.getPromptAi("editImage", userId);
      if (!(apiConfig as any)?.manufacturer) {
        apiConfig = await u.getPromptAi("assetsImage", userId);
      }
      if (!(apiConfig as any)?.manufacturer) {
        return res.status(400).send(error("未配置图片模型，请先在设置中配置图片模型"));
      }

      const { systemPrompt, userPrompt } = buildPrompts(type, String(project.artStyle || ""), String(name || ""), String(prompt || ""));
      const imageBase64List = Array.isArray(base64List)
        ? base64List.map((item) => String(item || "").trim()).filter((item) => item)
        : [];
      if (imageBase64List.length === 0 && base64) {
        imageBase64List.push(String(base64).trim());
      }
      const contentStr = await u.ai.image(
        {
          systemPrompt,
          prompt: userPrompt,
          imageBase64: imageBase64List,
          size,
          aspectRatio,
        },
        apiConfig as any,
      );

      const buffer = extractBase64(contentStr);
      const imagePath = `/${projectId}/game/${type}/${uuidv4()}.jpg`;
      await u.oss.writeFile(imagePath, buffer);
      const path = await u.oss.getFileUrl(imagePath);

      res.status(200).send(success({ path, filePath: imagePath }));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
