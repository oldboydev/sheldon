const SHA256 = /^[a-f0-9]{64}$/u;
const PROVIDERS = new Set(['homebrew', 'msys2']);

const inventory = [];

assertPinnedOcrRuntimeDependencyInventory(inventory);

export const OCR_RUNTIME_DEPENDENCY_INVENTORY = Object.freeze(
  inventory.map((entry) => Object.freeze({ ...entry })),
);

export function assertPinnedOcrRuntimeDependencyInventory(
  inventory = OCR_RUNTIME_DEPENDENCY_INVENTORY,
) {
  if (!Array.isArray(inventory)) throw noticesError();

  const identities = new Set();
  for (const entry of inventory) {
    if (!isPinnedDependency(entry)) throw noticesError();

    const identity = `${entry.provider}\u0000${entry.name}\u0000${entry.version}`;
    if (identities.has(identity)) throw noticesError();
    identities.add(identity);
  }
}

export function findOcrRuntimeDependency(
  provider,
  name,
  version,
  inventory = OCR_RUNTIME_DEPENDENCY_INVENTORY,
) {
  assertPinnedOcrRuntimeDependencyInventory(inventory);
  const entry = inventory.find(
    (candidate) =>
      candidate.provider === provider && candidate.name === name && candidate.version === version,
  );
  if (!entry) throw noticesError();
  return entry;
}

function isPinnedDependency(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    PROVIDERS.has(entry.provider) &&
    isNonEmptyString(entry.name) &&
    isNonEmptyString(entry.version) &&
    isHttpsUrl(entry.sourceUrl) &&
    SHA256.test(entry.sourceSha256 ?? '') &&
    isNonEmptyString(entry.licensePath) &&
    SHA256.test(entry.licenseSha256 ?? '') &&
    isNonEmptyString(entry.spdx)
  );
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function noticesError() {
  const error = new Error(
    'OCR_RUNTIME_NOTICES_INVALID: OCR runtime dependencies require complete immutable source and license records.',
  );
  error.code = 'OCR_RUNTIME_NOTICES_INVALID';
  return error;
}
