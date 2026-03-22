import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const userId = Number((req as any)?.user?.id || 0);
  const mapRows = await u.db("t_aiModelMap").select("id", "name", "key").orderBy("id", "asc");
  const setting = await u.db("t_setting").where({ userId }).select("languageModel").first();

  let languageModelMap: Record<string, number> = {};
  try {
    const parsed = JSON.parse(String(setting?.languageModel || "{}"));
    if (parsed && typeof parsed === "object") {
      languageModelMap = Object.entries(parsed).reduce(
        (acc, [key, value]) => {
          const id = Number(value);
          if (Number.isFinite(id) && id > 0) {
            acc[key] = id;
          }
          return acc;
        },
        {} as Record<string, number>,
      );
    }
  } catch {
    languageModelMap = {};
  }

  const configIds = Array.from(new Set(Object.values(languageModelMap))).filter((id) => Number.isFinite(id) && id > 0);
  const configRows = configIds.length
    ? await u.db("t_config").whereIn("id", configIds).where("userId", userId).select("id", "model", "manufacturer")
    : [];
  const configMap = new Map<number, { model: string; manufacturer: string }>();
  for (const row of configRows as any[]) {
    configMap.set(Number(row.id), {
      model: String(row.model || ""),
      manufacturer: String(row.manufacturer || ""),
    });
  }

  const data = mapRows.map((row: any) => {
    const configId = Number(languageModelMap[String(row.key)] || 0);
    const config = configMap.get(configId);
    return {
      id: Number(row.id),
      key: String(row.key || ""),
      name: String(row.name || ""),
      configId: configId > 0 ? configId : null,
      model: config?.model || null,
      manufacturer: config?.manufacturer || null,
    };
  });

  res.status(200).send(success(data));
});
