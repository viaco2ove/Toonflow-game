import fs from "node:fs/promises";
import path from "node:path";
import { getUploadRootDir, getVoicePresetSeedDir } from "@/lib/runtimePaths";

function isSeedFile(name: string): boolean {
  return name.toLowerCase().endsWith(".wav");
}

function toUploadTargetPath(fileName: string): string {
  return path.join(getUploadRootDir(), "system", "voice-presets", fileName);
}

export async function syncBundledVoicePresetSeeds(): Promise<number> {
  const sourceDir = getVoicePresetSeedDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return 0;
  }

  let copied = 0;
  for (const entry of entries) {
    if (!isSeedFile(entry)) continue;
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = toUploadTargetPath(entry);
    try {
      await fs.access(targetPath);
      continue;
    } catch {}
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    copied += 1;
  }
  return copied;
}

export async function ensureBundledVoicePresetSeed(fileName: string): Promise<string | null> {
  const sourcePath = path.join(getVoicePresetSeedDir(), fileName);
  try {
    await fs.access(sourcePath);
  } catch {
    return null;
  }
  const targetPath = toUploadTargetPath(fileName);
  try {
    await fs.access(targetPath);
  } catch {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
  return targetPath;
}
