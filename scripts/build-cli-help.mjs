import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    const html = wrapHtml({
      title: page.title,
      stylesheetHref,
      body,
      pages: manifest.pages,
      currentId: page.id,
    });
    const outputPath = isIndex
      ? join(outputDir, 'index.html')
      : join(outputDir, 'pages', `${page.id}.html`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, 'utf8');
  }

  await cp(join(sourceDir, 'styles.css'), join(outputDir, 'styles.css'));
  await cp(manifestPath, join(outputDir, 'manifest.json'));
  const fontsDir = join(sourceDir, 'fonts');
  try {
    await access(fontsDir);
    await cp(fontsDir, join(outputDir, 'fonts'), { recursive: true });
  } catch {
    // Fonts are optional in fixtures; production help ships Nunito Sans locally.
  }
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

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\d+\.\s+/, ''))}</li>`);
        index += 1;
      }
      blocks.push(`<ol>\n${items.join('\n')}\n</ol>`);
      continue;
    }

    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !lines[index].startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^-\s+/.test(lines[index]) &&
      !/^\d+\.\s+/.test(lines[index])
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
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, bold) =>
    stash(`<strong>${escapeHtml(bold)}</strong>`),
  );
  result = escapeHtml(result);
  const placeholderPattern = new RegExp(`\u0000(\\d+)\u0000`, 'g');
  result = result.replace(placeholderPattern, (_, index) => placeholders[Number(index)]);
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
 * @param {{
 *   title: string,
 *   stylesheetHref: string,
 *   body: string,
 *   pages: { id: string, title: string }[],
 *   currentId: string,
 * }} options
 */
function wrapHtml({ title, stylesheetHref, body, pages, currentId }) {
  const fromIndex = currentId === 'index';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(stylesheetHref)}">
</head>
<body>
<div class="win">
<header class="titlebar">
  <div class="titlebar__brand">
    ${equalizerSvg()}
    <span class="titlebar__title">sheldon</span>
  </div>
  <span class="titlebar__sep"></span>
  <span class="titlebar__meta">Ajuda offline</span>
</header>
<div class="appbody">
<aside class="sidebar">
${renderNav(pages, currentId, fromIndex)}
</aside>
<div class="content">
<div class="content__inner">
<article class="card card__pad prose">
${body}
</article>
</div>
</div>
</div>
</div>
</body>
</html>
`;
}

/**
 * @param {{ id: string, title: string }[]} pages
 * @param {string} currentId
 * @param {boolean} fromIndex
 */
function renderNav(pages, currentId, fromIndex) {
  const groups = [
    { label: 'Início', items: pages.filter((page) => page.id === 'index') },
    { label: 'Fluxos', items: pages.filter((page) => page.id.startsWith('flow-')) },
    {
      label: 'Comandos',
      items: pages.filter((page) => page.id !== 'index' && !page.id.startsWith('flow-')),
    },
  ];
  const sections = groups
    .filter((group) => group.items.length > 0)
    .map((group) => {
      const items = group.items
        .map((page) => {
          const href = pageHref(page.id, fromIndex);
          const active = page.id === currentId;
          const label = page.id === 'index' ? 'Ajuda' : page.title;
          const current = active ? ' aria-current="page"' : '';
          const className = active ? 'navitem is-active' : 'navitem';
          return `    <a class="${className}" href="${escapeHtml(href)}"${current}>${escapeHtml(label)}</a>`;
        })
        .join('\n');
      return `  <p class="sidebar__label">${escapeHtml(group.label)}</p>\n  <nav class="sidebar__nav">\n${items}\n  </nav>`;
    });
  return sections.join('\n');
}

/**
 * @param {string} id
 * @param {boolean} fromIndex
 */
function pageHref(id, fromIndex) {
  if (id === 'index') return fromIndex ? 'index.html' : '../index.html';
  return fromIndex ? `pages/${id}.html` : `${id}.html`;
}

function equalizerSvg() {
  return `<svg class="eq-logo" viewBox="0 0 28 18" width="28" height="18" aria-hidden="true">
    <rect x="0" y="6" width="3.2" height="12" rx="1.6" fill="var(--eq-1)"/>
    <rect x="6" y="2" width="3.2" height="16" rx="1.6" fill="var(--eq-2)"/>
    <rect x="12" y="4" width="3.2" height="14" rx="1.6" fill="var(--eq-3)"/>
    <rect x="18" y="0" width="3.2" height="18" rx="1.6" fill="var(--eq-4)"/>
    <rect x="24" y="7" width="3.2" height="11" rx="1.6" fill="var(--eq-5)"/>
  </svg>`;
}

async function main() {
  const sourceDir = resolve(process.argv[2] ?? DEFAULT_SOURCE_DIR);
  const outputDir = resolve(process.argv[3] ?? DEFAULT_OUTPUT_DIR);
  await buildCliHelp({ sourceDir, outputDir });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
