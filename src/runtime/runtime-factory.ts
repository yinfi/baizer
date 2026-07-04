import { HarnessChatRuntime } from './pi/harness-chat-runtime';
import type { ChatRuntime, ChatRuntimeDeps } from './runtime-types';

export function createChatRuntime(args: ChatRuntimeDeps): ChatRuntime {
  return new HarnessChatRuntime(args);
}
