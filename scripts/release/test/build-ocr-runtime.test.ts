import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { buildOcrRuntime, parseBuildOcrRuntimeArguments } from '../build-ocr-runtime.mjs';
import {
  findPinnedOcrRuntimeDependency,
  formatMissingOcrRuntimeDependencies,
  OCR_RUNTIME_DEPENDENCY_INVENTORY,
} from '../ocr-runtime-dependency-inventory.mjs';
import { OCR_RUNTIME_SOURCES } from '../ocr-runtime-sources.mjs';

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

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
    expect(arguments_).toContain(`TESSDATA_LICENSE_SHA256=${sources.models.eng.licenseSha256}`);
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
        uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
        with: expect.objectContaining({ name: 'ocr-runtime-${{ matrix.platform }}' }),
      }),
    );
    expect(workflow.jobs?.build?.steps?.map((step) => step.uses).filter(Boolean)).toEqual([
      'actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8',
      'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444',
      'msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ]);
    expect(workflow.jobs?.build?.steps).toContainEqual(
      expect.objectContaining({ with: expect.objectContaining({ 'node-version': '24.13.0' }) }),
    );
  });

  it("uses the MSYS2 Leptonica installation instead of Tesseract's unavailable SW path", async () => {
    const builder = await readFile('scripts/release/build-native-ocr-runtime.ps1', 'utf8');

    expect(builder).toContain('-DSW_BUILD=OFF');
    expect(builder).toContain('& $pacman -Qo $packagePath');
  });

  it('preflights a singleton MSYS2 identity as an array', async () => {
    const windowsBuilder = await readFile('scripts/release/build-native-ocr-runtime.ps1', 'utf8');
    const result = await executeWindowsDependencyPreflight(windowsBuilder, [
      { provider: 'msys2', name: 'mingw-w64-x86_64-singleton', version: '1.0.0-1' },
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stdout, result.stderr).toContain(
      'OCR_RUNTIME_DEPENDENCY: provider=msys2 name=mingw-w64-x86_64-singleton version=1.0.0-1',
    );
    expect(result.stderr).toContain(
      ['OCR_RUNTIME_MISSING_DEPENDENCIES:', 'msys2/mingw-w64-x86_64-singleton@1.0.0-1'].join('\n'),
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      'OCR_RUNTIME_TEST_MATERIALIZATION_REACHED',
    );
  });

  it.each([
    ['empty', []],
    ['malformed', [{ provider: 'msys2', name: '', version: '1.0.0-1' }]],
  ])('fails closed for an %s MSYS2 identity set', async (_case, identities) => {
    const windowsBuilder = await readFile('scripts/release/build-native-ocr-runtime.ps1', 'utf8');
    const result = await executeWindowsDependencyPreflight(windowsBuilder, identities);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('OCR_RUNTIME_');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      'OCR_RUNTIME_TEST_MATERIALIZATION_REACHED',
    );
  });

  it('batch-reports every missing MSYS2 identity before downloading a notice source', async () => {
    const windowsBuilder = await readFile('scripts/release/build-native-ocr-runtime.ps1', 'utf8');
    const discoveredDependencies = [
      { provider: 'msys2', name: 'mingw-w64-x86_64-zlib', version: '1.3.2-1' },
      { provider: 'msys2', name: 'mingw-w64-x86_64-brotli', version: '1.1.0-2' },
      { provider: 'msys2', name: 'mingw-w64-x86_64-libpng', version: '1.6.46-1' },
    ];

    expect(
      formatMissingOcrRuntimeDependencies(
        discoveredDependencies.filter(
          ({ provider, name, version }) =>
            !findPinnedOcrRuntimeDependency(
              provider,
              name,
              version,
              OCR_RUNTIME_DEPENDENCY_INVENTORY,
            ),
        ),
      ),
    ).toBe(
      [
        'OCR_RUNTIME_MISSING_DEPENDENCIES:',
        'msys2/mingw-w64-x86_64-brotli@1.1.0-2',
        'msys2/mingw-w64-x86_64-libpng@1.6.46-1',
        'msys2/mingw-w64-x86_64-zlib@1.3.2-1',
      ].join('\n'),
    );
    expect(windowsBuilder).toContain('findPinnedOcrRuntimeDependency');
    expect(windowsBuilder).toContain('OCR_RUNTIME_MISSING_DEPENDENCIES');
    expect(windowsBuilder.indexOf('OCR_RUNTIME_MISSING_DEPENDENCIES')).toBeLessThan(
      windowsBuilder.indexOf('Get-VerifiedDependencyNotice'),
    );

    const result = await executeWindowsDependencyPreflight(windowsBuilder, discoveredDependencies);

    expect(result.code).not.toBe(0);
    expect(result.stdout, result.stderr).toContain(
      [
        'OCR_RUNTIME_DEPENDENCY: provider=msys2 name=mingw-w64-x86_64-zlib version=1.3.2-1',
        'OCR_RUNTIME_DEPENDENCY: provider=msys2 name=mingw-w64-x86_64-brotli version=1.1.0-2',
        'OCR_RUNTIME_DEPENDENCY: provider=msys2 name=mingw-w64-x86_64-libpng version=1.6.46-1',
      ].join('\n'),
    );
    expect(result.stderr).toContain(
      [
        'OCR_RUNTIME_MISSING_DEPENDENCIES:',
        'msys2/mingw-w64-x86_64-brotli@1.1.0-2',
        'msys2/mingw-w64-x86_64-libpng@1.6.46-1',
        'msys2/mingw-w64-x86_64-zlib@1.3.2-1',
      ].join('\n'),
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      'OCR_RUNTIME_TEST_MATERIALIZATION_REACHED',
    );
  });

  it('batch-reports every missing Homebrew identity before downloading a notice source', async () => {
    const macosBuilder = await readFile('scripts/release/build-native-ocr-runtime.sh', 'utf8');
    const preflightOffset = macosBuilder.indexOf('lookup_exit_code=0');
    if (preflightOffset < 0) throw new Error('The Homebrew dependency preflight is missing.');
    const root = await temporaryRoot();
    const harness = join(root, 'missing-homebrew-preflight-harness.sh');
    await writeFile(
      harness,
      `#!/usr/bin/env bash
set -euo pipefail
repository_root=${JSON.stringify(process.cwd().replaceAll('\\\\', '/'))}
dependency_names=(zlib brotli libpng)
dependency_versions=(1.3.2 1.1.0 1.6.46)
dependency_libraries=(libz.dylib libbrotli.dylib libpng.dylib)
download_pinned() {
  printf '%s\\n' 'OCR_RUNTIME_TEST_DOWNLOAD_CALLED' >&2
  return 97
}
${macosBuilder.slice(preflightOffset)}`,
      'utf8',
    );

    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    let result: { stdout?: string; stderr?: string; code?: number | null };
    try {
      await execFileAsync(bash, [harness], { shell: false });
      throw new Error('The missing-Homebrew preflight unexpectedly succeeded.');
    } catch (error) {
      result = error as { stdout?: string; stderr?: string; code?: number | null };
    }

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      [
        'OCR_RUNTIME_DEPENDENCY: provider=homebrew name=zlib version=1.3.2',
        'OCR_RUNTIME_DEPENDENCY: provider=homebrew name=brotli version=1.1.0',
        'OCR_RUNTIME_DEPENDENCY: provider=homebrew name=libpng version=1.6.46',
        'OCR_RUNTIME_MISSING_DEPENDENCIES:',
        'homebrew/brotli@1.1.0',
        'homebrew/libpng@1.6.46',
        'homebrew/zlib@1.3.2',
      ].join('\n'),
    );
    expect(result.stderr).not.toContain('OCR_RUNTIME_TEST_DOWNLOAD_CALLED');
  });

  it('resolves macOS dylib compatibility symlinks while bundling dependencies', async () => {
    const builder = await readFile('scripts/release/build-native-ocr-runtime.sh', 'utf8');

    expect(builder).toContain('\\( -type f -o -type l \\) -name "$dependency_name"');
    expect(builder).toContain("url.hostname = 'raw.githubusercontent.com';");
  });

  it('fails closed while resolving prefix-linked macOS dylibs to Cellar files', async () => {
    const builder = await readFile('scripts/release/build-native-ocr-runtime.sh', 'utf8');
    const resolverMatch = builder.match(
      /canonical_path\(\) \{[\s\S]*?resolve_cellar_library_path\(\) \{[\s\S]*?\n\}\n(?=\nvisited=)/u,
    );
    if (!resolverMatch) throw new Error('The prefix-linked dylib resolver is missing.');
    const root = await temporaryRoot();
    const harness = join(root, 'resolver-harness.sh');
    await writeFile(
      harness,
      `#!/usr/bin/env bash
set -euo pipefail
${resolverMatch[0]}
if [[ "\${OSTYPE:-}" == msys* ]]; then
  symlink_candidate=''
  symlink_target=''
  external_candidate=''
  external_target=''
  broken_candidate=''
  broken_canonical=''
  canonical_path() {
    case "$1" in
      "$symlink_candidate") printf '%s\\n' "$symlink_target" ;;
      "$external_candidate") printf '%s\\n' "$external_target" ;;
      "$broken_candidate") printf '%s\\n' "$broken_canonical" ;;
      *) readlink -m "$1" ;;
    esac
  }
fi

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
cellar="$root/Cellar"
source="$root/prefix/libsharpyuv.0.dylib"
candidate="$cellar/libwebp/1.6.0/lib/libsharpyuv.0.dylib"
mkdir -p "$(dirname "$source")" "$(dirname "$candidate")"
printf 'same' > "$source"
printf 'same' > "$candidate"

resolved="$(resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$cellar" "$root/unique")"
[[ "$resolved" == "$candidate" ]]

symlink_cellar="$root/symlink-Cellar"
symlink_target="$symlink_cellar/libwebp/1.6.0/lib/libsharpyuv.0.1.1.dylib"
symlink_candidate="$symlink_cellar/libwebp/1.6.0/lib/libsharpyuv.0.dylib"
mkdir -p "$(dirname "$symlink_target")" "$(dirname "$symlink_candidate")"
printf 'same' > "$symlink_target"
ln -s "$symlink_target" "$symlink_candidate"
resolved="$(resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$symlink_cellar" "$root/symlink")"
[[ "$resolved" == "$(canonical_path "$symlink_target")" ]]

external_cellar="$root/external-Cellar"
external_target="$root/external-target/libsharpyuv.0.1.1.dylib"
external_candidate="$external_cellar/libwebp/1.6.0/lib/libsharpyuv.0.dylib"
mkdir -p "$(dirname "$external_target")" "$(dirname "$external_candidate")"
printf 'same' > "$external_target"
ln -s "$external_target" "$external_candidate"
if resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$external_cellar" "$root/external"; then exit 1; fi

broken_cellar="$root/broken-Cellar"
broken_candidate="$broken_cellar/libwebp/1.6.0/lib/libsharpyuv.0.dylib"
broken_canonical="$broken_cellar/libwebp/1.6.0/lib/libsharpyuv.0.1.1.dylib"
mkdir -p "$(dirname "$broken_canonical")"
: > "$broken_canonical"
ln -s "$broken_canonical" "$broken_candidate"
rm "$broken_canonical"
if broken_error="$(resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$broken_cellar" "$root/broken" 2>&1)"; then exit 1; fi
[[ "$broken_canonical" == "$broken_cellar/"* && ! -f "$broken_canonical" ]]
[[ "$broken_error" == *'does not resolve inside the Homebrew Cellar'* && "$broken_error" == *"$broken_candidate"* ]]
printf '%s\\n' 'OCR_RUNTIME_TEST_BROKEN_CELLAR_TARGET_REJECTED' >&2

mkdir -p "$root/empty"
if zero_error="$(resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$root/empty" "$root/zero" 2>&1)"; then exit 1; fi
[[ "$zero_error" == *'did not resolve to exactly one byte-identical Cellar file'* ]]

printf 'different' > "$candidate"
if resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$cellar" "$root/nonidentical"; then exit 1; fi

printf 'same' > "$candidate"
duplicate="$cellar/another/1.0.0/lib/libsharpyuv.0.dylib"
mkdir -p "$(dirname "$duplicate")"
printf 'same' > "$duplicate"
if resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$cellar" "$root/multiple"; then exit 1; fi

cmp() { return 2; }
if resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$cellar" "$root/cmp-error"; then exit 1; fi
unset -f cmp

find() { return 1; }
if resolve_cellar_library_path "$source" libsharpyuv.0.dylib "$cellar" "$root/find-error"; then exit 1; fi
`,
      'utf8',
    );

    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    let stderr: string;
    try {
      ({ stderr } = await execFileAsync(bash, [harness], { shell: false }));
    } catch (error) {
      const result = error as { stderr?: string; stdout?: string };
      throw new Error(`Resolver harness failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`, {
        cause: error,
      });
    }

    expect(stderr).toContain('did not resolve to exactly one byte-identical Cellar file');
    expect(stderr).toContain('does not resolve inside the Homebrew Cellar');
    expect(stderr).toContain('OCR_RUNTIME_TEST_BROKEN_CELLAR_TARGET_REJECTED');
    expect(stderr).toContain('Unable to compare Homebrew library');
    expect(stderr).toContain('Unable to traverse the Homebrew Cellar');
    expect(builder).toContain(
      'find "$cellar" \\( -type f -o -type l \\) -name "$library_name" -print0 >',
    );
    expect(builder).toContain('if cmp -s "$library_source" "$canonical_candidate"; then');
    expect(builder).toContain('canonical_path "$cellar_candidate"');
    expect(builder).toContain('if (( cmp_status > 1 )); then');
    expect(builder).not.toContain('done < <(find "$cellar"');
  });

  it('builds native dependency notices from verified pinned source records', async () => {
    const [windowsBuilder, macosBuilder] = await Promise.all([
      readFile('scripts/release/build-native-ocr-runtime.ps1', 'utf8'),
      readFile('scripts/release/build-native-ocr-runtime.sh', 'utf8'),
    ]);

    expect(windowsBuilder).toContain('findPinnedOcrRuntimeDependency');
    expect(windowsBuilder).toContain('& $pacman -Q $packageName');
    expect(windowsBuilder).toContain('$dependency.sourceUrl');
    expect(windowsBuilder).toContain('$dependency.sourceSha256');
    expect(windowsBuilder).toContain('$dependency.licenses');
    expect(windowsBuilder).toContain('$license.path');
    expect(windowsBuilder).toContain('$license.sha256');
    expect(windowsBuilder).not.toContain('/share/licenses/');

    expect(macosBuilder).toContain('findPinnedOcrRuntimeDependency');
    expect(macosBuilder).toContain('brew --cellar');
    expect(macosBuilder).toContain('if ! cellar="$(brew --cellar)"; then');
    expect(macosBuilder).toContain('brew info --json=v2 --installed');
    expect(macosBuilder).toContain(
      'Homebrew library did not resolve to exactly one byte-identical Cellar file',
    );
    expect(macosBuilder).not.toContain('brew which-formula');
    expect(macosBuilder).toContain('sourceUrl');
    expect(macosBuilder).toContain('sourceSha256');
    expect(macosBuilder).toContain('dependency.licenses');
    expect(macosBuilder).toContain('JSON.stringify(dependency.licenses)');
    expect(macosBuilder).toContain('license_spdx');
    expect(macosBuilder).not.toContain("-iname 'LICENSE*'");
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

async function executeWindowsDependencyPreflight(
  windowsBuilder: string,
  identities: unknown[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const preflightFunction = windowsBuilder.match(
    /  function Get-PinnedDependencies\([\s\S]*?(?=\n  function Get-VerifiedDependencyNotice)/u,
  )?.[0];
  const materializationBranch = windowsBuilder.match(
    /  \$pinnedDependencies = @\(Get-PinnedDependencies[\s\S]*?(?=\n  \$modelLicense =)/u,
  )?.[0];
  if (!preflightFunction || !materializationBranch) {
    throw new Error('The Windows MSYS2 dependency preflight control branch is missing.');
  }

  const root = await temporaryRoot();
  const harness = join(root, 'missing-msys2-preflight-harness.ps1');
  const repositoryRoot = process.cwd().replaceAll("'", "''");
  const identitiesJson = JSON.stringify(identities).replaceAll("'", "''");
  await writeFile(
    harness,
    `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = '${repositoryRoot}'
${preflightFunction}

function Get-VerifiedDependencyNotice {
  throw 'OCR_RUNTIME_TEST_MATERIALIZATION_REACHED'
}

$privateDllProviders = @{}
$packageIdentities = ConvertFrom-Json -InputObject '${identitiesJson}'
try {
${materializationBranch}
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`,
    'utf8',
  );

  const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const powershellArguments =
    process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness]
      : ['-NoProfile', '-File', harness];
  try {
    const result = await execFileAsync(powershell, powershellArguments, {
      encoding: 'utf8',
      shell: false,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as {
      stdout?: string;
      stderr?: string;
      code?: number | null;
    };
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code: result.code ?? null,
    };
  }
}
