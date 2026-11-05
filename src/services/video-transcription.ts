/**
 * video-transcription —— 音频转写（pi runtime 不覆盖的多模态旁路）。
 *
 * ⚠️ 这是全项目唯一有意保留的「非 pi runtime」LLM 调用点，属于显式例外：
 * pi-ai 的 Model.input 只支持 ("text" | "image")，没有 audio 模态，
 * UserMessage.content 也只接受 text/image 块，无法承载音频转写任务。
 * 因此这里直接打 OpenAI 方言的 /audio/transcriptions 端点，绕过 model-service 与 pi runtime。
 *
 * 历史上这里还有一条 Gemini 分支（直接用 @google/generative-ai SDK 以 inlineData
 * 提交音频）。'gemini' 协议整体移除后，该分支与那个依赖一起删除。
 *
 * 本轮改造（视频转写最小方案）解决了四个此前写在证据文档里的局限：
 *  1. 端点、模型、语言此前写死（whisper-1），且只有 activeProvider 是 openai-compatible
 *     时才会被调用 —— 只配 Anthropic 的用户完全无法转写。现在端点/模型/语言可配置，
 *     门禁也从「provider 类型」改成「能否解析出转写端点」。
 *  2. 整条音轨一次 POST，没有上限也没有重试粒度。现在先解码成 16 kHz PCM，
 *     再按「≤45 s、以静音段中点为切点」切片，逐片请求（见 asr-chunking.ts）。
 *  3. 只保留 data.text，时间戳被丢掉。现在保留 segment（start/end/text），
 *     并把每片的窗口偏移加回去，得到全片可对齐的时间轴。
 *  4. 失败被 catch(_) 吞掉。现在错误带上「第几片 / 共几片」与端点响应正文，
 *     由调用方展示给用户（见 web-clipper/executor.ts）。
 *
 * 不依赖 src/models 旧 provider 层——只用 ProviderConfig 读取凭证/端点。
 * 若将来 pi-ai 支持 audio 输入，应将此并入统一 runtime。
 */
import { requestUrl } from 'obsidian';
import {
  NO_ASR_ENDPOINT_MESSAGE,
  ProviderConfig,
  ResolvedAsrConfig,
  resolveAsrConfig,
} from '../mcp/types';
import { extractJsonAssignment } from '../utils/video_utils';
import {
  ASR_TARGET_SAMPLE_RATE,
  ChunkWindow,
  PcmSource,
  detectSilences,
  encodeWav16,
  mixToMono,
  planChunkWindows,
} from './asr-chunking';

export interface TranscriptSegment {
  /** 相对整条音轨起点的秒数（不是相对分片起点）。 */
  start: number;
  end: number;
  text: string;
}

export interface AudioTranscriptionResult {
  /** 全片纯文本。保留它是为了不打断既有调用方（摘要、4000 字截断的上下文）。 */
  text: string;
  /** 段级结果，带整轨时间戳。 */
  segments: TranscriptSegment[];
  audioUrl: string;
  /** 'chunked' = 走了切片；'single' = 解码不可用时的整轨回退。 */
  mode: 'chunked' | 'single';
  chunkCount: number;
  durationSec: number;
  /**
   * 非致命说明（例如「解码失败，已回退整轨提交」）。
   * 调用方必须把它展示出来：静默降级与静默失败一样不可接受。
   */
  warnings: string[];
}

/** 把解码好的音频交给转写层。抽成依赖是为了让单测不必依赖 Web Audio。 */
export type AudioDecoder = (bytes: ArrayBuffer) => Promise<PcmSource>;

interface VideoTranscriptionDeps {
  requestUrl: typeof requestUrl;
  fetchImpl: typeof fetch;
  decodeAudio: AudioDecoder;
}

/**
 * 用 Web Audio 解码成 PCM。
 *
 * 为什么是它：插件不能打包 ffmpeg（体积），也不能 spawn 宿主 ffmpeg（移动端），
 * 而 Web Audio 的 decodeAudioData 是唯一在桌面端与移动端都可用、且零依赖的解码器。
 *
 * 采样率取 16 kHz：decodeAudioData 会按 AudioContext 的采样率重采样，
 * 于是这一步同时完成了 Whisper 需要的降采样，内存与上传体积都随之下降。
 *
 * 必须传副本：规范要求 decodeAudioData **立即 detach** 入参 ArrayBuffer（即使解码失败），
 * 而调用方在解码失败时还要拿原缓冲走整轨回退路径。
 */
export async function decodeWithWebAudio(bytes: ArrayBuffer): Promise<PcmSource> {
  const globalScope = window as any;
  const Ctor = globalScope.OfflineAudioContext || globalScope.webkitOfflineAudioContext;
  if (typeof Ctor !== 'function') {
    throw new Error('Web Audio (OfflineAudioContext) is unavailable in this environment');
  }

  const context = new Ctor(1, 1, ASR_TARGET_SAMPLE_RATE);
  const decoded = await new Promise<any>((resolve, reject) => {
    const maybePromise = context.decodeAudioData(bytes.slice(0), resolve, reject);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(resolve, reject);
    }
  });

  if (!decoded || typeof decoded.getChannelData !== 'function' || !(decoded.length > 0)) {
    throw new Error('Decoded audio contains no samples');
  }

  return decoded as PcmSource;
}

/**
 * 默认的 fetchImpl：经 Obsidian requestUrl 发送（不受 CORS 限制，移动端同样可用）。
 * requestUrl 不接受 FormData，所以先借 Request 把 multipart 体序列化成 ArrayBuffer，
 * 并沿用其带 boundary 的 Content-Type。只实现调用方用到的 Response 成员（ok/status/text/json）。
 */
async function requestUrlFetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => { headers[key] = value; });
  const res = await requestUrl({ url: req.url, method: req.method, headers, body, throw: false });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    text: async () => res.text,
    json: async () => res.json,
  } as unknown as Response;
}

const defaultDeps: VideoTranscriptionDeps = {
  requestUrl: (options) => requestUrl(options),
  fetchImpl: requestUrlFetchImpl,
  decodeAudio: (bytes) => decodeWithWebAudio(bytes),
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function getTranscriptionEndpoint(baseUrl: string): string {
  return joinUrl(baseUrl, '/audio/transcriptions');
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/**
 * 端点返回非 2xx 时抛出，并保留状态码。
 *
 * 为什么需要状态码：response_format=verbose_json 是本次改造新增的参数，而改动前这里
 * 只发 model —— 有的 OpenAI 方言实现会对不认识的 response_format 直接回 400。
 * 那会让「本来能用」的用户被这次改动打挂，所以调用方要能分辨「参数被拒」并降级重试
 * （见 isParameterRejection / postWithFormatFallback）。
 */
export class TranscriptionHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TranscriptionHttpError';
    this.status = status;
  }
}

/**
 * 参数类拒绝：400 / 415 / 422。
 *
 * 鉴权(401/403)、找不到(404)、限流(429) 与服务端错误(5xx) 都跟 response_format 无关，
 * 去掉参数重试只会把同一个错误再打一遍，所以这里必须按状态码收窄。
 */
export function isParameterRejection(error: unknown): boolean {
  return error instanceof TranscriptionHttpError
    && (error.status === 400 || error.status === 415 || error.status === 422);
}

function pickBilibiliAudioUrl(html: string): string | null {
  const playInfo = extractJsonAssignment(html, 'window.__playinfo__=')
    || extractJsonAssignment(html, '__playinfo__=');
  const audioTracks = playInfo?.data?.dash?.audio;
  if (!Array.isArray(audioTracks) || audioTracks.length === 0) return null;

  const selected = audioTracks.find((track: any) => track?.baseUrl || track?.base_url) || audioTracks[0];
  return selected?.baseUrl || selected?.base_url || selected?.backupUrl?.[0] || selected?.backup_url?.[0] || null;
}

function pickYouTubeAudioUrl(html: string): string | null {
  const playerResponse = extractJsonAssignment(html, 'var ytInitialPlayerResponse = ')
    || extractJsonAssignment(html, 'ytInitialPlayerResponse = ')
    || extractJsonAssignment(html, 'ytInitialPlayerResponse=');
  const formats = playerResponse?.streamingData?.adaptiveFormats;
  if (!Array.isArray(formats)) return null;

  const selected = formats.find((format: any) => typeof format?.mimeType === 'string' && format.mimeType.startsWith('audio/'));
  return selected?.url || null;
}

async function resolveAudio(params: {
  url: string;
  platform: 'youtube' | 'bilibili';
  deps: VideoTranscriptionDeps;
}): Promise<{ audioUrl: string; audioBuffer: ArrayBuffer }> {
  const pageResponse = await params.deps.requestUrl({
    url: params.url,
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (pageResponse.status !== 200) {
    throw new Error(`Failed to fetch video page: HTTP ${pageResponse.status}`);
  }

  const html = pageResponse.text;
  const audioUrl = params.platform === 'bilibili'
    ? pickBilibiliAudioUrl(html)
    : pickYouTubeAudioUrl(html);

  if (!audioUrl) {
    throw new Error(`Unable to resolve audio stream URL for ${params.platform} video`);
  }

  const audioResponse = await params.deps.requestUrl({
    url: audioUrl,
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (audioResponse.status !== 200) {
    throw new Error(`Failed to download audio stream: HTTP ${audioResponse.status}`);
  }

  return {
    audioUrl,
    audioBuffer: audioResponse.arrayBuffer,
  };
}

/**
 * 把一次端点响应当成「窗口 window 内的转写」来解释。
 *
 * 时间戳偏移在这里加回去 —— 这是切片方案最容易错的一步：端点返回的 start/end 是
 * **相对分片**的，直接用会让第 10 片的所有时间码都回到 0 附近。
 *
 * response_format=verbose_json 才带 segments；端点若忽略它只回了 text，
 * 就退化成「一个覆盖整个窗口的段」，而不是丢掉时间轴。
 */
export function parseTranscriptionPayload(
  payload: any,
  window: ChunkWindow,
): { text: string; segments: TranscriptSegment[] } {
  const segments: TranscriptSegment[] = [];

  if (Array.isArray(payload?.segments)) {
    for (const raw of payload.segments) {
      const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
      if (!text) continue;
      const start = Number(raw?.start);
      const end = Number(raw?.end);
      segments.push({
        start: Number.isFinite(start) ? window.startSec + start : window.startSec,
        end: Number.isFinite(end) ? window.startSec + end : window.endSec,
        text,
      });
    }
  }

  const flat = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (segments.length === 0 && flat) {
    segments.push({ start: window.startSec, end: window.endSec, text: flat });
  }

  return {
    text: flat || segments.map((segment) => segment.text).join(' '),
    segments,
  };
}

/** mm:ss / h:mm:ss。段级时间戳要落进笔记，就必须是用户能一眼对上的形式。 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 把段级结果渲染成「[mm:ss] 文本」的逐行形式；无段时返回空串，由调用方回退到纯文本。 */
export function formatTimestampedTranscript(segments: TranscriptSegment[]): string {
  return segments
    .filter((segment) => typeof segment?.text === 'string' && segment.text.trim().length > 0)
    .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text.trim()}`)
    .join('\n');
}

interface TranscriptionRequestParams {
  endpoint: string;
  apiKey: string;
  model: string;
  language: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  /**
   * 请求的 response_format。null = 不发送这个参数。
   * 只有 verbose_json 会带回 segments；没有它就只剩一个扁平字符串，时间轴无从谈起，
   * 因此默认发 verbose_json，仅在端点明确拒绝它时降级为 null。
   */
  responseFormat: string | null;
  deps: VideoTranscriptionDeps;
}

async function postTranscriptionRequest(params: TranscriptionRequestParams): Promise<any> {
  const formData = new FormData();
  const blob = new Blob([params.bytes as unknown as BlobPart], { type: params.mimeType });
  formData.append('file', blob, params.filename);
  formData.append('model', params.model);
  if (params.responseFormat) formData.append('response_format', params.responseFormat);
  if (params.language) formData.append('language', params.language);

  const headers: Record<string, string> = {};
  // 回环/自建端点通常不校验 key，此时不发空的 Authorization 头，
  // 免得把 "Bearer " 这种畸形头塞给别人的服务。
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;

  const response = await params.deps.fetchImpl(params.endpoint, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const details = typeof (response as any).text === 'function'
      ? await (response as any).text()
      : '';
    throw new TranscriptionHttpError(
      response.status,
      `HTTP ${response.status}${details ? ` - ${truncate(details, 300)}` : ''}`,
    );
  }

  return typeof (response as any).json === 'function' ? await (response as any).json() : {};
}

/** 本次运行里 response_format 的协商状态。`degraded` 会被写成一条用户可见的 warning。 */
interface ResponseFormatState {
  verboseJson: boolean;
  degraded: boolean;
}

const RESPONSE_FORMAT_DEGRADED_WARNING =
  'The endpoint rejected response_format=verbose_json, so timestamps fall back to one entry per chunk '
  + 'instead of one per segment.';

/**
 * 发一次请求；若端点明确因为参数被拒（400/415/422），去掉 response_format 重试一次。
 *
 * 为什么值得多这 15 行：改动前这个 POST 只带 model，任何 OpenAI 方言的端点都能收。
 * 本次新增了 response_format=verbose_json，而它并非所有实现都认 —— 一个会因为
 * 「不认识的参数」回 400 的服务，会让原本可用的用户在升级后彻底转写不了。
 * 降级后时间戳退化成「一片一个时间戳」，但那仍然远好过失败，且用户会被告知。
 *
 * 状态记在 state 上而不是每次重试：第一个分片确认端点不收该参数后，
 * 后面 99 个分片不应该再各撞一次 400。
 */
async function postWithFormatFallback(
  params: Omit<TranscriptionRequestParams, 'responseFormat'>,
  state: ResponseFormatState,
): Promise<any> {
  if (!state.verboseJson) {
    return postTranscriptionRequest({ ...params, responseFormat: null });
  }

  try {
    return await postTranscriptionRequest({ ...params, responseFormat: 'verbose_json' });
  } catch (error) {
    if (!isParameterRejection(error)) throw error;
    state.verboseJson = false;
    state.degraded = true;
    // 重试仍然失败时，抛出的是重试的错误：它才是「去掉那个参数之后」的真实原因。
    return postTranscriptionRequest({ ...params, responseFormat: null });
  }
}

export function createVideoTranscriptionService(partialDeps: Partial<VideoTranscriptionDeps> = {}) {
  const deps: VideoTranscriptionDeps = {
    ...defaultDeps,
    ...partialDeps,
  };

  return {
    async transcribeFromVideoUrl(params: {
      url: string;
      platform: 'youtube' | 'bilibili';
      provider: ProviderConfig;
      asr?: ResolvedAsrConfig;
    }): Promise<AudioTranscriptionResult> {
      const config = params.asr ?? resolveAsrConfig({ provider: params.provider });
      if (!config) throw new Error(NO_ASR_ENDPOINT_MESSAGE);

      const resolved = await resolveAudio({
        url: params.url,
        platform: params.platform,
        deps,
      });
      const audioUrl = resolved.audioUrl;
      let audioBuffer: ArrayBuffer | null = resolved.audioBuffer;

      const endpoint = getTranscriptionEndpoint(config.baseUrl);
      const warnings: string[] = [];
      const segments: TranscriptSegment[] = [];
      const chunkTexts: string[] = [];
      const formatState: ResponseFormatState = { verboseJson: true, degraded: false };

      let decoded: PcmSource | null = null;
      try {
        decoded = await deps.decodeAudio(audioBuffer);
      } catch (error) {
        // 解码失败不是致命错误：整轨提交是改动前的行为，至少还能转写短音频。
        // 但必须留下 warnings，由调用方展示 —— 静默降级会让用户以为切片生效了。
        warnings.push(
          `Audio could not be decoded for chunking (${describeError(error)}). `
          + 'The whole track was submitted as a single request instead.',
        );
      }

      if (decoded && decoded.length > 0 && decoded.sampleRate > 0) {
        // 解码成功 = 整条压缩音轨后面再也用不到。立刻断开引用，让它在漫长的逐片请求
        // 期间就可以被回收（一小时 128 kbps 的 m4a 约 57 MB），而不是一直挂到函数返回。
        audioBuffer = null;

        const sampleRate = decoded.sampleRate;
        const durationSec = decoded.length / sampleRate;
        const windows = planChunkWindows({
          durationSec,
          silences: detectSilences(decoded),
        });

        for (let index = 0; index < windows.length; index += 1) {
          const window = windows[index];
          const samples = mixToMono(decoded, window.startSec * sampleRate, window.endSec * sampleRate);
          const wav = encodeWav16(samples, sampleRate);
          let payload: any;
          try {
            payload = await postWithFormatFallback({
              endpoint,
              apiKey: config.apiKey,
              model: config.model,
              language: config.language,
              bytes: wav,
              mimeType: 'audio/wav',
              filename: `chunk-${String(index + 1).padStart(3, '0')}.wav`,
              deps,
            }, formatState);
          } catch (error) {
            throw new Error(
              `Audio transcription failed on chunk ${index + 1}/${windows.length} `
              + `(${formatTimestamp(window.startSec)}-${formatTimestamp(window.endSec)}): ${describeError(error)}`,
            );
          }

          const parsed = parseTranscriptionPayload(payload, window);
          if (parsed.text) chunkTexts.push(parsed.text);
          segments.push(...parsed.segments);
        }

        if (formatState.degraded) warnings.push(RESPONSE_FORMAT_DEGRADED_WARNING);

        // 每一片都返回空 = 端点其实什么也没转写出来。不能把空字符串当成成功往下传，
        // 否则用户拿到的是一篇「有摘要、没转录」的笔记，与改动前被吞掉的失败同一种症状。
        if (segments.length === 0 && chunkTexts.length === 0) {
          throw new Error('Audio transcription returned empty text for every chunk');
        }

        return {
          text: chunkTexts.join(' ').trim(),
          segments,
          audioUrl,
          mode: 'chunked',
          chunkCount: windows.length,
          durationSec,
          warnings,
        };
      }

      // 整轨回退：与改动前的请求形状保持一致（原容器、原 MIME）。
      let payload: any;
      try {
        payload = await postWithFormatFallback({
          endpoint,
          apiKey: config.apiKey,
          model: config.model,
          language: config.language,
          bytes: new Uint8Array(audioBuffer),
          mimeType: 'audio/mp4',
          filename: 'video-audio.m4a',
          deps,
        }, formatState);
      } catch (error) {
        throw new Error(`Audio transcription failed: ${describeError(error)}`);
      }

      const parsed = parseTranscriptionPayload(payload, { startSec: 0, endSec: 0 });
      if (!parsed.text) throw new Error('Audio transcription returned empty text');
      if (formatState.degraded) warnings.push(RESPONSE_FORMAT_DEGRADED_WARNING);

      return {
        text: parsed.text,
        segments: parsed.segments,
        audioUrl,
        mode: 'single',
        chunkCount: 1,
        durationSec: 0,
        warnings,
      };
    },
  };
}