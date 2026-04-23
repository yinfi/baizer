import { MemoryManager } from '../memory/memory-manager';
import { IModelProvider } from '../models/interfaces';
import { SkillRegistry } from '../skills/skill-registry';
import { ToolRegistry } from '../skills/tool-registry';
import { DefaultChatRuntime } from './chat-runtime';

interface CreateChatRuntimeArgs {
  provider: IModelProvider;
  memoryManager: MemoryManager | null;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
}

export function createChatRuntime(args: CreateChatRuntimeArgs) {
  return new DefaultChatRuntime(args);
}
