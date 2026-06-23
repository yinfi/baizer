import { extractFirstHttpUrl } from './clip-input';

export interface ClipProtocolParams {
  [key: string]: string | undefined;
  url?: string;
  text?: string;
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

export interface ClipProtocolRegistrationOptions extends ClipProtocolHandlerOptions {
  warn?: (message: string) => void;
}

export interface ObsidianProtocolRegistrar {
  registerObsidianProtocolHandler: (
    action: string,
    handler: (params: ClipProtocolParams) => void,
  ) => void;
}

function decodeProtocolValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseBaizerClipProtocolParams(params: ClipProtocolParams): { url: string | null } {
  const rawInput = typeof params.url === 'string' && params.url.trim()
    ? params.url
    : typeof params.text === 'string'
      ? params.text
      : '';

  if (!rawInput.trim()) return { url: null };

  const decodedInput = decodeProtocolValue(rawInput).trim();
  return { url: extractFirstHttpUrl(decodedInput) };
}

export class BaizerClipProtocolHandler {
  constructor(private readonly options: ClipProtocolHandlerOptions) {}

  async handle(params: ClipProtocolParams): Promise<ClipProtocolResult> {
    const { url } = parseBaizerClipProtocolParams(params);
    if (!url) {
      const error = 'Invalid clip URL. Expected obsidian://baizer-clip?url=<encoded-http-url> or obsidian://baizer-clip?text=<encoded-share-text>.';
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

function isDuplicateProtocolHandlerError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  return message.includes('baizer-clip') && message.includes('already registered');
}

export function registerBaizerClipProtocolHandler(
  registrar: ObsidianProtocolRegistrar,
  options: ClipProtocolRegistrationOptions,
): boolean {
  const handler = new BaizerClipProtocolHandler(options);
  try {
    registrar.registerObsidianProtocolHandler('baizer-clip', (params) => {
      void handler.handle(params);
    });
    return true;
  } catch (error) {
    if (!isDuplicateProtocolHandlerError(error)) throw error;
    options.warn?.('baizer-clip protocol handler is already registered; skipping duplicate registration.');
    return false;
  }
}
