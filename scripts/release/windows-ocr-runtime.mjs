import { createHash, randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const MSYS2_GRAPH_SCHEMA_VERSION = 1;

const MSYS2_SETUP_ACTION = 'msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884';
const MSYS2_SETUP_MSYSTEM = 'MINGW64';
const MSYS2_SETUP_INSTALL = Object.freeze([
  'mingw-w64-x86_64-cmake',
  'mingw-w64-x86_64-gcc',
  'mingw-w64-x86_64-leptonica',
  'mingw-w64-x86_64-ninja',
  'mingw-w64-x86_64-pkgconf',
]);
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9@._+:-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const MAX_DOWNLOAD_REDIRECTS = 5;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [250, 500];

class RetryableDownloadError extends Error {
  constructor(reason, finalError) {
    super(reason);
    this.reason = reason;
    this.finalError = finalError;
  }
}

function comparePackageNames(left, right) {
  return left.name.localeCompare(right.name, 'en');
}

function hasExactKeys(value, expectedKeys) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isPackageName(value) {
  return typeof value === 'string' && PACKAGE_NAME_PATTERN.test(value);
}

function isPackageVersion(value) {
  return typeof value === 'string' && value.length > 0 && !/\s/u.test(value);
}

function graphError(message) {
  return new Error(`OCR_RUNTIME_MSYS2_GRAPH_INVALID: ${message}`);
}

function graphLockError(message) {
  return new Error(`OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID: ${message}`);
}

function freezePackageGraph(packages) {
  return Object.freeze(packages.map(({ name, version }) => Object.freeze({ name, version })));
}

export function parseMsys2PackageGraph(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) {
    throw graphError('pacman output must be a nonempty string');
  }

  const normalized = stdout.replaceAll('\r\n', '\n');
  if (normalized.includes('\r')) {
    throw graphError('pacman output contains an unsupported carriage return');
  }

  const records = normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n');
  if (records.length === 0 || records.some((record) => record.length === 0)) {
    throw graphError('pacman output contains a blank package record');
  }

  const names = new Set();
  const packages = records.map((record) => {
    const fields = record.split(' ');
    if (fields.length !== 2 || !isPackageName(fields[0]) || !isPackageVersion(fields[1])) {
      throw graphError(`malformed pacman package record: ${record}`);
    }

    const [name, version] = fields;
    if (names.has(name)) {
      throw graphError(`duplicate pacman package name: ${name}`);
    }
    names.add(name);
    return { name, version };
  });

  packages.sort(comparePackageNames);
  return freezePackageGraph(packages);
}

export function validateMsys2GraphLock(lock) {
  if (!hasExactKeys(lock, ['schemaVersion', 'setup', 'packages'])) {
    throw graphLockError('lock must contain only schemaVersion, setup, and packages');
  }
  if (lock.schemaVersion !== MSYS2_GRAPH_SCHEMA_VERSION) {
    throw graphLockError(`schemaVersion must be ${MSYS2_GRAPH_SCHEMA_VERSION}`);
  }
  if (!hasExactKeys(lock.setup, ['action', 'msystem', 'release', 'update', 'cache', 'install'])) {
    throw graphLockError('setup has an invalid shape');
  }

  const setup = lock.setup;
  if (
    setup.action !== MSYS2_SETUP_ACTION ||
    setup.msystem !== MSYS2_SETUP_MSYSTEM ||
    setup.release !== true ||
    setup.update !== false ||
    setup.cache !== false
  ) {
    throw graphLockError('setup does not match the pinned MSYS2 configuration');
  }
  if (
    !Array.isArray(setup.install) ||
    setup.install.length !== MSYS2_SETUP_INSTALL.length ||
    setup.install.some((name, index) => !isPackageName(name) || name !== MSYS2_SETUP_INSTALL[index])
  ) {
    throw graphLockError('setup.install does not match the requested root packages');
  }
  if (!Array.isArray(lock.packages) || lock.packages.length === 0) {
    throw graphLockError('packages must be a nonempty array');
  }

  const seenNames = new Set();
  let previousName;
  const packages = lock.packages.map((entry) => {
    if (!hasExactKeys(entry, ['name', 'version'])) {
      throw graphLockError('each package must contain only name and version');
    }
    if (!isPackageName(entry.name) || !isPackageVersion(entry.version)) {
      throw graphLockError('package names and versions must be nonempty and valid');
    }
    if (seenNames.has(entry.name)) {
      throw graphLockError(`duplicate package name: ${entry.name}`);
    }
    if (previousName !== undefined && previousName.localeCompare(entry.name, 'en') >= 0) {
      throw graphLockError('packages must be in lexical name order');
    }

    seenNames.add(entry.name);
    previousName = entry.name;
    return { name: entry.name, version: entry.version };
  });

  const missingRoots = setup.install.filter((name) => !seenNames.has(name));
  if (missingRoots.length > 0) {
    throw graphLockError(`packages are missing requested roots: ${missingRoots.join(', ')}`);
  }

  return Object.freeze({
    schemaVersion: MSYS2_GRAPH_SCHEMA_VERSION,
    setup: Object.freeze({
      action: MSYS2_SETUP_ACTION,
      msystem: MSYS2_SETUP_MSYSTEM,
      release: true,
      update: false,
      cache: false,
      install: Object.freeze([...MSYS2_SETUP_INSTALL]),
    }),
    packages: freezePackageGraph(packages),
  });
}

function normalizeInstalledPackageGraph(installed) {
  if (!Array.isArray(installed) || installed.length === 0) {
    throw graphError('installed packages must be a nonempty array');
  }

  const seenNames = new Set();
  const packages = installed.map((entry) => {
    if (
      !hasExactKeys(entry, ['name', 'version']) ||
      !isPackageName(entry.name) ||
      !isPackageVersion(entry.version)
    ) {
      throw graphError('installed packages must contain valid name and version values');
    }
    if (seenNames.has(entry.name)) {
      throw graphError(`duplicate installed package name: ${entry.name}`);
    }
    seenNames.add(entry.name);
    return { name: entry.name, version: entry.version };
  });

  packages.sort(comparePackageNames);
  return freezePackageGraph(packages);
}

export function assertPinnedMsys2PackageGraph(installed, lock) {
  const installedPackages = normalizeInstalledPackageGraph(installed);
  const normalizedLock = validateMsys2GraphLock(lock);
  const installedByName = new Map(installedPackages.map((entry) => [entry.name, entry]));
  const expectedByName = new Map(normalizedLock.packages.map((entry) => [entry.name, entry]));

  const missing = normalizedLock.packages.filter((entry) => !installedByName.has(entry.name));
  const unexpected = installedPackages.filter((entry) => !expectedByName.has(entry.name));
  const changed = normalizedLock.packages.filter((expected) => {
    const actual = installedByName.get(expected.name);
    return actual !== undefined && actual.version !== expected.version;
  });

  if (missing.length === 0 && unexpected.length === 0 && changed.length === 0) {
    return;
  }

  const lines = [
    'OCR_RUNTIME_MSYS2_GRAPH_INVALID:',
    'installed:',
    ...installedPackages.map(({ name, version }) => `- ${name}@${version}`),
  ];
  if (missing.length > 0) {
    lines.push('missing:', ...missing.map(({ name, version }) => `- ${name}@${version}`));
  }
  if (unexpected.length > 0) {
    lines.push('unexpected:', ...unexpected.map(({ name, version }) => `- ${name}@${version}`));
  }
  if (changed.length > 0) {
    lines.push(
      'changed:',
      ...changed.map(({ name, version }) => {
        const actual = installedByName.get(name);
        return `- ${name} expected=${version} installed=${actual.version}`;
      }),
    );
  }

  throw new Error(lines.join('\n'));
}

export async function downloadPinnedFile({
  url,
  destination,
  expectedSha256,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  onDiagnostic = () => {},
  maxAttempts = MAX_DOWNLOAD_ATTEMPTS,
  maxRedirects = MAX_DOWNLOAD_REDIRECTS,
  requestTimeoutMs = MAX_REQUEST_TIMEOUT_MS,
}) {
  const originalUrl = validateDownloadOptions({
    url,
    destination,
    expectedSha256,
    fetchImpl,
    sleep,
    onDiagnostic,
    maxAttempts,
    maxRedirects,
    requestTimeoutMs,
  });
  const normalizedExpectedSha256 = expectedSha256.toLowerCase();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(RETRY_DELAYS_MS[attempt - 2]);
    }

    try {
      return await downloadPinnedFileAttempt({
        originalUrl,
        destination,
        expectedSha256: normalizedExpectedSha256,
        fetchImpl,
        onDiagnostic,
        attempt,
        maxRedirects,
        requestTimeoutMs,
      });
    } catch (error) {
      if (!(error instanceof RetryableDownloadError)) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw error.finalError;
      }

      onDiagnostic(
        `OCR_RUNTIME_DOWNLOAD_RETRY: attempt=${attempt}/${maxAttempts} reason=${error.reason} url=${sanitizeUrl(originalUrl)}`,
      );
    }
  }

  throw downloadError('OCR_RUNTIME_DOWNLOAD_INVALID', 'Download attempts were exhausted.');
}

async function downloadPinnedFileAttempt({
  originalUrl,
  destination,
  expectedSha256,
  fetchImpl,
  onDiagnostic,
  attempt,
  maxRedirects,
  requestTimeoutMs,
}) {
  let currentUrl = originalUrl;
  let redirectCount = 0;

  while (true) {
    let response;
    try {
      response = await fetchImpl(currentUrl.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw retryableDownloadError(
        'transport-error',
        'OCR_RUNTIME_DOWNLOAD_INVALID',
        `Transport failed for ${sanitizeUrl(originalUrl)}.`,
      );
    }

    if (!isFetchResponse(response)) {
      throw downloadError(
        'OCR_RUNTIME_DOWNLOAD_INVALID',
        `Transport returned an invalid response for ${sanitizeUrl(originalUrl)}.`,
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      redirectCount += 1;
      if (redirectCount > maxRedirects) {
        throw downloadError(
          'OCR_RUNTIME_DOWNLOAD_REDIRECT_INVALID',
          `Redirect limit exceeded for ${sanitizeUrl(originalUrl)}.`,
        );
      }

      const targetUrl = resolveHttpsRedirect(response.headers.get('location'), currentUrl);
      onDiagnostic(
        `OCR_RUNTIME_DOWNLOAD_REDIRECT: attempt=${attempt} hop=${redirectCount}/${maxRedirects} status=${response.status} from=${sanitizeUrl(currentUrl)} to=${sanitizeUrl(targetUrl)}`,
      );
      currentUrl = targetUrl;
      continue;
    }

    if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
      throw retryableDownloadError(
        `http-${response.status}`,
        'OCR_RUNTIME_DOWNLOAD_INVALID',
        `HTTP ${response.status} for ${sanitizeUrl(originalUrl)}.`,
      );
    }
    if (!response.ok) {
      throw downloadError(
        'OCR_RUNTIME_DOWNLOAD_INVALID',
        `HTTP ${response.status} for ${sanitizeUrl(originalUrl)}.`,
      );
    }

    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      throw retryableDownloadError(
        'transport-error',
        'OCR_RUNTIME_DOWNLOAD_INVALID',
        `Transport failed for ${sanitizeUrl(originalUrl)}.`,
      );
    }

    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    const partialPath = join(
      dirname(destination),
      `${basename(destination)}.${randomUUID()}.partial`,
    );
    try {
      await writeFile(partialPath, bytes);
      if (actualSha256 !== expectedSha256) {
        throw retryableDownloadError(
          'checksum-mismatch',
          'OCR_RUNTIME_CHECKSUM_INVALID',
          `SHA-256 mismatch for ${sanitizeUrl(originalUrl)}.`,
        );
      }
      await rename(partialPath, destination);
    } finally {
      await rm(partialPath, { force: true });
    }

    return {
      finalUrl: currentUrl.href,
      sha256: actualSha256,
      attempts: attempt,
    };
  }
}

function validateDownloadOptions({
  url,
  destination,
  expectedSha256,
  fetchImpl,
  sleep,
  onDiagnostic,
  maxAttempts,
  maxRedirects,
  requestTimeoutMs,
}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw downloadError('OCR_RUNTIME_DOWNLOAD_INVALID', 'Source URL must be a valid HTTPS URL.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw downloadError('OCR_RUNTIME_DOWNLOAD_INVALID', 'Source URL must use HTTPS.');
  }
  if (typeof destination !== 'string' || destination.length === 0) {
    throw downloadError('OCR_RUNTIME_DOWNLOAD_INVALID', 'Destination must be a nonempty path.');
  }
  if (typeof expectedSha256 !== 'string' || !SHA256_PATTERN.test(expectedSha256)) {
    throw downloadError(
      'OCR_RUNTIME_DOWNLOAD_INVALID',
      'Expected SHA-256 must be exactly 64 hexadecimal characters.',
    );
  }
  if (
    typeof fetchImpl !== 'function' ||
    typeof sleep !== 'function' ||
    typeof onDiagnostic !== 'function'
  ) {
    throw downloadError('OCR_RUNTIME_DOWNLOAD_INVALID', 'Download callbacks must be functions.');
  }
  if (!isBoundedInteger(maxAttempts, 1, MAX_DOWNLOAD_ATTEMPTS)) {
    throw downloadError(
      'OCR_RUNTIME_DOWNLOAD_INVALID',
      `maxAttempts must be between 1 and ${MAX_DOWNLOAD_ATTEMPTS}.`,
    );
  }
  if (!isBoundedInteger(maxRedirects, 0, MAX_DOWNLOAD_REDIRECTS)) {
    throw downloadError(
      'OCR_RUNTIME_DOWNLOAD_INVALID',
      `maxRedirects must be between 0 and ${MAX_DOWNLOAD_REDIRECTS}.`,
    );
  }
  if (!isBoundedInteger(requestTimeoutMs, 1, MAX_REQUEST_TIMEOUT_MS)) {
    throw downloadError(
      'OCR_RUNTIME_DOWNLOAD_INVALID',
      `requestTimeoutMs must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}.`,
    );
  }

  return parsedUrl;
}

function resolveHttpsRedirect(location, currentUrl) {
  let targetUrl;
  try {
    if (location === null || location.length === 0) {
      throw new Error('missing redirect');
    }
    targetUrl = new URL(location, currentUrl);
  } catch {
    throw downloadError(
      'OCR_RUNTIME_DOWNLOAD_REDIRECT_INVALID',
      `Redirect target is invalid for ${sanitizeUrl(currentUrl)}.`,
    );
  }
  if (targetUrl.protocol !== 'https:') {
    throw downloadError(
      'OCR_RUNTIME_DOWNLOAD_REDIRECT_INVALID',
      `Redirect target must use HTTPS for ${sanitizeUrl(currentUrl)}.`,
    );
  }
  return targetUrl;
}

function sanitizeUrl(url) {
  const sanitized = new URL(url);
  sanitized.username = '';
  sanitized.password = '';
  sanitized.search = '';
  sanitized.hash = '';
  return sanitized.href;
}

function retryableDownloadError(reason, code, message) {
  return new RetryableDownloadError(reason, downloadError(code, message));
}

function downloadError(code, message) {
  return new Error(`${code}: ${message}`);
}

function isBoundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isFetchResponse(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isInteger(value.status) &&
    typeof value.ok === 'boolean' &&
    typeof value.arrayBuffer === 'function' &&
    typeof value.headers?.get === 'function'
  );
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
