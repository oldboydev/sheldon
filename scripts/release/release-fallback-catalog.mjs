import { createHash, verify } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import {
  buildOfficialArtifacts,
  refreshOfficialArtifactCatalog,
} from './build-official-artifacts.mjs';
import { stageOfficialArtifacts } from './stage-official-artifacts.mjs';
import { prepareYoutubeRuntime } from './prepare-youtube-runtime.mjs';
import { signOfficialCatalog } from './sign-official-catalog.mjs';
import { verifyOfficialRelease } from './verify-official-release.mjs';

export function authenticateCatalog(bytes, signature, key) {
  if (!verify(null, bytes, key, signature)) throw new Error('Previous catalog signature invalid.');
  return JSON.parse(bytes.toString('utf8'));
}

export function assertCatalogAsset(bytes, artifact) {
  if (
    !artifact ||
    bytes.length !== artifact.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  )
    throw new Error('Previous catalog artifact hash invalid.');
}

export async function retainMacArtifacts(output, previous, previousCatalog) {
  const current = JSON.parse(await readFile(join(output, 'catalog.json'), 'utf8'));
  const retained = [];
  for (const plugin of current.plugins) {
    const platforms = plugin.platforms.filter((platform) => platform.startsWith('darwin-'));
    if (!platforms.length) continue;
    const old = previousCatalog.plugins.find((candidate) => candidate.id === plugin.id);
    if (!old || old.version !== plugin.version)
      throw new Error('Incompatible macOS plugin version: ' + plugin.id);
    for (const platform of platforms) {
      const file = plugin.id + '-' + platform + '.zip';
      const bytes = await readFile(join(previous, file));
      assertCatalogAsset(bytes, old.artifacts[platform]);
      await writeFile(join(output, file), bytes);
      retained.push({ file, sha256: old.artifacts[platform].sha256, version: old.version });
    }
  }
  await refreshOfficialArtifactCatalog(output);
  return retained;
}

// Extract only the pinned OCR input; never follow archive paths or symlinks.
export async function extractOcrInput(bytes, platform, output) {
  if (!['win32-x64', 'linux-x64'].includes(platform)) throw new Error('Unsupported OCR target.');
  const zip = await JSZip.loadAsync(bytes);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const name = entry.unsafeOriginalName ?? entry.name;
    if (
      name !== entry.name ||
      name.includes('\\') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      name.startsWith('/') ||
      /(?:^|\/)[a-z]:/iu.test(name)
    )
      throw new Error('Unsafe archive path.');
    const mode = Number(entry.unixPermissions ?? 0);
    if ((mode & 0o170000) === 0o120000) throw new Error('Archive symlink forbidden.');
    const relative = name.replace(/^source\.image\//u, '');
    if (!(
      relative.startsWith('runtime/' + platform + '/') ||
      ['data/tessdata/eng.traineddata', 'data/tessdata/por.traineddata'].includes(relative)
    ))
      continue;
    const file = join(output, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await entry.async('nodebuffer'), { mode: 0o755 });
  }
}

export function localCatalogAssets(names) {
  return names.filter((name) => !name.includes('darwin-'));
}

export async function prepareLocalCatalog(root, output, previous, run) {
  const key = join(root, 'release', 'official-catalog-public.pem');
  const old = authenticateCatalog(
    await readFile(join(previous, 'catalog.json')),
    await readFile(join(previous, 'catalog.sig')),
    await readFile(key),
  );
  await verifyOfficialRelease(previous, key);
  const runtimes = join(output, 'ocr');
  for (const platform of ['win32-x64', 'linux-x64']) {
    const bytes = await readFile(join(previous, 'source.image-' + platform + '.zip'));
    assertCatalogAsset(
      bytes,
      old.plugins.find((plugin) => plugin.id === 'source.image')?.artifacts[platform],
    );
    await extractOcrInput(bytes, platform, join(runtimes, 'ocr-runtime-' + platform));
  }
  const youtube = join(output, 'youtube');
  await prepareYoutubeRuntime({ output: youtube, platforms: ['win32-x64', 'linux-x64'] });
  const stage = join(output, 'stage');
  await stageOfficialArtifacts(join(root, 'packages/plugins/official'), stage, runtimes, youtube, {
    dependencyRoot: join(root, 'node_modules'),
  });
  const directory = join(output, 'catalog');
  await buildOfficialArtifacts(stage, directory, new Date().toISOString());
  const retainedMac = await retainMacArtifacts(directory, previous, old);
  const signed = Boolean(process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM);
  if (signed) {
    await signOfficialCatalog(join(directory, 'catalog.json'), join(directory, 'catalog.sig'));
    await verifyOfficialRelease(directory, key);
  }
  // Native healthchecks, including OCR and yt-dlp, are required even in unsigned preparation.
  await run(
    process.execPath,
    ['scripts/release/smoke-official-artifacts.mjs', '--directory', directory],
    root,
  );
  return {
    directory,
    signed,
    retainedMac,
    assets: localCatalogAssets(await readdir(directory)).map((name) => join(directory, name)),
  };
}
