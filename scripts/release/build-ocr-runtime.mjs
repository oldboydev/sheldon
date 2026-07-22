import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseError } from './build-official-artifacts.mjs';
import { OCR_RUNTIME_SOURCES, assertPinnedOcrRuntimeSources } from './ocr-runtime-sources.mjs';
import { prepareOcrRuntime } from './prepare-ocr-runtime.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = join(SCRIPT_DIRECTORY, 'Dockerfile.ocr-linux');

export async function buildOcrRuntime({
  platform,
  output,
  runCommand = defaultRunCommand,
  sources = OCR_RUNTIME_SOURCES,
}) {
  if (platform !== 'linux-x64') {
    throw releaseError(
      'OCR_RUNTIME_PLATFORM_INVALID',
      `The local Docker OCR runtime builder supports only linux-x64, not ${platform}.`,
    );
  }
  if (typeof output !== 'string' || output.trim() === '') {
    throw argumentsError();
  }
  assertPinnedOcrRuntimeSources(sources);

  const destination = resolve(output);
  await runCommand(
    'docker',
    [
      'build',
      '--platform',
      'linux/amd64',
      '--file',
      DOCKERFILE,
      '--output',
      `type=local,dest=${destination}`,
      ...sourceBuildArguments(sources),
      SCRIPT_DIRECTORY,
    ],
    { shell: false },
  );

  const validationRoot = await mkdtemp(join(tmpdir(), 'sheldon-ocr-runtime-validation-'));
  try {
    await prepareOcrRuntime({
      platform,
      input: destination,
      output: validationRoot,
      download: noDownload,
      sources,
    });
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

export function parseBuildOcrRuntimeArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) throw argumentsError();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      (flag !== '--platform' && flag !== '--output') ||
      values.has(flag) ||
      typeof value !== 'string' ||
      value.trim() === ''
    ) {
      throw argumentsError();
    }
    values.set(flag, value);
  }
  const platform = values.get('--platform');
  const output = values.get('--output');
  if (!platform || !output) throw argumentsError();
  return { platform, output };
}

function sourceBuildArguments(sources) {
  const values = {
    TESSERACT_URL: sources.tesseract.url,
    TESSERACT_REVISION: sources.tesseract.revision,
    TESSERACT_SHA256: sources.tesseract.sha256,
    TESSERACT_LICENSE_SOURCE: sources.tesseract.licenseSource,
    ENG_MODEL_URL: sources.models.eng.url,
    ENG_MODEL_REVISION: sources.models.eng.revision,
    ENG_MODEL_SHA256: sources.models.eng.sha256,
    ENG_MODEL_LICENSE_SOURCE: sources.models.eng.licenseSource,
    POR_MODEL_URL: sources.models.por.url,
    POR_MODEL_REVISION: sources.models.por.revision,
    POR_MODEL_SHA256: sources.models.por.sha256,
    POR_MODEL_LICENSE_SOURCE: sources.models.por.licenseSource,
    TESSDATA_LICENSE_URL: rawGithubUrl(sources.models.eng.licenseSource),
  };
  return Object.entries(values).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]);
}

function rawGithubUrl(value) {
  return value
    .replace('https://github.com/', 'https://raw.githubusercontent.com/')
    .replace('/blob/', '/');
}

function defaultRunCommand(file, arguments_, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, arguments_, {
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout: '', stderr: '' });
        return;
      }
      reject(
        releaseError(
          'OCR_RUNTIME_DOCKER_FAILED',
          `Docker OCR runtime build failed (${signal ? `signal ${signal}` : `exit ${code}`}).`,
        ),
      );
    });
  });
}

function noDownload() {
  throw releaseError(
    'OCR_RUNTIME_DOWNLOAD_INVALID',
    'The Docker OCR runtime builder validates only its already-downloaded output.',
  );
}

function argumentsError() {
  return releaseError(
    'OCR_RUNTIME_ARGUMENTS_INVALID',
    'Use --platform linux-x64 --output <directory>.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildOcrRuntime(parseBuildOcrRuntimeArguments(process.argv.slice(2)));
}
