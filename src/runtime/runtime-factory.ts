import { PiChatRuntime } from './pi/pi-chat-runtime';
import type { ChatRuntime, ChatRuntimeDeps } from './runtime-types';

export function createChatRuntime(args: ChatRuntimeDeps): ChatRuntime {
  return new PiChatRuntime(args);
}
