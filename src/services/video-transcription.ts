/**
 * video-transcription —— 音频转写（pi runtime 不覆盖的多模态旁路）。
 *
 * ⚠️ 这是全项目唯一有意保留的「非 pi runtime」LLM 调用点，属于显式例外：
 * pi-ai 的 Model.input 只支持 ("text" | "image")，没有 audio 模态，
 * UserMessage.content 也只接受 text/image 块，无法承载音频转写任务。
 * 因此这里直接用 @google/generative-ai SDK（Gemini）或 OpenAI-compatible 的
 * /audio/transcriptions 端点（Whisper），绕过 model-service 与 pi runtime。
 *
 * 不依赖 src/models 旧 provider 层——只用 ProviderConfig 读取凭证/端点。
 * 若将来 pi-ai 支持 audio 输入，应将此并入统一 runtime。
 */
import { requestUrl } from 'obsidian';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ProviderConfig } from '../mcp/types';
import { extractJsonAssignment } from '../utils/video_utils';

interface AudioTranscriptionResult {
  text: string;
  audioUrl: string;
}

interface GeminiModelLike {
  generateContent(parts: any): Promise<{ response: { text(): string } }>;
}

interface VideoTranscriptionDeps {
  requestUrl: typeof requestUrl;
  fetchImpl: typeof fetch;
  createGeminiModel: (provider: ProviderConfig) => GeminiModelLike;
}

const defaultDeps: VideoTranscriptionDeps = {
  requestUrl: (options) => requestUrl(options),
  fetchImpl: (input, init) => fetch(input, init),
  createGeminiModel: (provider) => {
    const genAI = new GoogleGenerativeAI(provider.apiKey);
    return genAI.getGenerativeModel({ model: provider.model });
  },
};

function toBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(new Uint8Array(buffer)).toString('base64');
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function getTranscriptionEndpoint(provider: ProviderConfig): string {
  return joinUrl(provider.baseUrl || 'https://api.openai.com/v1', '/audio/transcriptions');
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

async function transcribeWithOpenAICompatible(params: {
  provider: ProviderConfig;
  audioBuffer: ArrayBuffer;
  deps: VideoTranscriptionDeps;
}): Promise<string> {
  const endpoint = getTranscriptionEndpoint(params.provider);
  const formData = new FormData();
  const blob = new Blob([params.audioBuffer], { type: 'audio/mp4' });
  formData.append('file', blob, 'video-audio.m4a');
  formData.append('model', 'whisper-1');

  const response = await params.deps.fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.provider.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const details = typeof (response as any).text === 'function'
      ? await (response as any).text()
      : '';
    throw new Error(`Audio transcription failed: HTTP ${response.status}${details ? ` - ${details}` : ''}`);
  }

  const data = typeof (response as any).json === 'function'
    ? await (response as any).json()
    : {};
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) {
    throw new Error('Audio transcription returned empty text');
  }

  return text;
}

async function transcribeWithGemini(params: {
  provider: ProviderConfig;
  audioBuffer: ArrayBuffer;
  deps: VideoTranscriptionDeps;
}): Promise<string> {
  const model = params.deps.createGeminiModel(params.provider);
  const base64Audio = toBase64(params.audioBuffer);
  const result = await model.generateContent([
    'Transcribe the speech in this audio. Return only the transcript text.',
    {
      inlineData: {
        data: base64Audio,
        mimeType: 'audio/mp4',
      },
    },
  ]);
  const text = result.response.text().trim();
  if (!text) {
    throw new Error('Gemini transcription returned empty text');
  }
  return text;
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
    }): Promise<AudioTranscriptionResult> {
      const { audioUrl, audioBuffer } = await resolveAudio({
        url: params.url,
        platform: params.platform,
        deps,
      });

      const text = params.provider.type === 'gemini'
        ? await transcribeWithGemini({
            provider: params.provider,
            audioBuffer,
            deps,
          })
        : await transcribeWithOpenAICompatible({
            provider: params.provider,
            audioBuffer,
            deps,
          });

      return {
        text,
        audioUrl,
      };
    },
  };
}
