/** pdfjs-dist 6 evaluates `new DOMMatrix()` at load when @napi-rs/canvas is absent. */

type PdfJsGlobals = typeof globalThis & {
  DOMMatrix?: unknown;
  Path2D?: unknown;
};

const globals = globalThis as PdfJsGlobals;

if (typeof globals.DOMMatrix !== 'function') {
  globals.DOMMatrix = class DOMMatrix {};
}

if (typeof globals.Path2D !== 'function') {
  globals.Path2D = class Path2D {};
}
