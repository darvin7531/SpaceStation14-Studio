import assert from 'node:assert/strict';
import test from 'node:test';
import { readPngAsDataUrl } from '../src/lib/rsi-png-data-url';

test('PNG data URLs preserve bytes regardless of file MIME type', async () => {
  const original = globalThis.FileReader;
  class TestFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    error = null;
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then((bytes) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`;
        this.onload?.();
      });
    }
  }
  globalThis.FileReader = TestFileReader as unknown as typeof FileReader;
  try {
    for (const type of ['', 'application/octet-stream', 'image/png']) {
      const file = Object.assign(new Blob([new Uint8Array([137, 80, 78, 71])], { type }), { name: 'sprite.png' }) as File;
      assert.equal(await readPngAsDataUrl(file), 'data:image/png;base64,iVBORw==');
    }
  } finally {
    globalThis.FileReader = original;
  }
});
