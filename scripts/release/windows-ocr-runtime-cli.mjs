import { readFile } from 'node:fs/promises';

import { OCR_RUNTIME_SOURCES } from './ocr-runtime-sources.mjs';
import {
  assertPinnedMsys2PackageGraph,
  downloadPinnedFile,
  parseMsys2PackageGraph,
  preflightMsys2RuntimeDependencies,
  renderVerifiedMsys2DependencyNotice,
} from './windows-ocr-runtime.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}

async function main(arguments_) {
  const command = parseCommand(arguments_);

  switch (command.name) {
    case 'sources':
      process.stdout.write(JSON.stringify(OCR_RUNTIME_SOURCES));
      break;
    case 'graph-lock': {
      const installed = parseMsys2PackageGraph(await readBoundedStdin());
      const lock = await readGraphLock(command.lock, installed);
      try {
        assertPinnedMsys2PackageGraph(installed, lock);
      } catch (error) {
        if (errorMessage(error).startsWith('OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID')) {
          throw graphLockErrorWithInstalled(error, installed);
        }
        throw error;
      }
      break;
    }
    case 'dependency-preflight': {
      const identities = parseJsonStdin(await readBoundedStdin());
      const result = preflightMsys2RuntimeDependencies(identities);
      for (const diagnostic of result.diagnostics) {
        process.stderr.write(`${diagnostic}\n`);
      }
      process.stdout.write(JSON.stringify(result));
      break;
    }
    case 'download':
      await downloadPinnedFile({
        url: command.url,
        destination: command.output,
        expectedSha256: command.sha256,
        onDiagnostic: (diagnostic) => process.stderr.write(`${diagnostic}\n`),
      });
      break;
    case 'dependency-notice': {
      const options = parseJsonStdin(await readBoundedStdin());
      process.stdout.write(await renderVerifiedMsys2DependencyNotice(options));
      break;
    }
  }
}

function parseCommand(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length === 0) {
    throw argumentsError();
  }

  const [name, ...rest] = arguments_;
  switch (name) {
    case 'graph-lock': {
      const options = parseOptions(rest, ['--lock']);
      return { name, lock: options['--lock'] };
    }
    case 'sources':
    case 'dependency-preflight':
    case 'dependency-notice':
      if (rest.length !== 0) throw argumentsError();
      return { name };
    case 'download': {
      const options = parseOptions(rest, ['--url', '--output', '--sha256']);
      return {
        name,
        url: options['--url'],
        output: options['--output'],
        sha256: options['--sha256'],
      };
    }
    default:
      throw argumentsError();
  }
}

function parseOptions(arguments_, expectedNames) {
  if (arguments_.length !== expectedNames.length * 2) throw argumentsError();

  const expected = new Set(expectedNames);
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!expected.has(name) || Object.hasOwn(options, name) || value.length === 0) {
      throw argumentsError();
    }
    options[name] = value;
  }
  if (Object.keys(options).length !== expectedNames.length) throw argumentsError();
  return options;
}

async function readBoundedStdin() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_INPUT_BYTES) {
      throw argumentsError(`stdin exceeds ${MAX_INPUT_BYTES} bytes.`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

function parseJsonStdin(input) {
  try {
    return JSON.parse(input);
  } catch {
    throw argumentsError('stdin must contain valid JSON.');
  }
}

async function readGraphLock(path, installed) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw graphLockErrorWithInstalled(
      new Error('OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID: Unable to read the committed graph lock.'),
      installed,
    );
  }
  if (bytes.length > MAX_INPUT_BYTES) {
    throw graphLockErrorWithInstalled(
      new Error('OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID: Graph lock exceeds the fixed size bound.'),
      installed,
    );
  }

  let lock;
  try {
    lock = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw graphLockErrorWithInstalled(
      new Error('OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID: Graph lock must contain valid JSON.'),
      installed,
    );
  }
  return lock;
}

function graphLockErrorWithInstalled(error, installed) {
  return new Error(
    [
      errorMessage(error),
      'installed:',
      ...installed.map(({ name, version }) => `- ${name}@${version}`),
    ].join('\n'),
  );
}

function argumentsError(detail = 'Invalid Windows OCR runtime CLI arguments.') {
  return new Error(`OCR_RUNTIME_ARGUMENTS_INVALID: ${detail}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
