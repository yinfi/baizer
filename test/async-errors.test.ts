/**
 * test/async-errors.test.ts
 *
 * issue #92（未处理/误用的 Promise）的核心回归：
 * 事件回调、`addEventListener`、`setInterval`、`Modal.onSubmit` 这类「期望 void 返回」的
 * 同步接口里启动异步工作后，失败必须被接住 —— 既不能变成未处理的 promise rejection，
 * 也不能用空 `.catch(() => {})` 静默吞掉。
 *
 * 这里直接验证 `voidAsync`（src/utils/async-errors.ts）的落点：
 *   1) rejection 进 logger（开发者控制台 / 日志导出可见），并按需回调用户提示；
 *   2) 同步抛错同样被接住（事件回调第一行就抛的情况）；
 *   3) 失败提示自身再抛错，也不能二次变成未处理 rejection；
 *   4) 非 Error 的 rejection reason 不会丢（原值传给提示方，logger 负责序列化）。
 *
 * 「未处理 rejection」用 process.on('unhandledRejection') 观察：Node 在该事件有监听时
 * 只派发不退出，因此这里能断言「一次都没发生」。
 */

import { logger } from '../src/utils/logger';
import { voidAsync } from '../src/utils/async-errors';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

/** 让 voidAsync 的 catch 与 Node 的 unhandledRejection 派发都落定。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function runTests() {
  console.log('=== async-errors (issue #92) ===');

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  logger.setConsoleOutput(false);

  await test('a rejected fire-and-forget promise reaches the logger and the caller reporter', async () => {
    logger.clearLogs();
    const reported: unknown[] = [];

    voidAsync('test: rejected task', () => Promise.reject(new Error('boom')), (error) => {
      reported.push(error);
    });
    await settle();

    expect(reported.length).toBe(1);
    expect(reported[0] instanceof Error).toBe(true);
    expect((reported[0] as Error).message).toBe('boom');

    const logs = logger.getRecentLogs('error', 10);
    expect(logs.length).toBe(1);
    expect(logs[0].message).toBe('test: rejected task');
    const serialized = logs[0].error as { message?: string };
    expect(serialized.message).toBe('boom');

    // 关键断言：不再有未处理的 promise rejection。
    expect(unhandled.length).toBe(0);
  });

  await test('a synchronous throw inside the task is caught the same way', async () => {
    logger.clearLogs();
    const reported: unknown[] = [];

    voidAsync('test: sync throw', () => {
      throw new Error('thrown before any await');
    }, (error) => {
      reported.push(error);
    });
    await settle();

    expect(reported.length).toBe(1);
    expect((reported[0] as Error).message).toBe('thrown before any await');
    expect(logger.getRecentLogs('error', 10).length).toBe(1);
    expect(unhandled.length).toBe(0);
  });

  await test('a resolved task reports nothing', async () => {
    logger.clearLogs();
    let reported = 0;

    voidAsync('test: resolved task', () => Promise.resolve('ok'), () => {
      reported += 1;
    });
    await settle();

    expect(reported).toBe(0);
    expect(logger.getRecentLogs('error', 10).length).toBe(0);
    expect(unhandled.length).toBe(0);
  });

  await test('a throwing failure reporter cannot leak a new unhandled rejection', async () => {
    logger.clearLogs();

    voidAsync('test: reporter throws', () => Promise.reject(new Error('inner failure')), () => {
      throw new Error('reporter failed');
    });
    await settle();

    const logs = logger.getRecentLogs('error', 10);
    // 第一次是业务失败，第二次是失败提示自身抛错；两次都必须被记录。
    expect(logs.length).toBe(2);
    expect(logs[0].message).toBe('test: reporter throws');
    expect(logs[1].message).toBe('Async failure reporter failed');
    expect(unhandled.length).toBe(0);
  });

  await test('non-Error rejection reasons are still reported and serialized', async () => {
    logger.clearLogs();
    const reported: unknown[] = [];

    voidAsync('test: string rejection', () => Promise.reject('plain string failure'), (error) => {
      reported.push(error);
    });
    await settle();

    expect(reported.length).toBe(1);
    expect(reported[0]).toBe('plain string failure');
    const logs = logger.getRecentLogs('error', 10);
    expect(logs.length).toBe(1);
    const serialized = logs[0].error as { message?: string; data?: unknown };
    expect(serialized.message).toBe('plain string failure');
    expect(serialized.data).toBe('plain string failure');
    expect(unhandled.length).toBe(0);
  });

  process.off('unhandledRejection', onUnhandled);
  logger.setConsoleOutput(true);
  console.log('async-errors: all passed');
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
