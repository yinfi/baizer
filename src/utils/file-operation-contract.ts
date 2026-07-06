export const FILE_OPERATION_CONTRACT_TEXT =
  'The user is asking you to create, save, update, or otherwise modify a vault file. You must call an appropriate vault write tool such as create_file, create_note, update_file, update_note, append_to_note, save_webpage, rename_note, or delete_note. Do not provide copy-paste instructions, raw file contents, or claims that a file was created unless a write tool actually runs successfully.';

export const FILE_WRITE_TOOL_NAMES = [
  'create_file',
  'update_file',
  'create_note',
  'update_note',
  'append_to_note',
  'rename_note',
  'delete_note',
  'save_webpage',
] as const;

const FILE_WRITE_INTENT_TERMS = [
  'create',
  'save',
  'write',
  'modify',
  'update',
  'append',
  'rename',
  'delete',
  '\u521b\u5efa',
  '\u65b0\u5efa',
  '\u751f\u6210',
  '\u4fdd\u5b58',
  '\u5199\u5165',
  '\u4fee\u6539',
  '\u66f4\u65b0',
  '\u8ffd\u52a0',
  '\u91cd\u547d\u540d',
  '\u5220\u9664',
];

const FILE_TARGET_TERMS = [
  'file',
  'note',
  'canvas',
  '.canvas',
  '.base',
  '.md',
  'markdown',
  '\u6587\u4ef6',
  '\u7b14\u8bb0',
  '\u5de5\u4f5c\u533a',
];

// 疑问/分析类信号:命中则不判为写文件请求(用户在「讨论/询问文件」,而非「要求写文件」)。
// 修掉「文件…被修改的原因是什么」这类被误判为写操作、进而误报「No file was created」的坑。
const INTERROGATIVE_TERMS = [
  '?',
  '？', // 全角问号
  '吗', // 吗
  '呢', // 呢
  '什么', // 什么
  '为何', // 为何
  '为什么', // 为什么
  '原因', // 原因
  '怎么', // 怎么
  '怎样', // 怎样
  '如何', // 如何
  '是不是', // 是不是
  '会不会', // 会不会
  '可能', // 可能
  '解释', // 解释
  '区别', // 区别
  'why',
  'what',
  'how ',
  'explain',
];

export function isFileWriteRequest(message: string): boolean {
  const normalized = message.toLowerCase();
  const writeIntent = FILE_WRITE_INTENT_TERMS.some(term => normalized.includes(term));
  if (!writeIntent) return false;
  if (!FILE_TARGET_TERMS.some(term => normalized.includes(term))) return false;
  // 关键词共现太粗:疑问/分析类句子(如"文件被修改的原因是什么")不是写请求,排除掉,
  // 避免误注入文件写入契约 + 误报「No file was created」。
  if (INTERROGATIVE_TERMS.some(term => normalized.includes(term))) return false;
  return true;
}

export function isFileWriteToolName(name: string): boolean {
  return (FILE_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

export function isSuccessfulWriteToolResult(result: any): boolean {
  return result?.success === true || result?.status === 'success';
}

export function getFileWriteError(result: any): string {
  if (typeof result?.error === 'string' && result.error.trim()) return result.error.trim();
  if (typeof result?.message === 'string' && result.message.trim()) {
    if (result?.success === false || result?.status === 'error') {
      return result.message.trim();
    }
  }
  return '';
}

export function buildFileWriteFailureMessage(attemptedWrite: boolean, lastError?: string): string {
  if (!attemptedWrite) {
    return 'No file was created or modified because no vault write tool ran. Please try again; file requests must be completed through workspace tools, not copy-paste output.';
  }

  const errorSuffix = lastError ? ` Last tool error: ${lastError}.` : '';
  return `No file was created or modified because no vault write tool completed successfully.${errorSuffix} Please try again; file requests must be completed through workspace tools, not copy-paste output.`;
}

export function getFileWriteResultPath(
  action: string,
  result: any,
  args: Record<string, any>,
): string {
  if (typeof result?.path === 'string') return result.path;
  if (typeof result?.target === 'string') return result.target;
  if (action === 'create_note' && typeof args.filename === 'string') return args.filename;
  if (action === 'rename_note' && typeof args.newPath === 'string') return args.newPath;
  if (typeof args.path === 'string') return args.path;
  return '';
}
