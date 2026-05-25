import { DefaultChatRuntime } from './chat-runtime';
import { PiChatRuntime } from './pi/pi-chat-runtime';
import { getRuntimeEngine } from './runtime-engine';
import { ChatRuntimeDeps } from './runtime-types';

export function createChatRuntime(args: ChatRuntimeDeps) {
  return getRuntimeEngine() === 'pi'
    ? new PiChatRuntime(args)
    : new DefaultChatRuntime(args);
}
