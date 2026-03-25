import axios from "axios";
import u from "@/utils";

export interface GatewayVoicePreset {
  voiceId: string;
  name: string;
  provider: string;
  modes: string[];
  description: string;
}

export function normalizeVoiceBaseUrl(input: string | null | undefined): string {
  const base = String(input || "").trim();
  return (base || "http://127.0.0.1:8000").replace(/\/+$/, "");
}

export async function getUserVoiceConfig(userId: number, configId?: number | null) {
  if (configId) {
    return u.db("t_config").where({ id: configId, type: "voice", userId }).first();
  }
  return u.db("t_config").where({ type: "voice", userId }).first();
}

export function normalizeVoicePreset(item: any): GatewayVoicePreset | null {
  if (!item) return null;
  if (typeof item === "string") {
    const voiceId = item.trim();
    if (!voiceId) return null;
    return {
      voiceId,
      name: voiceId,
      provider: "",
      modes: [],
      description: "",
    };
  }

  const voiceId = String(item.voice_id || item.voiceId || item.id || item.key || "").trim();
  if (!voiceId) return null;

  return {
    voiceId,
    name: String(item.name || item.label || item.voice_name || voiceId).trim() || voiceId,
    provider: String(item.provider || item.provider_id || "").trim(),
    modes: Array.isArray(item.modes) ? item.modes.map((mode: any) => String(mode || "").trim()).filter(Boolean) : [],
    description: String(item.description || item.desc || "").trim(),
  };
}

export async function fetchVoicePresets(baseUrl: string, headers: Record<string, string>) {
  const response = await axios.get(`${baseUrl}/voices`, { headers });
  const data = (response.data as any)?.data ?? response.data;
  const list = Array.isArray(data) ? data : Array.isArray(data?.voices) ? data.voices : [];
  return list.map(normalizeVoicePreset).filter((item: GatewayVoicePreset | null): item is GatewayVoicePreset => !!item);
}
