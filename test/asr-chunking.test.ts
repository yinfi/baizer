/**
 * asr-chunking 的单测。
 *
 * 这些是纯函数，所以断言可以直接写在「切片窗口」和「WAV 字节」上，
 * 不需要起 Obsidian、不需要 Web Audio、不需要网络。
 */
import type { PcmSource } from '../src/services/asr-chunking';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: any, expected: any, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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

// 1 kHz 采样率：frameMs=20 时每帧正好 20 个样本，便于手算帧边界。
const RATE = 1000;

function constant(seconds: number, amplitude: number): number[] {
  return new Array(Math.round(seconds * RATE)).fill(amplitude);
}

function pcmSource(channels: number[][], sampleRate = RATE): PcmSource {
  const data = channels.map((channel) => Float32Array.from(channel));
  return {
    sampleRate,
    length: data[0]?.length ?? 0,
    channelCount: data.length,
    getChannelData: (channel: number) => data[channel],
  };
}

async function runTests() {
  console.log('=== asr-chunking Tests ===');
  const {
    detectSilences,
    encodeWav16,
    mixToMono,
    planChunkWindows,
    frameRmsDb,
  } = await import('../src/services/asr-chunking');

  await test('finds a silence range and reports its midpoint as the cut point', async () => {
    // 2 s 有声 (-6 dB) + 1 s 静音 (-inf) + 7 s 有声
    const source = pcmSource([[...constant(2, 0.5), ...constant(1, 0), ...constant(7, 0.5)]]);
    const ranges = detectSilences(source);
    assertEqual(ranges.length, 1, 'range count');
    assertEqual(ranges[0].startSec, 2, 'startSec');
    assertEqual(ranges[0].endSec, 3, 'endSec');
    assertEqual(ranges[0].midSec, 2.5, 'midSec');
  });

  await test('ignores a pause shorter than minSilenceSec', async () => {
    // 0.2 s 的停顿不该被当成切点，否则句内换气会把一句话切碎。
    const source = pcmSource([[...constant(2, 0.5), ...constant(0.2, 0), ...constant(2, 0.5)]]);
    assertEqual(detectSilences(source).length, 0, 'range count');
  });

  await test('retries with an estimated noise floor when nothing crosses -40 dBFS', async () => {
    // 整轨电平偏低：有声 -26 dB、静音 -34 dB，固定 -40 dBFS 一个静音段都找不到。
    const quiet = [...constant(2, 0.05), ...constant(1, 0.02), ...constant(7, 0.05)];
    // 关掉自适应才能观察「固定阈值下确实找不到静音」这个前提。
    assertEqual(
      detectSilences(pcmSource([quiet]), { adaptiveFallback: false }).length,
      0,
      'fixed threshold should find nothing',
    );
    const adaptive = detectSilences(pcmSource([quiet]));
    assertEqual(adaptive.length, 1, 'adaptive range count');
    assertEqual(adaptive[0].midSec, 2.5, 'adaptive midSec');
  });

  await test('treats digital silence as silence, not as a numeric accident', async () => {
    const source = pcmSource([[0, 0, 0, 0]]);
    const frames = frameRmsDb(source, 2);
    assertEqual(frames.length, 2, 'frame count');
    assert(frames[0] === -Infinity && frames[1] === -Infinity, 'all-zero frames must be -Infinity dB');
  });

  await test('keeps every window at or below maxChunkSec', async () => {
    const windows = planChunkWindows({ durationSec: 120 });
    assertEqual(windows.length, 3, 'window count');
    assertEqual(windows[0].startSec, 0, 'w0 start');
    assertEqual(windows[0].endSec, 45, 'w0 end');
    assertEqual(windows[1].endSec, 90, 'w1 end');
    assertEqual(windows[2].endSec, 120, 'w2 end');
    for (const window of windows) {
      assert(window.endSec - window.startSec <= 45 + 1e-9, 'window exceeds maxChunkSec');
    }
  });

  await test('snaps the cut to the latest silence inside the allowed band', async () => {
    const windows = planChunkWindows({
      durationSec: 120,
      silences: [
        { startSec: 29, endSec: 31, midSec: 30 },
        { startSec: 99, endSec: 101, midSec: 100 },
      ],
    });
    assertEqual(windows.length, 3, 'window count');
    assertEqual(windows[0].endSec, 30, 'cut on first silence');
    assertEqual(windows[1].startSec, 30, 'w1 starts at the cut');
    assertEqual(windows[1].endSec, 75, 'w1 has no silence in band, cuts at the bound');
    assertEqual(windows[2].endSec, 120, 'w2 covers the remainder');
  });

  await test('avoids leaving a degenerate tail behind', async () => {
    // 46 s 无静音：硬切在 45 s 会留下 1 s 的碎片。改切在 38 s，两片都正常。
    const windows = planChunkWindows({ durationSec: 46 });
    assertEqual(windows.length, 2, 'window count');
    assertEqual(windows[0].endSec, 38, 'first cut pulled back');
    assertEqual(windows[1].endSec, 46, 'tail covers the rest');
    assert(windows[1].endSec - windows[1].startSec >= 8, 'tail must not be a fragment');
  });

  await test('prefers a real silence over the tail-avoidance bound', async () => {
    const windows = planChunkWindows({ durationSec: 46, silences: [{ startSec: 19, endSec: 21, midSec: 20 }] });
    assertEqual(windows.length, 2, 'window count');
    assertEqual(windows[0].endSec, 20, 'cut on the silence');
  });

  await test('returns one window for audio that already fits, and none for empty audio', async () => {
    const single = planChunkWindows({ durationSec: 45 });
    assertEqual(single.length, 1, 'single window count');
    assertEqual(single[0].endSec, 45, 'single window end');
    assertEqual(planChunkWindows({ durationSec: 0 }).length, 0, 'empty audio');
    assertEqual(planChunkWindows({ durationSec: Number.NaN }).length, 0, 'NaN duration');
  });

  await test('produces a contiguous, bounded partition of a long clip', async () => {
    const silences = [];
    for (let second = 3; second < 600; second += 3) {
      silences.push({ startSec: second - 1, endSec: second + 1, midSec: second });
    }
    const windows = planChunkWindows({ durationSec: 600, silences });
    assert(windows.length > 1, 'long clip must be split');
    assertEqual(windows[0].startSec, 0, 'starts at zero');
    assertEqual(windows[windows.length - 1].endSec, 600, 'ends at duration');
    let covered = 0;
    for (let i = 0; i < windows.length; i += 1) {
      const length = windows[i].endSec - windows[i].startSec;
      assert(length > 0, 'empty window');
      assert(length <= 45 + 1e-9, `window ${i} is ${length}s, over the 45s bound`);
      if (i > 0) assertEqual(windows[i].startSec, windows[i - 1].endSec, `window ${i} is not contiguous`);
      covered += length;
    }
    assert(Math.abs(covered - 600) < 1e-6, `coverage ${covered} != 600`);
  });

  await test('encodes a canonical 16-bit mono WAV header', async () => {
    const wav = encodeWav16(Float32Array.from([0, 0.5, -0.5, 1, -1]), 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

    assertEqual(ascii(0, 4), 'RIFF', 'RIFF magic');
    assertEqual(ascii(8, 4), 'WAVE', 'WAVE magic');
    assertEqual(ascii(12, 4), 'fmt ', 'fmt chunk id');
    assertEqual(ascii(36, 4), 'data', 'data chunk id');
    assertEqual(view.getUint32(4, true), 36 + 10, 'RIFF size');
    assertEqual(view.getUint16(20, true), 1, 'PCM format tag');
    assertEqual(view.getUint16(22, true), 1, 'mono channel count');
    assertEqual(view.getUint32(24, true), 16000, 'sample rate');
    assertEqual(view.getUint32(28, true), 32000, 'byte rate');
    assertEqual(view.getUint16(32, true), 2, 'block align');
    assertEqual(view.getUint16(34, true), 16, 'bits per sample');
    assertEqual(view.getUint32(40, true), 10, 'data size');
    assertEqual(wav.byteLength, 54, 'total size');

    assertEqual(view.getInt16(44, true), 0, 'sample 0');
    assertEqual(view.getInt16(46, true), 16383, 'sample +0.5');
    assertEqual(view.getInt16(48, true), -16384, 'sample -0.5');
    assertEqual(view.getInt16(50, true), 32767, 'sample +1');
    assertEqual(view.getInt16(52, true), -32768, 'sample -1');
  });

  await test('clips out-of-range samples instead of wrapping them', async () => {
    const wav = encodeWav16(Float32Array.from([1.5, -1.5]), 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assertEqual(view.getInt16(44, true), 32767, 'clamped high');
    assertEqual(view.getInt16(46, true), -32768, 'clamped low');
  });

  await test('downmixes to mono and honours the requested sample range', async () => {
    const stereo = pcmSource([[1, 0, 0.5, 0.25], [0, 1, 0.5, 0.75]]);
    const mixed = mixToMono(stereo, 0, 4);
    assertEqual(mixed.length, 4, 'mixed length');
    assertEqual(mixed[0], 0.5, 'left only');
    assertEqual(mixed[1], 0.5, 'right only');
    assertEqual(mixed[2], 0.5, 'both equal');
    assertEqual(mixed[3], 0.5, 'averaged');

    const slice = mixToMono(stereo, 1, 3);
    assertEqual(slice.length, 2, 'slice length');
    assertEqual(slice[0], 0.5, 'slice first');
    assertEqual(mixToMono(stereo, 10, 20).length, 0, 'clamped out-of-range range');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});