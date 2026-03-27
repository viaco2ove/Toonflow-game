type ParsedPcmWav = {
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  data: Buffer;
};

function readChunkId(buffer: Buffer, offset: number): string {
  return buffer.toString("ascii", offset, offset + 4);
}

function parsePcmWav(buffer: Buffer): ParsedPcmWav {
  if (buffer.length < 44 || readChunkId(buffer, 0) !== "RIFF" || readChunkId(buffer, 8) !== "WAVE") {
    throw new Error("仅支持标准 WAV 音频混合");
  }

  let fmt: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let data: Buffer | null = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = readChunkId(buffer, offset);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) {
      throw new Error("WAV 音频块结构损坏");
    }

    if (chunkId === "fmt " && chunkSize >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      data = buffer.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt || !data) {
    throw new Error("WAV 音频缺少 fmt/data 数据块");
  }
  if (fmt.audioFormat !== 1) {
    throw new Error("当前仅支持 PCM WAV 音频混合");
  }
  if (fmt.bitsPerSample !== 16) {
    throw new Error("当前仅支持 16-bit PCM WAV 音频混合");
  }
  if (fmt.channels <= 0) {
    throw new Error("WAV 音频声道数无效");
  }

  return {
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    channels: fmt.channels,
    data,
  };
}

function buildPcmWavBuffer(parsed: ParsedPcmWav): Buffer {
  const blockAlign = parsed.channels * (parsed.bitsPerSample / 8);
  const byteRate = parsed.sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + parsed.data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(parsed.channels, 22);
  header.writeUInt32LE(parsed.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(parsed.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(parsed.data.length, 40);
  return Buffer.concat([header, parsed.data]);
}

export function mixPcmWavBuffers(tracks: Array<{ buffer: Buffer; weight?: number | null }>): Buffer {
  const parsedTracks = tracks
    .map((track) => ({
      parsed: parsePcmWav(track.buffer),
      weight: Number.isFinite(Number(track.weight)) ? Number(track.weight) : 1,
    }))
    .filter((track) => track.parsed.data.length > 0);

  if (!parsedTracks.length) {
    throw new Error("没有可混合的音频轨道");
  }

  const base = parsedTracks[0].parsed;
  const bytesPerSample = base.bitsPerSample / 8;
  const frameSize = base.channels * bytesPerSample;
  for (const item of parsedTracks.slice(1)) {
    if (
      item.parsed.sampleRate !== base.sampleRate
      || item.parsed.bitsPerSample !== base.bitsPerSample
      || item.parsed.channels !== base.channels
    ) {
      throw new Error("混合音色失败：参考音频格式不一致");
    }
  }

  const totalWeight = parsedTracks.reduce((sum, item) => sum + Math.max(0, item.weight), 0) || parsedTracks.length;
  const maxSamples = Math.max(...parsedTracks.map((item) => Math.floor(item.parsed.data.length / bytesPerSample)));
  const mixedData = Buffer.alloc(maxSamples * bytesPerSample);

  for (let sampleIndex = 0; sampleIndex < maxSamples; sampleIndex += 1) {
    let mixedSample = 0;
    for (const item of parsedTracks) {
      const dataOffset = sampleIndex * bytesPerSample;
      if (dataOffset + bytesPerSample > item.parsed.data.length) continue;
      const sampleValue = item.parsed.data.readInt16LE(dataOffset);
      mixedSample += sampleValue * (Math.max(0, item.weight) / totalWeight);
    }
    const clamped = Math.max(-32768, Math.min(32767, Math.round(mixedSample)));
    mixedData.writeInt16LE(clamped, sampleIndex * bytesPerSample);
  }

  const alignedLength = Math.floor(mixedData.length / frameSize) * frameSize;
  return buildPcmWavBuffer({
    ...base,
    data: mixedData.subarray(0, alignedLength),
  });
}
