export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: unknown;
  };
  thoughtSignature?: string;
  thought?: boolean;
  [key: string]: unknown;
}

export interface GeminiTextLikePart {
  text?: string;
  thoughtSignature?: string;
  thought?: boolean;
  [key: string]: unknown;
}

type GeminiPart = GeminiFunctionCallPart | GeminiTextLikePart;

function clonePart(part: GeminiPart): GeminiPart {
  return JSON.parse(JSON.stringify(part));
}

export function mergeStreamThoughtSignatures(
  aggregatedParts: GeminiPart[],
  streamedParts: GeminiPart[],
): GeminiPart[] {
  const mergedParts = aggregatedParts.map(clonePart);
  const streamedFunctionCallParts = streamedParts.filter(
    (part): part is GeminiFunctionCallPart => !!(part as GeminiFunctionCallPart).functionCall,
  );

  let streamedCallIndex = 0;

  for (const part of mergedParts) {
    if (!(part as GeminiFunctionCallPart).functionCall) continue;

    const streamedPart = streamedFunctionCallParts[streamedCallIndex];
    streamedCallIndex += 1;
    if (!streamedPart?.thoughtSignature) continue;

    (part as GeminiFunctionCallPart).thoughtSignature = streamedPart.thoughtSignature;
    if (streamedPart.thought !== undefined) {
      (part as GeminiFunctionCallPart).thought = streamedPart.thought;
    }
  }

  return mergedParts;
}
