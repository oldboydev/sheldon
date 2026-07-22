const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export const OCR_RUNTIME_SOURCES = Object.freeze({
  tesseract: Object.freeze({
    url: 'https://github.com/tesseract-ocr/tesseract/archive/6e1d56a847e697de07b38619356550e5cf4e8633.tar.gz',
    revision: '6e1d56a847e697de07b38619356550e5cf4e8633',
    sha256: '6235ea0dae45ea137f59c09320406f5888383741924d98855bd2ce0d16b54f21',
    licenseSource: 'https://github.com/tesseract-ocr/tesseract/blob/6e1d56a847e697de07b38619356550e5cf4e8633/LICENSE',
  }),
  models: Object.freeze({
    eng: Object.freeze({
      url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4f18b9c1cb7d0a4a2c9d9ccf21835a2f9997ad50/eng.traineddata',
      revision: '4f18b9c1cb7d0a4a2c9d9ccf21835a2f9997ad50',
      sha256: '7d432f94c52e4cf4bcba738dee407dc782b4e0a1e086d1d20b2aab6ef5ec0b6d',
      licenseSource: 'https://github.com/tesseract-ocr/tessdata_fast/blob/4f18b9c1cb7d0a4a2c9d9ccf21835a2f9997ad50/LICENSE',
    }),
    por: Object.freeze({
      url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4f18b9c1cb7d0a4a2c9d9ccf21835a2f9997ad50/por.traineddata',
      revision: '4f18b9c1cb7d0a4a2c9d9ccf21835a2f9997ad50',
      sha256: '2981d3251f184f9d86fa882be9f9c6aa47bdbf39e1e16b302ed9c4cfd43f4f49',
      licenseSource: 'https://github.com/tesseract-ocr/tessdata_fast/blob/4f18b9c1cb7d0a4a2c9d9ccf21835a2f9997ad50/LICENSE',
    }),
  }),
});

export function assertPinnedOcrRuntimeSource(source) {
  if (!source || typeof source !== 'object') throw unpinnedSourceError();
  const { url, revision, sha256, licenseSource } = source;
  if (
    !isHttpsUrl(url) ||
    !isHttpsUrl(licenseSource) ||
    typeof revision !== 'string' ||
    !COMMIT.test(revision) ||
    !url.includes(revision) ||
    !licenseSource.includes(revision) ||
    !SHA256.test(sha256 ?? '')
  ) {
    throw unpinnedSourceError();
  }
}

export function assertPinnedOcrRuntimeSources(sources = OCR_RUNTIME_SOURCES) {
  if (!sources || typeof sources !== 'object' || !sources.models || typeof sources.models !== 'object') {
    throw unpinnedSourceError();
  }
  assertPinnedOcrRuntimeSource(sources.tesseract);
  assertPinnedOcrRuntimeSource(sources.models.eng);
  assertPinnedOcrRuntimeSource(sources.models.por);
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function unpinnedSourceError() {
  const error = new Error(
    'OCR_RUNTIME_SOURCE_UNPINNED: OCR runtime downloads require an HTTPS URL, immutable revision, SHA-256, and license source.',
  );
  error.code = 'OCR_RUNTIME_SOURCE_UNPINNED';
  return error;
}
