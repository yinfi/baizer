function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== File Operation Contract Tests ===');
  const {
    buildFileWriteFailureMessage,
    FILE_OPERATION_CONTRACT_TEXT,
    getFileWriteResultPath,
    isFileWriteRequest,
    isFileWriteToolName,
    isSuccessfulWriteToolResult,
  } = await import('../src/utils/file-operation-contract');

  await test('detects file write requests in English and Chinese', () => {
    expect(isFileWriteRequest('Create a canvas file for this note')).toBe(true);
    expect(isFileWriteRequest('帮我创建一个canvas文件，总结当前文章')).toBe(true);
    expect(isFileWriteRequest('Save this as a markdown note')).toBe(true);
  });

  await test('does not flag read-only or analysis-only requests as file writes', () => {
    expect(isFileWriteRequest('Explain this canvas structure')).toBe(false);
    expect(isFileWriteRequest('Search the vault for canvas files')).toBe(false);
  });

  await test('does not flag interrogative/analysis sentences that merely mention files+modify', () => {
    // 修:关键词共现误判 —— 讨论/询问文件修改,不是要求写文件。
    expect(isFileWriteRequest('我之前问的批量文件被修改的最可能原因是什么')).toBe(false);
    expect(isFileWriteRequest('为什么这些笔记文件会被修改？')).toBe(false);
    expect(isFileWriteRequest('文件被修改了吗')).toBe(false);
    expect(isFileWriteRequest('Why was this file modified?')).toBe(false);
    // 真·写请求仍应命中(无疑问信号)。
    expect(isFileWriteRequest('帮我修改这个笔记文件')).toBe(true);
    expect(isFileWriteRequest('更新当前笔记')).toBe(true);
  });

  await test('does not flag memory/rule statements that merely mention creating files', () => {
    // 修:记忆/规则陈述被误判为写请求 → 注入写契约 → 模型不写文件 → 误报「No file was created」。
    expect(isFileWriteRequest('记住：以后不要随便创建一级目录，创建文件时根据情况自动分类')).toBe(false);
    expect(isFileWriteRequest('以后新建笔记默认放到 study 目录')).toBe(false);
    expect(isFileWriteRequest('总是把收集的资料保存到 Assets 文件夹')).toBe(false);
    expect(isFileWriteRequest('Remember to always save notes into the work folder')).toBe(false);
    // 真·当次写请求仍应命中(无记忆语气)。
    expect(isFileWriteRequest('帮我创建一个笔记文件')).toBe(true);
  });

  await test('classifies write tools consistently', () => {
    expect(isFileWriteToolName('create_file')).toBe(true);
    expect(isFileWriteToolName('update_note')).toBe(true);
    expect(isFileWriteToolName('save_webpage')).toBe(true);
    expect(isFileWriteToolName('search_vault')).toBe(false);
  });

  await test('extracts a file path from write tool results and args', () => {
    expect(getFileWriteResultPath('create_file', { path: 'Assets/Canvas/x.canvas' }, {})).toBe('Assets/Canvas/x.canvas');
    expect(getFileWriteResultPath('create_note', { success: true }, { filename: 'Notes/test.md' })).toBe('Notes/test.md');
    expect(getFileWriteResultPath('rename_note', { success: true }, { newPath: 'Notes/renamed.md' })).toBe('Notes/renamed.md');
  });

  await test('recognizes successful tool results and exposes a stable contract message', () => {
    expect(isSuccessfulWriteToolResult({ success: true })).toBe(true);
    expect(isSuccessfulWriteToolResult({ status: 'success' })).toBe(true);
    expect(isSuccessfulWriteToolResult({ success: false })).toBe(false);
    expect(FILE_OPERATION_CONTRACT_TEXT.includes('must call an appropriate vault write tool')).toBe(true);
  });

  await test('builds stable failure messages for missing or failed file writes', () => {
    expect(buildFileWriteFailureMessage(false)).toBe(
      'No file was created or modified because no vault write tool ran. Please try again; file requests must be completed through workspace tools, not copy-paste output.'
    );
    expect(buildFileWriteFailureMessage(true, 'Unsafe vault path')).toBe(
      'No file was created or modified because no vault write tool completed successfully. Last tool error: Unsafe vault path. Please try again; file requests must be completed through workspace tools, not copy-paste output.'
    );
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
