import { PluginHostError } from '@sheldon/plugin-host';
import {
  BASE_IMAGE_LANGUAGES,
  installImageLanguage,
  listImageLanguages,
  removeImageLanguage,
} from '@sheldon/plugin-source-image';

import { withPluginServices } from '../plugin-services.js';
import type { CommandContext } from '../runtime.js';

export async function listImageLanguageCommand(context: CommandContext): Promise<void> {
  await withPluginServices(context, async ({ registry }) => {
    const installed = await registry.getInstalled('source.image');
    for (const code of BASE_IMAGE_LANGUAGES) context.write(`${code}\tbase`);
    for (const language of await listImageLanguages(installed.root)) {
      context.write(`${language.code}\textra\t${language.catalogVersion}\t${language.installedAt}`);
    }
  });
}

export async function installImageLanguageCommand(
  code: string,
  context: CommandContext,
): Promise<void> {
  await withPluginServices(context, async ({ registry }) => {
    const installed = await registry.getInstalled('source.image');
    const catalog = await context.officialCatalogClient.load();
    const entry = catalog.languages.find(
      (candidate) => candidate.owner === 'source.image' && candidate.code === code,
    );
    if (!entry) {
      throw new PluginHostError(
        'IMAGE_LANGUAGE_NOT_CATALOGED',
        `Image language ${code} is not available in the official catalog.`,
        joinTessdata(installed.root),
        'Run sheldon image language list or choose a language from the signed official catalog.',
      );
    }
    if (!context.officialCatalogClient.downloadArtifact) {
      throw new PluginHostError(
        'OFFICIAL_ARTIFACT_DOWNLOAD_UNAVAILABLE',
        'The official catalog client cannot download image language artifacts.',
        joinTessdata(installed.root),
        'Retry with a configured official catalog client.',
      );
    }
    const record = await installImageLanguage({
      root: installed.root,
      entry,
      catalogVersion: catalog.publishedAt,
      fetcher: {
        fetch: async () => {
          throw new Error('Official artifact download must be supplied by the catalog client.');
        },
      },
      downloadArtifact: context.officialCatalogClient.downloadArtifact,
      platform: context.platform,
      now: () => new Date(),
    });
    context.write(`Image language installed: ${record.code}`);
  });
}

export async function removeImageLanguageCommand(
  code: string,
  context: CommandContext,
): Promise<void> {
  await withPluginServices(context, async ({ registry }) => {
    const installed = await registry.getInstalled('source.image');
    await removeImageLanguage(installed.root, code);
    context.write(`Image language removed: ${code}`);
  });
}

function joinTessdata(root: string): string {
  return `${root}/data/tessdata`;
}
