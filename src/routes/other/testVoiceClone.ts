import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import path from "node:path";
import fs from "node:fs";
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
        // MiniMax 语音克隆：用内置测试音频（29秒，满足 10 秒要求）测试克隆
        const testAudioPath = path.join(process.cwd(), "res", "voice-presets", "can_clone", "prompt_voice_test.wav");
        if (!fs.existsSync(testAudioPath)) {
          throw new Error(`测试音频不存在: ${testAudioPath}`);
        }
        const audioBuffer = fs.readFileSync(testAudioPath);
        const baseUrl = trimmedBaseUrl || "https://api.minimaxi.com";

        // 上传参考音频到 MiniMax
        const uploadFormData = new FormData();
        uploadFormData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), `test_${uuidv4()}.wav`);
        uploadFormData.append("purpose", "voice_clone");
        const uploadResponse = await axios.post(
          `${baseUrl}/v1/files/upload`,
          uploadFormData,
          {
            headers: { Authorization: `Bearer ${trimmedApiKey}` },
            timeout: 30000,
          },
        );
        const fileId = uploadResponse.data?.file?.file_id;
        if (!fileId) {
          throw new Error(`MiniMax 文件上传失败: ${JSON.stringify(uploadResponse.data)}`);
        }

        // 调用克隆接口
        const voiceId = `test_${uuidv4().slice(0, 8)}`;
        const cloneResponse = await axios.post(
          `${baseUrl}/v1/voice_clone`,
          {
            file_id: Number(fileId),
            voice_id: voiceId,
            model: trimmedModel || "speech-02-hd",
          },
          {
            headers: { Authorization: `Bearer ${trimmedApiKey}`, "Content-Type": "application/json" },
            timeout: 60000,
          },
        );
        const statusCode = cloneResponse.data?.base_resp?.status_code;
        if (statusCode !== 0) {
          throw new Error(`MiniMax 语音克隆错误: ${cloneResponse.data?.base_resp?.status_msg || statusCode}`);
        }
        const clonedVoiceId = cloneResponse.data?.voice_id || voiceId;
        // demo_audio 是 hex 编码的音频
        if (cloneResponse.data?.demo_audio) {
          const demoHex = String(cloneResponse.data.demo_audio).trim();
          if (demoHex.length > 0) {
            try {
              const buffer = Buffer.from(demoHex, "hex");
              const savePath = `/temp/voice-clone-test/${userId || "guest"}/${clonedVoiceId}_demo.mp3`;
              await u.oss.writeFile(savePath, buffer);
              const audioUrl = await u.oss.getFileUrl(savePath);
              res.status(200).send(success(audioUrl));
            } catch {
              res.status(200).send(success(`MiniMax 语音克隆测试通过，voice_id: ${clonedVoiceId}`));
            }
          } else {
            res.status(200).send(success(`MiniMax 语音克隆测试通过，voice_id: ${clonedVoiceId}`));
          }
        } else {
          res.status(200).send(success(`MiniMax 语音克隆测试通过，voice_id: ${clonedVoiceId}`));
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