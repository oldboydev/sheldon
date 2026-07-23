import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import {
  assertPinnedOcrRuntimeDependencyInventory,
  findPinnedOcrRuntimeDependency,
  formatMissingOcrRuntimeDependencies,
  OCR_RUNTIME_DEPENDENCY_INVENTORY,
} from './ocr-runtime-dependency-inventory.mjs';

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
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
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

export function preflightMsys2RuntimeDependencies(
  identities,
  inventory = OCR_RUNTIME_DEPENDENCY_INVENTORY,
) {
  if (!Array.isArray(identities) || identities.length === 0) {
    throw noticesError('MSYS2 dependency identities must be a non-empty array.');
  }

  for (const identity of identities) {
    if (
      !hasExactKeys(identity, ['provider', 'name', 'version']) ||
      identity.provider !== 'msys2' ||
      !isPackageName(identity.name) ||
      !isPackageVersion(identity.version)
    ) {
      throw noticesError('MSYS2 dependency identities must be complete records.');
    }
  }

  const uniqueIdentities = [
    ...new Map(
      identities.map((identity) => [
        `${identity.provider}\u0000${identity.name}\u0000${identity.version}`,
        identity,
      ]),
    ).values(),
  ].sort(compareDependencyIdentities);

  const missing = [];
  const dependencies = [];
  const diagnostics = [];
  for (const identity of uniqueIdentities) {
    const dependency = findPinnedOcrRuntimeDependency(
      identity.provider,
      identity.name,
      identity.version,
      inventory,
    );
    if (dependency === undefined) {
      missing.push(identity);
      continue;
    }

    dependencies.push(dependency);
    diagnostics.push(
      `OCR_RUNTIME_DEPENDENCY: provider=${identity.provider} name=${identity.name} version=${identity.version}`,
    );
  }

  if (missing.length > 0) {
    throw new Error(formatMissingOcrRuntimeDependencies(missing));
  }

  return Object.freeze({
    dependencies: Object.freeze(dependencies),
    diagnostics: Object.freeze(diagnostics),
  });
}

export async function renderVerifiedMsys2DependencyNotice(options) {
  if (
    !hasExactKeys(options, ['dependency', 'privateDlls', 'extractedRoot']) ||
    typeof options.extractedRoot !== 'string' ||
    options.extractedRoot.length === 0 ||
    !Array.isArray(options.privateDlls) ||
    options.privateDlls.length === 0
  ) {
    throw noticesError('MSYS2 dependency notice options are invalid.');
  }

  const { dependency, extractedRoot } = options;
  assertPinnedOcrRuntimeDependencyInventory([dependency]);
  if (dependency.provider !== 'msys2') {
    throw noticesError('MSYS2 dependency notices require an MSYS2 dependency.');
  }

  const privateDlls = normalizePrivateDlls(options.privateDlls);
  const regularFiles = await collectRegularFiles(extractedRoot);
  const licenseSections = [];
  for (const license of dependency.licenses) {
    const licensePath = normalizeLicensePath(license.path);
    const matches = regularFiles.filter(
      ({ relativePath }) =>
        relativePath === licensePath || relativePath.endsWith(`/${licensePath}`),
    );
    if (matches.length !== 1) {
      throw noticesError(
        `Pinned license path ${licensePath} did not resolve uniquely for ${dependency.provider}/${dependency.name}@${dependency.version}.`,
      );
    }

    let licenseBytes;
    try {
      licenseBytes = await readFile(matches[0].absolutePath);
    } catch {
      throw noticesError(
        `Pinned license path ${licensePath} could not be read for ${dependency.provider}/${dependency.name}@${dependency.version}.`,
      );
    }
    const actualSha256 = createHash('sha256').update(licenseBytes).digest('hex');
    if (actualSha256 !== license.sha256.toLowerCase()) {
      throw noticesError(
        `License SHA-256 mismatch for ${dependency.provider}/${dependency.name}@${dependency.version}.`,
      );
    }

    const licenseText = licenseBytes.toString('utf8');
    if (licenseText.trim().length === 0) {
      throw noticesError(
        `Verified license text is empty for ${dependency.provider}/${dependency.name}@${dependency.version}.`,
      );
    }

    licenseSections.push(
      [
        `License SPDX: ${license.spdx}`,
        `License path: ${licensePath}`,
        `License SHA-256: ${license.sha256}`,
        '',
        licenseText,
      ].join('\n'),
    );
  }

  return [
    `== ${dependency.provider} package: ${dependency.name}@${dependency.version} ==`,
    `Provider: ${dependency.provider}`,
    `Package: ${dependency.name}`,
    `Version: ${dependency.version}`,
    `SPDX: ${dependency.spdx}`,
    `Source: ${dependency.sourceUrl}`,
    `Source SHA-256: ${dependency.sourceSha256}`,
    `Private DLLs: ${privateDlls.join(', ')}`,
    '',
    licenseSections.join('\n\n'),
  ].join('\n');
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
    const requestSignal = AbortSignal.timeout(requestTimeoutMs);
    try {
      response = await awaitRequestTimeout(
        fetchImpl(currentUrl.href, {
          redirect: 'manual',
          signal: requestSignal,
        }),
        requestSignal,
      );
    } catch (error) {
      if (!isRetryableTransportError(error)) {
        throw error;
      }
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
      bytes = Buffer.from(await awaitRequestTimeout(response.arrayBuffer(), requestSignal));
    } catch (error) {
      if (!isRetryableTransportError(error)) {
        throw error;
      }
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

function awaitRequestTimeout(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason);

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function isRetryableTransportError(error) {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }

  return error instanceof TypeError && RETRYABLE_NETWORK_ERROR_CODES.has(error.cause?.code);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function compareDependencyIdentities(left, right) {
  return (
    left.name.localeCompare(right.name, 'en') ||
    left.version.localeCompare(right.version, 'en') ||
    left.provider.localeCompare(right.provider, 'en')
  );
}

function normalizePrivateDlls(privateDlls) {
  const normalized = [];
  const seenNames = new Set();
  for (const name of privateDlls) {
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.trim() !== name ||
      /[,\r\n/\\]/u.test(name)
    ) {
      throw noticesError('Private DLL names must be non-empty file names.');
    }

    const identity = name.toLowerCase();
    if (seenNames.has(identity)) {
      throw noticesError(`Duplicate private DLL name: ${name}.`);
    }
    seenNames.add(identity);
    normalized.push(name);
  }
  return normalized.sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeLicensePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw noticesError('Pinned license paths must be non-empty relative paths.');
  }

  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw noticesError(`Pinned license path is not a normalized relative path: ${normalized}.`);
  }
  return normalized;
}

async function collectRegularFiles(extractedRoot) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw noticesError('Extracted dependency root could not be read.');
    }

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: relative(extractedRoot, absolutePath).replaceAll('\\', '/'),
        });
      }
    }
  }

  await visit(extractedRoot);
  return files;
}

function noticesError(message) {
  const error = new Error(`OCR_RUNTIME_NOTICES_INVALID: ${message}`);
  error.code = 'OCR_RUNTIME_NOTICES_INVALID';
  return error;
}
