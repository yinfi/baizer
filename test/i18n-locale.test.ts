import { t, setLocale, getLocale, setLocaleForTesting } from '../src/i18n/zh';

// 轻量断言器：与仓库其它测试保持同一风格（无第三方框架，失败即抛）。
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exit(1);
  }
}

(async () => {
  console.log('i18n locale');

  await test("setLocale('en') 时 t() 返回英文原文 key", () => {
    setLocale('en');
    assert(getLocale() === 'en', `getLocale 应为 en,实际 ${getLocale()}`);
    // 命中中文表的 key 在英文环境应原样返回（key 即英文原文）。
    assert(t('Overview') === 'Overview', `英文环境应返回原文,实际 ${t('Overview')}`);
    // 未收录的 key 同样回退原文。
    assert(t('__NOT_A_REAL_KEY__') === '__NOT_A_REAL_KEY__', '未知 key 应回退原文');
  });

  await test("setLocale('zh') 时 t() 命中中文表", () => {
    setLocale('zh');
    assert(getLocale() === 'zh', `getLocale 应为 zh,实际 ${getLocale()}`);
    assert(t('Overview') === '概览', `中文环境应返回译文,实际 ${t('Overview')}`);
    // 未收录的 key 仍回退英文原文（漏翻译不至于显示空白）。
    assert(t('__NOT_A_REAL_KEY__') === '__NOT_A_REAL_KEY__', '未知 key 应回退原文');
  });

  await test("本次新增的 UI key 已进中文表", () => {
    setLocale('zh');
    assert(t('Copy message') === '复制消息', '缺 Copy message 译文');
    assert(t('Regenerate') === '重新生成', '缺 Regenerate 译文');
    assert(t('Language') === '语言', '缺 Language 译文');
    assert(t('Rewrite failed') === '改写失败', '缺 Rewrite failed 译文');
    assert(t('Approval needed: confirm operation') === '需要审批:确认操作', '缺审批标题译文');
  });

  await test("setLocale('auto') 保留 auto 并按系统语言解析（不硬编码方向）", () => {
    setLocale('auto');
    assert(getLocale() === 'auto', `getLocale 应保留 auto,实际 ${getLocale()}`);
    // auto 解析结果取决于运行机器的 navigator.language：中文系统→中文译文,否则→英文原文。
    // 两种结果都合法,只要不是空/其它值即可。
    const out = t('Overview');
    assert(out === '概览' || out === 'Overview', `auto 解析应为中/英之一,实际 ${out}`);
  });

  await test('setLocaleForTesting 兼容旧签名', () => {
    setLocaleForTesting(true);
    assert(t('Overview') === '概览', 'setLocaleForTesting(true) 应等价 zh');
    setLocaleForTesting(false);
    assert(t('Overview') === 'Overview', 'setLocaleForTesting(false) 应等价 en');
  });

  console.log('i18n locale: all passed');
})();
