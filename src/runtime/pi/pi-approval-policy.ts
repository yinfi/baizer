import {
  buildFileWriteFailureMessage,
  getFileWriteError,
  isFileWriteToolName,
  isSuccessfulWriteToolResult,
} from '../../utils/file-operation-contract';

export interface PiFileWriteState {
  required: boolean;
  attempted: boolean;
  succeeded: boolean;
  lastError: string;
}

export function isPiApprovalResponse(result: any): result is {
  approval_required: true;
  action?: string;
  target?: string;
  message?: string;
} {
  return !!result && result.approval_required === true;
}

export function formatPiApprovalMessage(result: {
  approval_required?: boolean;
  action?: string;
  target?: string;
  message?: string;
}): string {
  if (result.message) return result.message;
  const action = result.action || 'perform this action';
  const target = result.target ? `: ${result.target}` : '';
  return `Approval required to ${action}${target}`;
}

export function createPiFileWriteState(required: boolean): PiFileWriteState {
  return {
    required,
    attempted: false,
    succeeded: false,
    lastError: '',
  };
}

export function recordPiFileWriteResult(
  state: PiFileWriteState,
  toolName: string,
  result: any,
): void {
  if (!state.required || !isFileWriteToolName(toolName)) return;
  state.attempted = true;
  if (isSuccessfulWriteToolResult(result)) {
    state.succeeded = true;
    return;
  }

  const error = getFileWriteError(result);
  if (error) state.lastError = error;
}

export function resolvePiFinalText(state: PiFileWriteState, modelText: string): string {
  if (!state.required) return modelText;
  if (state.succeeded) return modelText;
  return buildFileWriteFailureMessage(state.attempted, state.lastError);
}
