/** pdfjs-dist 6 evaluates `new DOMMatrix()` at load when @napi-rs/canvas is absent. */

const globals = globalThis as typeof globalThis & Record<string, unknown>;

if (typeof globals.DOMMatrix !== 'function') {
  Object.assign(globalThis, { DOMMatrix: class DOMMatrix {} });
}

if (typeof globals.Path2D !== 'function') {
  Object.assign(globalThis, { Path2D: class Path2D {} });
}
