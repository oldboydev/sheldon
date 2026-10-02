import { describe, expect, it } from 'vitest';

describe('pdfjs DOM polyfill', () => {
  it('defines DOMMatrix and Path2D so pdfjs-dist can load without canvas', async () => {
    await import('../src/pdfjs-dom-polyfill.js');
    expect(typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix).toBe('function');
    expect(typeof (globalThis as { Path2D?: unknown }).Path2D).toBe('function');
    await expect(import('pdfjs-dist/legacy/build/pdf.mjs')).resolves.toBeDefined();
  });
});
