import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SOURCE_DIR = join('apps', 'cli', 'help');
const DEFAULT_OUTPUT_DIR = join('apps', 'cli', 'dist', 'help');

/**
 * @param {{ sourceDir: string, outputDir: string }} options
 */
export async function buildCliHelp({ sourceDir, outputDir }) {
  const manifestPath = join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await validateManifest(manifest, sourceDir);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(join(outputDir, 'pages'), { recursive: true });

  for (const page of manifest.pages) {
    const markdown = await readFile(join(sourceDir, page.file), 'utf8');
    const body = renderMarkdown(markdown);
    const isIndex = page.id === 'index';
    const stylesheetHref = isIndex ? 'styles.css' : '../styles.css';
    const html = wrapHtml({ title: page.title, stylesheetHref, body });
    const outputPath = isIndex
      ? join(outputDir, 'index.html')
      : join(outputDir, 'pages', `${page.id}.html`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, 'utf8');
  }

  await cp(join(sourceDir, 'styles.css'), join(outputDir, 'styles.css'));
  await cp(manifestPath, join(outputDir, 'manifest.json'));
}

/**
 * @param {unknown} manifest
 * @param {string} sourceDir
 */
async function validateManifest(manifest, sourceDir) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('HELP_MANIFEST_INVALID: manifest.json must be an object.');
  }
  const { schemaVersion, pages } = /** @type {{ schemaVersion?: unknown, pages?: unknown }} */ (
    manifest
  );
  if (schemaVersion !== 1) {
    throw new Error('HELP_MANIFEST_INVALID: schemaVersion must be 1.');
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('HELP_MANIFEST_INVALID: pages must be a non-empty array.');
  }

  const seen = new Set();
  for (const page of pages) {
    if (!page || typeof page !== 'object') {
      throw new Error('HELP_MANIFEST_INVALID: each page must be an object.');
    }
    const { id, title, file, commands } = /** @type {Record<string, unknown>} */ (page);
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('HELP_MANIFEST_INVALID: each page requires a non-empty id.');
    }
    if (seen.has(id)) {
      throw new Error(`HELP_MANIFEST_INVALID: duplicate page id "${id}".`);
    }
    seen.add(id);
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error(`HELP_MANIFEST_INVALID: page "${id}" requires a title.`);
    }
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error(`HELP_MANIFEST_INVALID: page "${id}" requires a file.`);
    }
    if (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string')) {
      throw new Error(`HELP_MANIFEST_INVALID: page "${id}" commands must be a string array.`);
    }
    try {
      await access(join(sourceDir, file));
    } catch {
      throw new Error(`HELP_MANIFEST_INVALID: page "${id}" file does not exist: ${file}`);
    }
  }
}

/**
 * @param {string} markdown
 */
export function renderMarkdown(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const classAttr = language ? ` class="language-${escapeHtml(language)}"` : '';
      blocks.push(`<pre><code${classAttr}>${escapeHtml(codeLines.join('\n'))}\n</code></pre>`);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^-\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^-\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^-\s+/, ''))}</li>`);
        index += 1;
      }
      blocks.push(`<ul>\n${items.join('\n')}\n</ul>`);
      continue;
    }

    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !lines[index].startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^-\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraphLines.join(' '))}</p>`);
  }

  return blocks.join('\n');
}

/**
 * @param {string} text
 */
function renderInline(text) {
  const placeholders = [];
  const stash = (html) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let result = text.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) =>
    stash(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`),
  );
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, bold) => stash(`<strong>${escapeHtml(bold)}</strong>`));
  result = escapeHtml(result);
  result = result.replace(/\u0000(\d+)\u0000/g, (_, index) => placeholders[Number(index)]);
  return result;
}

/**
 * @param {string} value
 */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * @param {{ title: string, stylesheetHref: string, body: string }} options
 */
function wrapHtml({ title, stylesheetHref, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(stylesheetHref)}">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

async function main() {
  const sourceDir = resolve(process.argv[2] ?? DEFAULT_SOURCE_DIR);
  const outputDir = resolve(process.argv[3] ?? DEFAULT_OUTPUT_DIR);
  await buildCliHelp({ sourceDir, outputDir });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
