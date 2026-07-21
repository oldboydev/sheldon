import { createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function signOfficialCatalog(catalogPath, signaturePath) {
  const privateKey = process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
  if (!privateKey) {
    throw new Error('SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM is required in release CI.');
  }
  const signature = sign(null, await readFile(catalogPath), createPrivateKey(privateKey));
  await writeFile(signaturePath, signature);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [catalogFlag, catalogPath, signatureFlag, signaturePath] = process.argv.slice(2);
  if (
    catalogFlag !== '--catalog' ||
    signatureFlag !== '--signature' ||
    !catalogPath ||
    !signaturePath
  ) {
    throw new Error('Use --catalog <path> --signature <path>.');
  }
  await signOfficialCatalog(catalogPath, signaturePath);
}
