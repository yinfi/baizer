export interface ClipProtocolParams {
  [key: string]: string | undefined;
  url?: string;
}

export interface ClipProtocolResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface ClipProtocolHandlerOptions {
  saveUrl: (url: string) => Promise<ClipProtocolResult>;
  notify?: (message: string) => void;
}

export function parseBaizerClipProtocolParams(params: ClipProtocolParams): { url: string | null } {
  const rawUrl = typeof params.url === 'string' ? params.url.trim() : '';
  if (!rawUrl) return { url: null };

  let decodedUrl = rawUrl;
  try {
    decodedUrl = decodeURIComponent(rawUrl);
  } catch {
    decodedUrl = rawUrl;
  }

  const normalizedUrl = decodedUrl.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    return { url: null };
  }

  return { url: normalizedUrl };
}

export class BaizerClipProtocolHandler {
  constructor(private readonly options: ClipProtocolHandlerOptions) {}

  async handle(params: ClipProtocolParams): Promise<ClipProtocolResult> {
    const { url } = parseBaizerClipProtocolParams(params);
    if (!url) {
      const error = 'Invalid clip URL. Expected obsidian://baizer-clip?url=<encoded-http-url>.';
      this.options.notify?.(error);
      return { success: false, error };
    }

    this.options.notify?.(`Clipping: ${url}`);
    const result = await this.options.saveUrl(url);

    if (result.success && result.path) {
      this.options.notify?.(`Saved: ${result.path}`);
    } else {
      this.options.notify?.(`Failed to clip URL: ${result.error || 'unknown error'}`);
    }

    return result;
  }
}
