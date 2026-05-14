import { ModelService } from '../services/model-service';
import { ObsidianContextSnapshot } from '../services/obsidian-context-service';
import { UserProfile } from '../memory/types';

export interface GuardianRequestInput {
  prompt: string;
  systemPromptOverride?: string;
  obsidianContext?: ObsidianContextSnapshot;
  userProfile?: UserProfile | null;
}

export async function requestGuardianResponse(
  modelService: ModelService,
  input: GuardianRequestInput,
): Promise<string> {
  return modelService.generate(
    input.prompt,
    input.systemPromptOverride,
    'guardian',
    input.obsidianContext,
    input.userProfile,
  );
}
