const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export const OCR_RUNTIME_SOURCES = Object.freeze({
  tesseract: Object.freeze({
    url: 'https://github.com/tesseract-ocr/tesseract/archive/6e1d56a847e697de07b38619356550e5cf4e8633.tar.gz',
    revision: '6e1d56a847e697de07b38619356550e5cf4e8633',
    sha256: '51342815a262a5c1d000bab44503ddbf71ef210053375d504f619ca7a3b381bd',
    licenseSource:
      'https://github.com/tesseract-ocr/tesseract/blob/6e1d56a847e697de07b38619356550e5cf4e8633/LICENSE',
  }),
  models: Object.freeze({
    eng: Object.freeze({
      url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/27cfc71a8874cce2483679eea010e391bb38c2ae/eng.traineddata',
      revision: '27cfc71a8874cce2483679eea010e391bb38c2ae',
      sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
      licenseSource:
        'https://github.com/tesseract-ocr/tessdata_fast/blob/27cfc71a8874cce2483679eea010e391bb38c2ae/LICENSE',
      licenseSha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    }),
    por: Object.freeze({
      url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/27cfc71a8874cce2483679eea010e391bb38c2ae/por.traineddata',
      revision: '27cfc71a8874cce2483679eea010e391bb38c2ae',
      sha256: 'c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb',
      licenseSource:
        'https://github.com/tesseract-ocr/tessdata_fast/blob/27cfc71a8874cce2483679eea010e391bb38c2ae/LICENSE',
      licenseSha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    }),
  }),
});

export function assertPinnedOcrRuntimeSource(source) {
  if (!source || typeof source !== 'object') throw unpinnedSourceError();
  const { url, revision, sha256, licenseSource, licenseSha256 } = source;
  if (
    !isHttpsUrl(url) ||
    !isHttpsUrl(licenseSource) ||
    typeof revision !== 'string' ||
    !COMMIT.test(revision) ||
    !url.includes(revision) ||
    !licenseSource.includes(revision) ||
    !SHA256.test(sha256 ?? '') ||
    ('licenseSha256' in source && !SHA256.test(licenseSha256 ?? ''))
  ) {
    throw unpinnedSourceError();
  }
}

export function assertPinnedOcrRuntimeSources(sources = OCR_RUNTIME_SOURCES) {
  if (
    !sources ||
    typeof sources !== 'object' ||
    !sources.models ||
    typeof sources.models !== 'object'
  ) {
    throw unpinnedSourceError();
  }
  assertPinnedOcrRuntimeSource(sources.tesseract);
  assertPinnedOcrRuntimeSource(sources.models.eng);
  assertPinnedOcrRuntimeSource(sources.models.por);
  if (
    !SHA256.test(sources.models.eng.licenseSha256 ?? '') ||
    !SHA256.test(sources.models.por.licenseSha256 ?? '')
  ) {
    throw unpinnedSourceError();
  }
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
