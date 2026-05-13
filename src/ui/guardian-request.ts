import { ModelService } from '../services/model-service';

export async function requestGuardianResponse(
  modelService: ModelService,
  prompt: string,
  systemPromptOverride?: string,
): Promise<string> {
  return modelService.generate(prompt, systemPromptOverride);
}
