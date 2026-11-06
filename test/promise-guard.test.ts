import { detach, toError, voidHandler } from '../src/utils/promise-guard';
import { logger } from '../src/utils/logger';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
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

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

/** 收集测试期间的 unhandled rejection；detach/voidHandler 的目标就是让它为空。 */
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

async function runTests() {
  console.log('=== promise-guard Tests ===');
  const errorLogs: Array<{ message: string; error: unknown; context?: string }> = [];
  const origError = logger.error.bind(logger);
  logger.error = ((message: string, error?: unknown, context?: string) => {
    errorLogs.push({ message, error, context });
  }) as typeof logger.error;

  try {
    await test('toError keeps Error instances (and their fields) untouched', () => {
      const original = Object.assign(new Error('x'), { status: 404 });
      assert(toError(original) === original, 'Error instance must be returned as-is');
    });

    await test('toError wraps non-Error values and keeps the original as cause', () => {
      const fromString = toError('boom');
      assert(fromString instanceof Error && fromString.message === 'boom', 'string -> Error(message)');
      assert(fromString.cause === 'boom', 'cause should be the original value');
      const fromObject = toError({ message: 'denied' });
      assert(fromObject.message === 'denied', 'object with message -> that message');
      assert(toError(undefined).message === 'Unknown error', 'undefined -> Unknown error');
    });

    await test('detach: a rejected task is logged and reported, not left unhandled', async () => {
      errorLogs.length = 0;
      const seen: unknown[] = [];
      const failure = new Error('write failed');
      detach(Promise.reject(failure), 'Ctx', (e) => seen.push(e));
      await tick();
      assert(errorLogs.length === 1 && errorLogs[0].error === failure, 'failure should be logged once');
      assert(errorLogs[0].context === 'Ctx', 'log should carry the context');
      assert(seen[0] === failure, 'onError should receive the failure');
      assert(unhandled.length === 0, 'no unhandled rejection expected');
    });

    await test('detach: accepts undefined / resolved tasks without logging', async () => {
      errorLogs.length = 0;
      detach(undefined, 'Ctx');
      detach(Promise.resolve(1), 'Ctx');
      await tick();
      assert(errorLogs.length === 0, 'nothing should be logged');
    });

    await test('detach: a throwing onError is contained and logged', async () => {
      errorLogs.length = 0;
      detach(Promise.reject(new Error('a')), 'Ctx', () => { throw new Error('handler broke'); });
      await tick();
      assert(errorLogs.length === 2, 'original failure and handler failure should both be logged');
      assert(unhandled.length === 0, 'no unhandled rejection expected');
    });

    await test('voidHandler: runs the synchronous part immediately and returns void', () => {
      let ranSync = false;
      const handler = voidHandler(async (flag: boolean) => {
        ranSync = flag; // 第一个 await 之前，例如 preventDefault
        await Promise.resolve();
      }, 'Ctx');
      const returned: unknown = handler(true);
      assert(returned === undefined, 'handler must return void');
      assert(ranSync, 'sync part must run before the call returns');
    });

    await test('voidHandler: async rejection is logged and reported to onError', async () => {
      errorLogs.length = 0;
      const seen: unknown[] = [];
      const handler = voidHandler(async () => {
        await Promise.resolve();
        throw new Error('persist failed');
      }, 'Ctx', (e) => seen.push(e));
      handler();
      await tick();
      assert(errorLogs.length === 1, 'failure should be logged');
      assert((seen[0] as Error).message === 'persist failed', 'onError should get the failure');
      assert(unhandled.length === 0, 'no unhandled rejection expected');
    });

    await test('voidHandler: a synchronous throw does not escape to the event dispatcher', async () => {
      errorLogs.length = 0;
      const handler = voidHandler((): void => { throw 'string failure'; }, 'Ctx');
      handler();
      await tick();
      assert(errorLogs.length === 1, 'sync throw should be logged');
      assert(errorLogs[0].error instanceof Error, 'non-Error throw should be normalised to Error');
    });

    await test('model catalog: a non-Error request rejection surfaces as an Error', async () => {
      // 非浏览器测试环境里 catalog 用到的 window.setTimeout 不存在：最小垫片。
      if (typeof (globalThis as any).window === 'undefined') (globalThis as any).window = globalThis;
      const catalog = await import('../src/services/model-catalog-service');
      const config: any = {
        type: 'openai-compatible', label: 'OpenAI', apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o',
      };
      let caught: unknown;
      try {
        await catalog.listModels(config, {
          requestUrl: () => Promise.reject('network down'),
        } as any);
      } catch (e) {
        caught = e;
      }
      assert(caught instanceof Error, 'rejection reason must be an Error');
      assert((caught as Error).message === 'network down', 'message should keep the original text, got: ' + (caught as Error).message);
    });
  } finally {
    logger.error = origError;
  }

  console.log('promise-guard tests passed');
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

