/**
 * asr-chunking —— 把一段音频切成「以静音为切点、单片不超过 ~45 s」的窗口，并把窗口编码成 WAV。
 *
 * 为什么需要它：转写端点（OpenAI 方言的 /audio/transcriptions）对单次请求体积有限制，
 * 而整条音轨一次性 POST 既没有上限也没有重试粒度；长视频会直接失败。更隐蔽的是质量：
 * 参考项目实测过一次 299 s 的整轨请求让所有时间码整体压早 13 s，切片后 |Δstart| 均值降到 0.02 s。
 *
 * 本模块是**纯函数**：不碰 DOM、不碰 node:*、不发请求。PcmSource 与 Web Audio 的
 * AudioBuffer 结构兼容（sampleRate / length / channelCount / getChannelData），
 * 因此调用方可以直接把解码结果递进来，而测试可以递一个纯 JS 的假实现。
 *
 * 移动端约束：整个文件零 import，故不引入任何平台能力，桌面端与移动端同一条代码路径。
 */

/** 转写端点的目标采样率。Whisper 内部也工作在 16 kHz，先降采样能显著减少内存与上传体积。 */
export const ASR_TARGET_SAMPLE_RATE = 16000;

/** 单片上限（秒）。与参考项目 asr.js 的 maxChunk 一致。 */
export const DEFAULT_MAX_CHUNK_SEC = 45;

/**
 * 单片下限（秒）。它不约束「切片必须这么长」，而是约束**切点选在哪里**：
 * 若在某处切开会留下一段短于它的尾巴，就宁可往前找一个更早的切点，
 * 让尾巴自己成为一个正常长度的窗口。见 planChunkWindows。
 */
export const DEFAULT_MIN_CHUNK_SEC = 8;

/** 多声道 PCM 的最小接口。Web Audio 的 AudioBuffer 天然满足。 */
export interface PcmSource {
  sampleRate: number;
  /** 每声道样本数 */
  length: number;
  channelCount: number;
  getChannelData(channel: number): Float32Array;
}

export interface SilenceRange {
  startSec: number;
  endSec: number;
  /** 切点：静音段中点。切在静音正中间最不容易切掉半个字。 */
  midSec: number;
}

export interface ChunkWindow {
  startSec: number;
  endSec: number;
}

export interface SilenceDetectionOptions {
  /** 判定帧长（毫秒）。20 ms 是语音活动检测的常用粒度。 */
  frameMs?: number;
  /** 静音阈值（dBFS）。 */
  thresholdDb?: number;
  /** 最短静音时长（秒）：更短的停顿不算切点，否则会把句内换气当边界。 */
  minSilenceSec?: number;
  /**
   * 是否在「一个静音段都找不到」时用底噪估计重试一次。默认开。
   * 见 detectSilences 里的说明。
   */
  adaptiveFallback?: boolean;
}

function toChannels(source: PcmSource): Float32Array[] {
  const channels: Float32Array[] = [];
  const count = Math.max(1, Math.floor(source.channelCount || 1));
  for (let channel = 0; channel < count; channel += 1) {
    const data = source.getChannelData(channel);
    if (data && typeof data.length === 'number') channels.push(data);
  }
  if (channels.length === 0) {
    throw new Error('PcmSource has no readable channel data');
  }
  return channels;
}

/**
 * 逐帧算 RMS 并转成 dBFS。多声道按「所有声道的所有样本」求均方，
 * 这样单声道静音、另一声道有噪声的素材不会被误判成静音。
 *
 * 数字静音（全 0）得到 -Infinity，它在所有 `<= thresholdDb` 比较里都成立，
 * 因此不需要特判。
 */
export function frameRmsDb(source: PcmSource, frameSize: number): Float32Array {
  const channels = toChannels(source);
  const frames = Math.floor(source.length / frameSize);
  const out = new Float32Array(Math.max(0, frames));
  const divisor = frameSize * channels.length;

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * frameSize;
    let sum = 0;
    for (let channel = 0; channel < channels.length; channel += 1) {
      const data = channels[channel];
      for (let i = 0; i < frameSize; i += 1) {
        const sample = data[offset + i];
        if (sample) sum += sample * sample;
      }
    }
    const rms = Math.sqrt(sum / divisor);
    out[frame] = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }

  return out;
}

/** 低分位数。用于估计底噪，不改动入参。 */
function percentile(values: Float32Array, fraction: number): number {
  if (values.length === 0) return -Infinity;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function collectSilenceRuns(
  frames: Float32Array,
  frameMs: number,
  thresholdDb: number,
  minSilenceSec: number,
): SilenceRange[] {
  const minFrames = Math.max(1, Math.ceil((minSilenceSec * 1000) / frameMs));
  const ranges: SilenceRange[] = [];
  let runStart = -1;

  const flush = (endFrame: number) => {
    if (runStart < 0) return;
    if (endFrame - runStart >= minFrames) {
      const startSec = (runStart * frameMs) / 1000;
      const endSec = (endFrame * frameMs) / 1000;
      ranges.push({ startSec, endSec, midSec: (startSec + endSec) / 2 });
    }
    runStart = -1;
  };

  for (let frame = 0; frame <= frames.length; frame += 1) {
    const silent = frame < frames.length && frames[frame] <= thresholdDb;
    if (silent) {
      if (runStart < 0) runStart = frame;
    } else {
      flush(frame);
    }
  }

  return ranges;
}

/**
 * 找出所有「足够长且足够安静」的区间。
 *
 * 自适应重试的理由：固定 -40 dBFS 在两类真实素材上会一个静音段都找不到 ——
 * 整轨电平偏低的录音，以及底噪偏高的手机外录。此时切片会退化成「每 45 s 硬切」，
 * 切点落在词中间的概率大幅上升，正是切片本要避免的伤害。故先用帧能量的 20 分位
 * 估计底噪，抬一个相对阈值重试一次；正常素材在第一轮就返回，不受影响。
 */
export function detectSilences(
  source: PcmSource,
  options: SilenceDetectionOptions = {},
): SilenceRange[] {
  const frameMs = options.frameMs ?? 20;
  const thresholdDb = options.thresholdDb ?? -40;
  const minSilenceSec = options.minSilenceSec ?? 0.6;
  const frameSize = Math.max(1, Math.round((source.sampleRate * frameMs) / 1000));

  const frames = frameRmsDb(source, frameSize);
  if (frames.length === 0) return [];

  const ranges = collectSilenceRuns(frames, frameMs, thresholdDb, minSilenceSec);
  if (ranges.length > 0 || options.adaptiveFallback === false) return ranges;

  // 用 5 分位而不是 20 分位：静音段在整段素材里通常是少数，
  // 20 分位会被语音帧本身抬起来，估出的「底噪」偏高，自适应阈值反而把语音也判成静音。
  const floorDb = percentile(frames, 0.05);
  if (!Number.isFinite(floorDb)) return ranges;
  const adaptiveDb = Math.min(-25, Math.max(-70, floorDb + 6));
  // 更严的阈值不可能带来更多静音段，直接返回第一轮结果。
  if (adaptiveDb <= thresholdDb) return ranges;
  return collectSilenceRuns(frames, frameMs, adaptiveDb, minSilenceSec);
}

/**
 * 规划切片窗口。
 *
 * 规则（每一条都对应一个具体失败）：
 * 1. 每个窗口**不超过** maxChunkSec —— 这是请求体积上限，不能被「更好听」牺牲掉；
 * 2. 切点优先落在窗口内**最晚**的那个静音段中点 —— 越晚切，单片越接近上限，片数越少；
 * 3. 但切点不得早于 cursor+minChunkSec（避免出现 2 s 的碎片片）；
 * 4. 切点也不得晚到让**剩下的尾巴**短于 minChunkSec，否则宁可往前找更早的切点：
 *    例如总长 46 s、无静音时，硬切在 45 s 会留下 1 s 的尾巴，改切在 38 s
 *    得到 38 s + 8 s 两片，仍然是两片，但两片都正常。
 * 5. 找不到任何静音段时退化为按 hi 硬切（即「尽量接近上限，但不留碎尾」）。
 */
export function planChunkWindows(params: {
  durationSec: number;
  silences?: SilenceRange[];
  maxChunkSec?: number;
  minChunkSec?: number;
}): ChunkWindow[] {
  const maxChunkSec = params.maxChunkSec ?? DEFAULT_MAX_CHUNK_SEC;
  const minChunkSec = params.minChunkSec ?? DEFAULT_MIN_CHUNK_SEC;
  const durationSec = Math.max(0, params.durationSec);
  if (!(durationSec > 0)) return [];

  const silences = (params.silences ?? [])
    .filter((range) => Number.isFinite(range?.midSec))
    .slice()
    .sort((a, b) => a.midSec - b.midSec);

  const windows: ChunkWindow[] = [];
  let cursor = 0;
  // 上限防御：durationSec 若来自坏数据（NaN/Infinity）会在上面被过滤，
  // 这里再兜一层，保证循环一定会终止。
  const guard = Math.ceil(durationSec / Math.max(1, minChunkSec)) + 2;

  for (let step = 0; step < guard && cursor < durationSec - 1e-6; step += 1) {
    const remaining = durationSec - cursor;
    if (remaining <= maxChunkSec) {
      windows.push({ startSec: cursor, endSec: durationSec });
      break;
    }

    const lowerBound = cursor + minChunkSec;
    const upperBound = Math.min(cursor + maxChunkSec, durationSec - minChunkSec);

    let cut = upperBound;
    for (const range of silences) {
      if (range.midSec >= lowerBound && range.midSec <= upperBound) cut = range.midSec;
    }

    if (!(cut > cursor)) cut = cursor + maxChunkSec;
    windows.push({ startSec: cursor, endSec: cut });
    cursor = cut;
  }

  return windows;
}

/**
 * 把 [startSample, endSample) 区间混成单声道 Float32。
 *
 * 只在**需要的那一片**上分配内存：整轨混音会在内存里再放一份与整轨等长的
 * Float32，而逐片混音只多出「一片」的量（16 kHz 下 45 s 约 2.9 MB）。
 */
export function mixToMono(source: PcmSource, startSample: number, endSample: number): Float32Array {
  const channels = toChannels(source);
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(source.length, Math.ceil(endSample));
  const length = Math.max(0, end - start);
  const out = new Float32Array(length);
  if (length === 0) return out;

  const scale = 1 / channels.length;
  for (let channel = 0; channel < channels.length; channel += 1) {
    const data = channels[channel];
    for (let i = 0; i < length; i += 1) {
      const sample = data[start + i];
      if (sample) out[i] += sample * scale;
    }
  }

  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * 编码成 16 位单声道 PCM WAV（44 字节标准头 + data）。
 *
 * 选 WAV 而不是别的容器：它是唯一「不需要任何编码器就能拼出来」的格式 ——
 * 只有 WAV 能让插件在不打包 ffmpeg、不引入依赖的前提下，把内存里的 PCM
 * 变成一个所有 ASR 端点都认的合法音频文件。
 */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率 = 采样率 * 声道数 * 每样本字节
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return new Uint8Array(buffer);
}