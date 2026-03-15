import "./type";
import u from "@/utils";
import modelList from "./modelList";
import axios from "axios";

import volcengine from "./owned/volcengine";
import kling from "./owned/kling";
import vidu from "./owned/vidu";
import wan from "./owned/wan";
import runninghub from "./owned/runninghub";
import gemini from "./owned/gemini";
import apimart from "./owned/apimart";
import other from "./owned/other";
import grsai from "./owned/grsai";
import t8star from "./owned/t8star";
import qingyuntop from "./owned/qingyuntop";
const modelInstance = {
  volcengine: volcengine,
  kling: kling,
  vidu: vidu,
  wan: wan,
  gemini: gemini,
  runninghub: runninghub,
  apimart: apimart,
  other: other,
  grsai: grsai,
  t8star: t8star,
  qingyuntop: qingyuntop,
} as const;
const VIDEO_DEBUG = (process.env.AI_VIDEO_DEBUG || "").trim() === "1";

function maskKey(input?: string): string {
  const value = String(input || "").trim();
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export default async (input: VideoConfig, config?: AIConfig) => {
  const { model, apiKey, baseURL, manufacturer } = { ...config };
  if (!config || !config?.model || !config?.apiKey) throw new Error("请检查模型配置是否正确");

  const manufacturerFn = modelInstance[manufacturer as keyof typeof modelInstance];
  if (!manufacturerFn) if (!manufacturerFn) throw new Error("不支持的视频厂商");
  // const owned = modelList.find((m) => m.model === model);
  // if (!owned) throw new Error("不支持的模型");

  // 补充图片的 base64 内容类型字符串
  if (input.imageBase64 && input.imageBase64.length > 0) {
    input.imageBase64 = input.imageBase64.map((img) => {
      if (img.startsWith("data:image/")) {
        return img;
      }
      // 根据 base64 头部判断图片类型
      if (img.startsWith("/9j/")) {
        return `data:image/jpeg;base64,${img}`;
      }
      if (img.startsWith("iVBORw")) {
        return `data:image/png;base64,${img}`;
      }
      if (img.startsWith("R0lGOD")) {
        return `data:image/gif;base64,${img}`;
      }
      if (img.startsWith("UklGR")) {
        return `data:image/webp;base64,${img}`;
      }
      // 默认使用 png
      return `data:image/png;base64,${img}`;
    });
  }

  if (VIDEO_DEBUG) {
    console.log("[video] invoke", {
      manufacturer,
      model,
      baseURL,
      apiKey: maskKey(apiKey),
      imageCount: Array.isArray(input.imageBase64) ? input.imageBase64.length : 0,
      duration: input.duration,
      resolution: input.resolution,
      mode: input.mode,
    });
  }

  let videoUrl = await manufacturerFn(input, { model, apiKey, baseURL });
  if (VIDEO_DEBUG) {
    console.log("[video] provider returned url", videoUrl || "");
  }
  if (videoUrl) {
    const response = await axios.get(videoUrl, { responseType: "stream" });
    if (VIDEO_DEBUG) {
      console.log("[video] download response", {
        status: response.status,
        contentType: response.headers?.["content-type"] || "",
      });
    }
    await u.oss.writeFile(input.savePath, response.data);
    return input.savePath;
  }
  return videoUrl;
};
