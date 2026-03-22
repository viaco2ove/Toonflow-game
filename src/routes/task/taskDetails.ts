import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    taskId: z.number(),
  }),
  async (req, res) => {
    const { taskId } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const data = await u
      .db("t_taskList")
      .leftJoin("t_project", "t_project.id", "t_taskList.projectName")
      .where("t_taskList.id", taskId)
      .where("t_project.userId", userId)
      .select("t_taskList.*")
      .first();
    res.status(200).send(success(data));
  }
);
