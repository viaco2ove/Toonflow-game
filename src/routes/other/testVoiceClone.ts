import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    modelName: z.string(),
    apiKey: z.string(),
    baseURL: z.string().optional(),
    manufacturer: z.string(),
  }),
  async (req, res) => {
    const { modelName, apiKey, baseURL, manufacturer } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const trimmedManufacturer = String(manufacturer || "").trim().toLowerCase();
    const trimmedApiKey = String(apiKey || "").trim();
    const trimmedBaseUrl = String(baseURL || "").trim();
    const trimmedModel = String(modelName || "").trim();

    try {
      if (trimmedManufacturer === "minimax") {
        // MiniMax 语音克隆：用 TTS 接口验证 API Key 有效性
        //（真正克隆需要 10 秒以上参考音频，测试连通性用 TTS 即可）
        const baseUrl = trimmedBaseUrl || "https://api.minimaxi.com";
        const response = await axios.post(
          `${baseUrl}/v1/t2a_v2`,
          {
            model: trimmedModel || "speech-02-hd",
            text: "这是语音克隆模型连通性测试。",
            stream: false,
            voice_setting: { voice_id: "male-qn-qingse" },
            audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
          },
          {
            headers: { Authorization: `Bearer ${trimmedApiKey}`, "Content-Type": "application/json" },
            timeout: 30000,
          },
        );
        const statusCode = response.data?.base_resp?.status_code;
        if (statusCode !== 0) {
          throw new Error(`MiniMax 错误: ${response.data?.base_resp?.status_msg || statusCode}`);
        }
        if (response.data?.data?.audio) {
          const buffer = Buffer.from(response.data.data.audio, "hex");
          const savePath = `/temp/voice-clone-test/${userId || "guest"}/${Date.now()}_${uuidv4()}.mp3`;
          await u.oss.writeFile(savePath, buffer);
          const audioUrl = await u.oss.getFileUrl(savePath);
          res.status(200).send(success(audioUrl));
        } else {
          res.status(200).send(success("MiniMax 语音克隆模型 API Key 验证通过"));
        }
      } else if (trimmedManufacturer === "aliyun_direct") {
        // 阿里百炼：验证 API Key 有效性
        const baseUrl = trimmedBaseUrl || "https://dashscope.aliyuncs.com";
        await axios.post(
          `${baseUrl}/api/v1/services/audio/tts/customization`,
          { model: trimmedModel || "voice-enrollment" },
          {
            headers: { Authorization: `Bearer ${trimmedApiKey}`, "Content-Type": "application/json" },
            timeout: 30000,
          },
        );
        res.status(200).send(success("阿里百炼语音克隆模型连通性测试通过"));
      } else if (trimmedManufacturer === "ai_voice_tts") {
        // 本地 CosyVoice：验证服务可达
        const baseUrl = trimmedBaseUrl || "http://127.0.0.1:8000";
        await axios.get(`${baseUrl}/health`, { timeout: 10000 });
        res.status(200).send(success("本地 CosyVoice 服务连通性测试通过"));
      } else {
        res.status(400).send(error(`不支持的语音克隆厂商: ${manufacturer}`));
      }
    } catch (err) {
      const errMsg = u.error(err).message;
      console.error("[testVoiceClone] 语音克隆测试失败", {
        manufacturer,
        modelName: trimmedModel,
        apiKey: trimmedApiKey ? `${trimmedApiKey.slice(0, 4)}***${trimmedApiKey.slice(-4)}` : "",
        baseURL: trimmedBaseUrl,
        error: errMsg,
        stack: (err as any)?.stack,
      });
      res.status(500).send(error(errMsg));
    }
  },
);