import express from "express";
import { z } from "zod";
import axios from "axios";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getRuntimeStoryVoiceConfig, normalizeVoiceBaseUrl } from "@/lib/voiceGateway";
import { getBusinessVoicePresets } from "@/lib/businessVoicePresets";

const router = express.Router();

interface MiniMaxVoiceRow {
  voice: string;
  name: string;
  voiceType: string; // system / voice_cloning / voice_generation
  language: string;
  gender: string;
}

function inferGender(text: string): string {
  const t = text.toLowerCase();
  if (/(女|female|woman|girl|少女|小姐|她)/.test(t)) return "female";
  if (/(男|male|man|boy|先生|少爷|他)/.test(t)) return "male";
  return "unknown";
}

function inferLanguage(text: string): string {
  const t = text.toLowerCase();
  if (/(英|english|en|英文)/.test(t)) return "en";
  if (/(日|japanese|jp|日语)/.test(t)) return "ja";
  if (/(韩|korean|kr|韩语)/.test(t)) return "ko";
  if (/(粤语|cantonese|zh-yue)/.test(t)) return "cantonese";
  return "zh";
}

// minimax 音色分页查询接口
export default router.post(
  "/",
  validateFields({
    configId: z.number().optional().nullable(),
    page: z.number().optional().nullable(),
    pageSize: z.number().optional().nullable(),
    search: z.string().optional().nullable(),
    voiceType: z.string().optional().nullable(),
    gender: z.string().optional().nullable(),
    language: z.string().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { configId, page, pageSize, search, voiceType, gender, language } = req.body as {
        configId?: number | null;
        page?: number | null;
        pageSize?: number | null;
        search?: string | null;
        voiceType?: string | null;
        gender?: string | null;
        language?: string | null;
      };
      const userId = Number((req as any)?.user?.id || 0);
      const config = await getRuntimeStoryVoiceConfig(userId, configId);
      if (!config) {
        return res.status(400).send(error("语音模型配置不存在"));
      }
      const baseUrl = normalizeVoiceBaseUrl(config.baseUrl);
      const apiKey = String(config.apiKey || "").trim();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const response = await axios.post(`${baseUrl}/v1/get_voice`, { voice_type: "all" }, { headers });
      const data = (response.data as any)?.data ?? response.data;
      // minimax 真实返回结构：{ system_voice: [], voice_cloning: [], voice_generation: [] }
      const systemVoices: any[] = Array.isArray(data?.system_voice) ? data.system_voice : [];
      const clonedVoices: any[] = Array.isArray(data?.voice_cloning) ? data.voice_cloning : [];
      const generatedVoices: any[] = Array.isArray(data?.voice_generation) ? data.voice_generation : [];
      const combinedList = [
        ...systemVoices.map((item) => ({ item, voiceType: "system" })),
        ...clonedVoices.map((item) => ({ item, voiceType: "voice_cloning" })),
        ...generatedVoices.map((item) => ({ item, voiceType: "voice_generation" })),
      ];

      let rows: MiniMaxVoiceRow[] = combinedList.map(({ item, voiceType }: { item: any; voiceType: string }) => {
        const name = String(item?.voice_name || item?.voice_id || "").trim();
        const voiceId = String(item?.voice_id || "").trim();
        return {
          voice: voiceId,
          name: name || voiceId,
          voiceType,
          language: inferLanguage(name),
          gender: inferGender(name),
        };
      }).filter((item) => item.voice);

      if (search) {
        const kw = String(search).trim().toLowerCase();
        if (kw) {
          rows = rows.filter((item) =>
            item.name.toLowerCase().includes(kw) ||
            item.voice.toLowerCase().includes(kw),
          );
        }
      }
      if (voiceType) {
        const vt = String(voiceType).trim();
        if (vt && vt !== "all") rows = rows.filter((item) => item.voiceType === vt);
      }
      if (gender) {
        const g = String(gender).trim();
        if (g && g !== "all") rows = rows.filter((item) => item.gender === g);
      }
      if (language) {
        const l = String(language).trim();
        if (l && l !== "all") rows = rows.filter((item) => item.language === l);
      }

      // 合并业务预设（标准男声/女声/温柔女声/活泼女声/沉稳男声/讲述者）
      const businessRows: MiniMaxVoiceRow[] = getBusinessVoicePresets().map((preset) => {
        const name = String(preset.name || preset.voiceId || "").trim();
        return {
          voice: String(preset.voiceId || "").trim(),
          name,
          voiceType: "business_preset",
          language: "zh",
          gender: preset.fallbackGender === "female" ? "female" : "male",
        };
      }).filter((item) => item.voice);
      rows = [...businessRows, ...rows].filter(
        (item, index, list) => list.findIndex((row) => row.voice === item.voice) === index,
      );

      const total = rows.length;
      const ps = Math.min(100, Math.max(1, Number(pageSize) || 10));
      const pg = Math.max(1, Number(page) || 1);
      const start = (pg - 1) * ps;
      const items = rows.slice(start, start + ps);

      return res.status(200).send(success({ items, total, page: pg, pageSize: ps }));
    } catch (err) {
      const ax = err as any;
      const detail = ax?.response?.data || ax?.message;
      return res.status(500).send(error(`获取 minimax 音色失败: ${typeof detail === "string" ? detail : JSON.stringify(detail || String(err))}`));
    }
  },
);