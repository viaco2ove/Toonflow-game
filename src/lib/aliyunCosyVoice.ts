import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { resolveAliyunDirectCosyVoiceWsEndpoint } from "@/lib/voiceGateway";

type CosyVoiceOptions = {
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  voiceId: string;
  text: string;
  format?: string | null;
  speed?: number | null;
  pitch?: number | null;
  sampleRate?: number | null;
};

function normalizeFormat(input?: string | null): string {
  const raw = String(input || "").trim().toLowerCase();
  if (["wav", "mp3", "pcm"].includes(raw)) return raw;
  return "wav";
}

function normalizeSampleRate(input?: number | null): number {
  const value = Number(input || 0);
  if (Number.isFinite(value) && value > 0) return value;
  return 22050;
}

function normalizePlayableCosyVoiceText(input: string): string {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const compact = text.replace(/\s+/g, "");
  const meaningful = compact.replace(/[0-9０-９.,!?;:，。！？；：、…·"'“”‘’`~!@#$%^&*()\-_=+\[\]{}<>\\/|]+/g, "");
  return meaningful ? text : "";
}

export async function synthesizeAliyunDirectCosyVoiceBuffer(options: CosyVoiceOptions): Promise<Buffer> {
  const { apiKey, baseUrl, model, voiceId, text } = options;
  if (!String(apiKey || "").trim()) {
    throw new Error("阿里云直连缺少 API Key");
  }
  if (!String(model || "").trim()) {
    throw new Error("阿里云直连缺少 TTS 模型");
  }
  if (!String(voiceId || "").trim()) {
    throw new Error("CosyVoice 直连缺少音色 ID");
  }
  const playableText = normalizePlayableCosyVoiceText(String(text || ""));
  if (!playableText) {
    throw new Error("CosyVoice 不支持仅标点、编号或空白的短文本");
  }
  if (!String(text || "").trim()) {
    throw new Error("语音生成文本不能为空");
  }

  const WebSocket = require("ws");
  const wsUrl = resolveAliyunDirectCosyVoiceWsEndpoint(baseUrl);
  const taskId = uuidv4();
  const chunks: Buffer[] = [];
  const events: any[] = [];
  const format = normalizeFormat(options.format);
  const sampleRate = normalizeSampleRate(options.sampleRate);
  const speed = Number.isFinite(Number(options.speed)) ? Number(options.speed) : 1;
  const pitch = Number.isFinite(Number(options.pitch)) ? Number(options.pitch) : 1;

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let continueSent = false;
    let finished = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      reject(err instanceof Error ? err : new Error(String(err || "CosyVoice WebSocket 调用失败")));
    };

    const succeed = (buffer: Buffer) => {
      if (settled) return;
      settled = true;
      finished = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(buffer);
    };

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${String(apiKey || "").trim()}`,
      },
    });

    const timer = setTimeout(() => {
      fail(new Error("CosyVoice WebSocket 调用超时"));
    }, 120000);

    const sendJson = (payload: Record<string, unknown>) => {
      ws.send(JSON.stringify(payload));
    };

    ws.on("open", () => {
      sendJson({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: String(model || "").trim(),
          parameters: {
            text_type: "PlainText",
            voice: String(voiceId || "").trim(),
            format,
            sample_rate: sampleRate,
            volume: 50,
            rate: speed,
            pitch,
            enable_ssml: false,
          },
          input: {},
        },
      });
    });

    ws.on("message", async (raw: any, isBinary: boolean) => {
      if (isBinary || Buffer.isBuffer(raw)) {
        chunks.push(Buffer.from(raw));
        return;
      }

      const textMessage = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
      let parsed: any = null;
      try {
        parsed = JSON.parse(textMessage);
      } catch {
        return;
      }
      events.push(parsed);
      const event = String(parsed?.header?.event || parsed?.header?.status || "").trim();

      if (event === "task-started" && !continueSent) {
        continueSent = true;
        sendJson({
          header: {
            action: "continue-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: {
              input: {
              text: playableText,
            },
          },
        });
        sendJson({
          header: {
            action: "finish-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: {
            input: {},
          },
        });
        return;
      }

      if (event === "task-finished") {
        if (chunks.length > 0) {
          succeed(Buffer.concat(chunks));
          return;
        }
        const audioUrl = String(parsed?.payload?.output?.audio?.url || parsed?.payload?.audio?.url || "").trim();
        if (audioUrl) {
          try {
            const response = await axios.get(audioUrl, {
              responseType: "arraybuffer",
              timeout: 120000,
            });
            succeed(Buffer.from(response.data));
            return;
          } catch (err) {
            fail(err);
            return;
          }
        }
        fail(new Error(`CosyVoice 返回 task-finished，但没有音频数据: ${JSON.stringify(events[events.length - 1] || {})}`));
        return;
      }

      if (event === "task-failed") {
        const code = String(
          parsed?.header?.error_code
          || parsed?.payload?.output?.code
          || parsed?.payload?.code
          || parsed?.code
          || "",
        ).trim();
        const message = String(
          parsed?.payload?.output?.message
          || parsed?.payload?.message
          || parsed?.message
          || "CosyVoice 任务失败",
        ).trim();
        const detail = code ? `CosyVoice 任务失败(${code}): ${message || "未提供错误信息"}` : `CosyVoice 任务失败: ${message || "未提供错误信息"}`;
        fail(new Error(detail));
      }
    });

    ws.on("error", (err: unknown) => fail(err));
    ws.on("close", (code: number, reason: Buffer) => {
      if (settled || finished) return;
      const message = String(reason?.toString("utf8") || "").trim();
      fail(new Error(`CosyVoice WebSocket 已关闭(code=${code}${message ? `, reason=${message}` : ""})`));
    });
  });
}
