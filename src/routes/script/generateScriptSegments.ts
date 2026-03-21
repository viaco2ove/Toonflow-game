import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildScriptSegments, replaceScriptSegments } from "@/lib/scriptSegment";
import Storyboard from "@/agents/storyboard";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { scriptId } = req.body;
    const script = await u.db("t_script").where({ id: scriptId }).first("id", "projectId", "content");
    if (!script) {
      return res.status(404).send(error("剧本不存在"));
    }

    const content = String(script.content || "").trim();
    if (!content) {
      return res.status(400).send(error("剧本内容为空，请先补充剧本内容"));
    }

    const fallbackSegments = buildScriptSegments(content);
    let segments = fallbackSegments;
    try {
      const agent = new Storyboard(Number(script.projectId), Number(scriptId));
      const aiSegments = await agent.generateSegmentsByAgent("请基于当前剧本生成剧情片段，输出清晰、连贯、可用于分镜的片段描述。");
      if (Array.isArray(aiSegments) && aiSegments.length > 0) {
        const baseSegments = buildScriptSegments(content, aiSegments.length);
        segments = aiSegments.map((item, index) => ({
          sort: index + 1,
          title: baseSegments[index]?.title || `片段${index + 1}`,
          content: baseSegments[index]?.content || item.description,
          summary: item.description,
          startAnchor: baseSegments[index]?.startAnchor || "",
          endAnchor: baseSegments[index]?.endAnchor || "",
        }));
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn("AI分段失败，使用规则分段兜底：", msg);
    }
    const rows = await replaceScriptSegments(u.db, scriptId, Number(script.projectId), segments);
    res.status(200).send(
      success({
        scriptId,
        count: rows.length,
        rows,
      }),
    );
  },
);
