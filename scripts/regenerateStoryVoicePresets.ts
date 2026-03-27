import { regenerateBusinessVoicePresetFiles } from "@/lib/businessVoicePresets";

function parseUserId(argv: string[]): number {
  const direct = argv.find((item) => /^\d+$/.test(item.trim()));
  if (direct) return Number(direct);
  const fromFlag = argv.find((item) => item.startsWith("--userId="));
  if (fromFlag) {
    const value = Number(fromFlag.slice("--userId=".length));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

async function main() {
  const userId = parseUserId(process.argv.slice(2));
  console.log(`[voice] regenerate business presets start: userId=${userId}`);
  const presets = await regenerateBusinessVoicePresetFiles(userId);
  presets.forEach((preset) => {
    console.log(`[voice] regenerated: ${preset.voiceId} -> ${preset.referencePath}`);
  });
  console.log(`[voice] regenerate business presets done: count=${presets.length}`);
}

main().catch((err) => {
  console.error("[voice] regenerate business presets failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
