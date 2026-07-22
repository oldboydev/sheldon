import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { buildOcrRuntime, parseBuildOcrRuntimeArguments } from '../build-ocr-runtime.mjs';
import { OCR_RUNTIME_SOURCES } from '../ocr-runtime-sources.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Linux OCR runtime builder', () => {
  it('invokes Docker with an argument vector and validates the canonical output', async () => {
    const root = await temporaryRoot();
    const output = join(root, 'output with spaces');
    const sources = testSources();
    const runCommand = vi.fn(
      async (_file: string, arguments_: readonly string[], options: object) => {
        expect(options).toMatchObject({ shell: false });
        await writeArtifact(output);
        return { stdout: '', stderr: '' };
      },
    );

    await buildOcrRuntime({
      platform: 'linux-x64',
      output,
      runCommand,
      sources,
    });

    expect(runCommand).toHaveBeenCalledOnce();
    const [file, arguments_] = runCommand.mock.calls[0];
    expect(file).toBe('docker');
    expect(arguments_).toContain('build');
    expect(arguments_).toContain('linux/amd64');
    expect(arguments_).toContain(`type=local,dest=${resolve(output)}`);
    const dockerfile = arguments_[arguments_.indexOf('--file') + 1];
    expect(isAbsolute(dockerfile)).toBe(true);
    expect(dockerfile).toMatch(/Dockerfile\.ocr-linux$/u);
    expect(arguments_).toContain(`TESSERACT_URL=${sources.tesseract.url}`);
    expect(arguments_).toContain(`TESSERACT_REVISION=${sources.tesseract.revision}`);
    expect(arguments_).toContain(`TESSERACT_SHA256=${sources.tesseract.sha256}`);
    expect(arguments_).toContain(`TESSERACT_LICENSE_SOURCE=${sources.tesseract.licenseSource}`);
    expect(arguments_).toContain(`ENG_MODEL_URL=${sources.models.eng.url}`);
    expect(arguments_).toContain(`ENG_MODEL_SHA256=${sources.models.eng.sha256}`);
    expect(arguments_).toContain(`POR_MODEL_URL=${sources.models.por.url}`);
    expect(arguments_).toContain(`POR_MODEL_SHA256=${sources.models.por.sha256}`);
    expect(arguments_).toContain(
      `TESSDATA_LICENSE_URL=https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${sources.models.eng.revision}/LICENSE`,
    );
  });

  it('rejects unsupported platforms before invoking Docker', async () => {
    const runCommand = vi.fn();

    await expect(
      buildOcrRuntime({
        platform: 'darwin-x64',
        output: 'artifact',
        runCommand,
      }),
    ).rejects.toThrow('OCR_RUNTIME_PLATFORM_INVALID');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects a Docker output with extra entries via the Task 1 validator', async () => {
    const root = await temporaryRoot();
    const output = join(root, 'artifact');

    await expect(
      buildOcrRuntime({
        platform: 'linux-x64',
        output,
        sources: testSources(),
        runCommand: async () => {
          await writeArtifact(output);
          await writeFile(join(output, 'unexpected.txt'), 'unexpected');
          return { stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow('OCR_RUNTIME_ARTIFACT_LAYOUT_INVALID');
  });

  it('accepts only the documented CLI arguments', () => {
    expect(
      parseBuildOcrRuntimeArguments(['--platform', 'linux-x64', '--output', 'artifact']),
    ).toEqual({ platform: 'linux-x64', output: 'artifact' });
    expect(() =>
      parseBuildOcrRuntimeArguments([
        '--platform',
        'linux-x64',
        '--output',
        'artifact',
        '--extra',
        'value',
      ]),
    ).toThrow('OCR_RUNTIME_ARGUMENTS_INVALID');
    expect(() => parseBuildOcrRuntimeArguments(['--platform', 'linux-x64'])).toThrow(
      'OCR_RUNTIME_ARGUMENTS_INVALID',
    );
  });
});

describe('Native OCR runtime workflow', () => {
  it('builds and names an artifact for every supported native platform', async () => {
    const workflow = parse(await readFile('.github/workflows/build-ocr-runtime.yml', 'utf8')) as {
      on?: { workflow_dispatch?: unknown };
      jobs?: {
        build?: {
          strategy?: { matrix?: { platform?: unknown } };
          steps?: Array<{ uses?: string; with?: { name?: string } }>;
        };
      };
    };

    expect(workflow.on?.workflow_dispatch).toEqual({});
    expect(workflow.jobs?.build?.strategy?.matrix?.platform).toEqual([
      'win32-x64',
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
    ]);
    expect(workflow.jobs?.build?.steps).toContainEqual(
      expect.objectContaining({
        uses: 'actions/upload-artifact@v4',
        with: expect.objectContaining({ name: 'ocr-runtime-${{ matrix.platform }}' }),
      }),
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-build-ocr-runtime-test-'));
  temporaryRoots.push(root);
  return root;
}

async function writeArtifact(root: string): Promise<void> {
  await mkdir(join(root, 'runtime', 'linux-x64'), { recursive: true });
  await mkdir(join(root, 'data', 'tessdata'), { recursive: true });
  await writeFile(join(root, 'runtime', 'linux-x64', 'tesseract'), 'runtime');
  await writeFile(join(root, 'runtime', 'linux-x64', 'THIRD_PARTY_NOTICES'), 'notices');
  await writeFile(join(root, 'data', 'tessdata', 'eng.traineddata'), 'eng');
  await writeFile(join(root, 'data', 'tessdata', 'por.traineddata'), 'por');
}

function testSources() {
  return {
    tesseract: OCR_RUNTIME_SOURCES.tesseract,
    models: {
      eng: { ...OCR_RUNTIME_SOURCES.models.eng, sha256: sha256('eng') },
      por: { ...OCR_RUNTIME_SOURCES.models.por, sha256: sha256('por') },
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
