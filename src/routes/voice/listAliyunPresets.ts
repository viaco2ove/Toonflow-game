import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { listAliyunModelPresets, AliyunVoicePresetItem } from "@/lib/voiceGateway";
import { getBusinessVoicePresets } from "@/lib/businessVoicePresets";

const router = express.Router();

interface AliyunPresetRow {
  voice: string;
  name: string;
  scene: string;
  gender: string;
  age: string;
  language: string;
  model: string;
  family: string;
}

function normalizeScene(input?: string | null): string {
  return String(input || "").trim();
}

function inferGender(scene?: string | null, name?: string | null): string {
  const text = `${normalizeScene(scene)} ${String(name || "")}`.toLowerCase();
  if (/(女|女孩|女孩|小姐|阿姨|少女|娘娘|女神|female|woman|girl)/.test(text)) return "female";
  if (/(男|男孩|先生|少爷|少侠|少年|公子|爷|男声|男|male|boy|man)/.test(text)) return "male";
  return "unknown";
}

function inferAge(scene?: string | null): string {
  const text = normalizeScene(scene);
  if (/(儿童|童声|少儿|小孩|child|kid)/i.test(text)) return "child";
  if (/(少年|少女|youth|teen)/i.test(text)) return "youth";
  if (/(青年|成人|大人|adult)/i.test(text)) return "adult";
  if (/(中年|沉稳|成熟|middle|mature)/i.test(text)) return "middle";
  if (/(老年|老人|elder|senior|古|历史|诗)/i.test(text)) return "elder";
  return "unknown";
}

function inferLanguage(scene?: string | null, name?: string | null): string {
  const text = `${normalizeScene(scene)} ${String(name || "")}`;
  if (/(英语|英文|英|english|en)/i.test(text)) return "en";
  if (/(日语|日文|日|japanese|jp)/i.test(text)) return "ja";
  if (/(韩语|韩文|韩|korean|kr)/i.test(text)) return "ko";
  if (/(粤语|粤|cantonese|zh-yue)/i.test(text)) return "cantonese";
  if (/(闽南|闽|min)/i.test(text)) return "minnan";
  if (/(东北|东北话|东北话)/i.test(text)) return "dongbei";
  if (/(陕西|陕|陕北|陕北话)/i.test(text)) return "shaanxi";
  return "zh";
}

// 阿里云预设音色分页查询接口
export default router.post(
  "/",
  validateFields({
    model: z.string().min(1),
    page: z.number().optional().nullable(),
    pageSize: z.number().optional().nullable(),
    search: z.string().optional().nullable(),
    scene: z.string().optional().nullable(),
    gender: z.string().optional().nullable(),
    age: z.string().optional().nullable(),
    language: z.string().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { model, page, pageSize, search, scene, gender, age, language } = req.body as {
        model: string;
        page?: number | null;
        pageSize?: number | null;
        search?: string | null;
        scene?: string | null;
        gender?: string | null;
        age?: string | null;
        language?: string | null;
      };
      const all = listAliyunModelPresets(model);
      // 业务预设克隆音色（所有厂商通用）
      const businessRows: AliyunPresetRow[] = getBusinessVoicePresets().map((preset) => ({
        voice: preset.voiceId,
        name: preset.name,
        scene: "预设克隆",
        gender: preset.fallbackGender === "female" ? "female" : "male",
        age: "adult",
        language: "zh",
        model: "all",
        family: "business_preset",
      }));
      let rows: AliyunPresetRow[] = [...businessRows, ...all.map((item) => ({
        voice: String(item.voice || item.voice_id || "").trim(),
        name: String(item.name || "").trim(),
        scene: normalizeScene(item.scene),
        gender: item.gender || inferGender(item.scene, item.name),
        age: inferAge(item.scene),
        language: Array.isArray(item.language) ? item.language.join(",") : inferLanguage(item.scene, item.name),
        model: item.model || "",
        family: item.family || "cosyvoice",
      }))].filter((item) => item.voice);

      // 过滤
      if (search) {
        const kw = String(search).trim().toLowerCase();
        if (kw) {
          rows = rows.filter((item) =>
            item.name.toLowerCase().includes(kw) ||
            item.voice.toLowerCase().includes(kw),
          );
        }
      }
      if (scene) {
        const s = String(scene).trim();
        if (s) rows = rows.filter((item) => item.scene === s || item.scene.includes(s));
      }
      if (gender) {
        const g = String(gender).trim();
        if (g && g !== "all") rows = rows.filter((item) => item.gender === g);
      }
      if (age) {
        const a = String(age).trim();
        if (a && a !== "all") rows = rows.filter((item) => item.age === a);
      }
      if (language) {
        const l = String(language).trim();
        if (l && l !== "all") rows = rows.filter((item) => item.language === l);
      }

      const total = rows.length;
      const ps = Math.min(100, Math.max(1, Number(pageSize) || 10));
      const pg = Math.max(1, Number(page) || 1);
      const start = (pg - 1) * ps;
      const items = rows.slice(start, start + ps);

      return res.status(200).send(success({
        items,
        total,
        page: pg,
        pageSize: ps,
      }));
    } catch (err) {
      return res.status(500).send(error((err as Error)?.message || "获取阿里云音色失败"));
    }
  },
);

// 列出所有可用的阿里云 cosyvoice 模型
router.post(
  "/listAliyunModels",
  async (_req, res) => {
    try {
      const { loadAliyunVoicePresetsJson } = await import("@/lib/voiceGateway");
      const data = loadAliyunVoicePresetsJson();
      const models: Array<{ value: string; label: string; family: string }> = [
        { value: "all", label: "全部模型", family: "all" },
      ];
      // CosyVoice 模型
      const cosyModels = data?.cosyvoice?.models || {};
      for (const key of Object.keys(cosyModels)) {
        models.push({ value: key, label: key, family: "cosyvoice" });
      }
      // Qwen TTS 模型
      const qwen = data?.qwen_tts;
      if (qwen?.non_realtime_models) {
        for (const key of Object.keys(qwen.non_realtime_models)) {
          models.push({ value: key, label: key, family: "qwen_tts" });
        }
      }
      if (qwen?.realtime_models) {
        for (const key of Object.keys(qwen.realtime_models)) {
          if (!models.some((m) => m.value === key)) {
            models.push({ value: key, label: key, family: "qwen_tts" });
          }
        }
      }
      return res.status(200).send(success({ items: models }));
    } catch (err) {
      return res.status(500).send(error((err as Error)?.message || "获取阿里云模型列表失败"));
    }
  },
);
