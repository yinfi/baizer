export interface ClipSaveResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface SaveClipTextOptions {
  text: string;
  saveUrl: (url: string) => Promise<ClipSaveResult>;
}

const URL_PATTERN = /https?:\/\/[^\s<>'"`]+/i;
const TRAILING_PUNCTUATION = /[\.,\uFF0C\u3002\uFF01!\?\uFF1F:;\uFF1A\uFF1B\u3001\)\uFF09\]\u3011\u300B>]+$/;

export function extractFirstHttpUrl(input: string): string | null {
  const match = input.match(URL_PATTERN);
  if (!match) return null;

  let url = match[0].trim();
  while (TRAILING_PUNCTUATION.test(url)) {
    url = url.replace(TRAILING_PUNCTUATION, '');
  }

  return url || null;
}

export async function saveClipText(options: SaveClipTextOptions): Promise<ClipSaveResult> {
  const url = extractFirstHttpUrl(options.text);
  if (!url) return { success: false, error: 'No http/https URL found.' };
  return options.saveUrl(url);
}
