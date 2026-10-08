/** @vitest-environment jsdom */

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { KnowledgeView } from '../src/KnowledgeView.js';

const topics = [{ title: 'Memory', slug: 'memory' }];
const projects = [{ title: 'Sheldon App', slug: 'sheldon-app' }];

const recallPage = {
  id: 'recall',
  title: 'Active recall',
  path: 'wiki/recall.md',
  body: `# Practice

- Alpha
- Bravo

1. **First**

See [Study support](support.md). Use **Query** and \`COUNT\` at https://example.com/x.
`,
  sources: ['raw/source/content.md'],
  neighbours: [{ path: 'wiki/support.md', relation: 'outgoing' as const }],
};

const supportPage = {
  id: 'support',
  title: 'Study support',
  path: 'wiki/support.md',
  body: '# Support\n\nSupport body.\n',
  sources: [],
  neighbours: [{ path: 'wiki/recall.md', relation: 'incoming' as const }],
};

const pages: Record<string, unknown> = {
  'wiki/recall.md': recallPage,
  'wiki/support.md': supportPage,
  'wiki/concepts/nested.md': {
    id: 'nested',
    title: 'Nested concept',
    path: 'wiki/concepts/nested.md',
    body: '# Nested\n',
    sources: [],
    neighbours: [],
  },
  'wiki/search.md': {
    id: 'search',
    title: 'Search strategy',
    path: 'wiki/search.md',
    body: '# Search\n',
    sources: [],
    neighbours: [],
  },
};

const lists: Record<string, { path: string; title: string }[]> = {
  'topic/memory': [
    { path: 'wiki/concepts/nested.md', title: 'Nested concept' },
    { path: 'wiki/recall.md', title: 'Active recall' },
    { path: 'wiki/support.md', title: 'Study support' },
  ],
  'project/sheldon-app': [{ path: 'wiki/search.md', title: 'Search strategy' }],
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const fetches: { url: string; method: string }[] = [];

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  fetches.splice(0);
  vi.unstubAllGlobals();
});

describe('KnowledgeView', () => {
  it('lists topic and project titles and wiki paths under the selected entity in path order', async () => {
    stubFetch();
    await renderView();
    expect(container!.textContent).toContain('Memory');
    expect(container!.textContent).toContain('Sheldon App');
    expect(wikiPaths()).toEqual(['wiki/concepts/nested.md', 'wiki/recall.md', 'wiki/support.md']);

    await clickNamed('Sheldon App');
    expect(wikiPaths()).toEqual(['wiki/search.md']);
  });

  it('shows the existing empty copy when there are no topics and no projects', async () => {
    stubFetch();
    await renderView([], []);
    expect(container!.textContent).toContain(
      'Nenhum tópico ainda. Crie um tópico antes de ingerir uma fonte.',
    );
    expect(container!.textContent).not.toContain('wiki/recall.md');
    expect(container!.textContent).not.toContain('wiki / raws / propostas');
  });

  it('shows the concept title and heading html without yaml as the main content', async () => {
    stubFetch();
    await renderView();
    await clickWiki('wiki/recall.md');
    expect(container!.textContent).toContain('Active recall');
    const heading = container!.querySelector('.wiki-body h1, article h1, .wiki-body h2');
    expect(heading?.textContent).toContain('Practice');
    expect(container!.textContent).not.toContain('title: Active recall');
    expect(container!.textContent).not.toContain('---\nid:');
  });

  it('follows a relative wiki link to the target page', async () => {
    stubFetch();
    await renderView();
    await clickWiki('wiki/recall.md');
    const link = [...container!.querySelectorAll('.wiki-body a')].find((node) =>
      node.textContent?.includes('Study support'),
    );
    expect(link).toBeDefined();
    await click(link as HTMLElement);
    expect(container!.textContent).toContain('Study support');
    expect(container!.querySelector('.wiki-body')?.textContent).toContain('Support body');
  });

  it('keeps the current page and shows ApiProblem fields when the wiki target is missing', async () => {
    stubFetch({ missingWiki: true });
    await renderView();
    await clickWiki('wiki/recall.md');
    const link = [...container!.querySelectorAll('.wiki-body a')].find((node) =>
      node.textContent?.includes('Study support'),
    );
    await click(link as HTMLElement);
    expect(container!.querySelector('.wiki-body')?.textContent).toContain('Practice');
    expect(container!.textContent).toContain('WEB_NOT_FOUND');
    expect(container!.textContent).toContain('Wiki page not found.');
    expect(container!.textContent).toContain('Choose another page from the tree.');
  });

  it('does not render file contents from outside wiki', async () => {
    stubFetch();
    await renderView();
    await clickWiki('wiki/recall.md');
    expect(container!.textContent).not.toContain('LEAKED_ENTITY_SECRET');
    const leak = [...container!.querySelectorAll('a, button')].find((node) =>
      (node.getAttribute('href') ?? node.textContent ?? '').includes('../secret.md'),
    );
    if (leak) await click(leak as HTMLElement);
    expect(container!.textContent).not.toContain('LEAKED_ENTITY_SECRET');
  });

  it('lists a source path and shows raw text when opened', async () => {
    stubFetch();
    await renderView();
    await clickWiki('wiki/recall.md');
    expect(container!.textContent).toContain('raw/source/content.md');
    await clickNamed('raw/source/content.md');
    expect(container!.textContent).toContain('Cited raw source.');
  });

  it('lists a missing source and says it was not found', async () => {
    stubFetch({ missingRaw: true });
    await renderView();
    await clickWiki('wiki/recall.md');
    expect(container!.textContent).toContain('raw/source/content.md');
    await clickNamed('raw/source/content.md');
    expect(container!.textContent).toContain('não encontr');
    expect(container!.textContent).not.toContain('LEAKED_ENTITY_SECRET');
  });

  it('lists outgoing and incoming neighbours and opens one', async () => {
    stubFetch();
    await renderView();
    await clickWiki('wiki/recall.md');
    expect(container!.textContent).toMatch(/wiki\/support\.md/);
    await clickWiki('wiki/support.md');
    expect(container!.querySelector('.wiki-body')?.textContent).toContain('Support body');
  });

  it('does not post wiki edits or queue an agent from conhecimento', async () => {
    stubFetch();
    await renderView();
    await clickWiki('wiki/recall.md');
    await clickWiki('wiki/support.md');
    expect(fetches.every((item) => item.method === 'GET')).toBe(true);
    expect(fetches.some((item) => item.url.includes('/jobs'))).toBe(false);
    expect(fetches.some((item) => item.method !== 'GET')).toBe(false);
    expect(container!.querySelector('textarea, input[type="text"]')).toBeNull();
  });

  it('does not repeat the page title as a body h1', async () => {
    stubFetch({ recallBody: '# Active recall\n\nBody copy.\n' });
    await renderView();
    await clickWiki('wiki/recall.md');
    expect(container!.querySelector('.wiki-article > h2')?.textContent).toBe('Active recall');
    expect(container!.querySelector('.wiki-body h1')).toBeNull();
    expect(container!.querySelector('.wiki-body')?.textContent).toContain('Body copy.');
  });

  it('renders lists strong code and autolinks in the wiki body', async () => {
    stubFetch();
    await renderView();
    await clickWiki('wiki/recall.md');
    const body = container!.querySelector('.wiki-body');
    expect([...body!.querySelectorAll('ul li')].map((item) => item.textContent)).toEqual([
      'Alpha',
      'Bravo',
    ]);
    expect([...body!.querySelectorAll('ol li')].map((item) => item.textContent)).toEqual(['First']);
    expect(body!.querySelector('p strong')?.textContent).toBe('Query');
    expect(body!.querySelector('code')?.textContent).toBe('COUNT');
    expect(body!.querySelector('a[href="https://example.com/x"]')).not.toBeNull();
  });

  it('shows concept titles in the tree and marks the open path active', async () => {
    stubFetch();
    await renderView();
    const recall = container!.querySelector('[data-wiki-path="wiki/recall.md"]');
    expect(recall?.textContent?.trim()).toBe('Active recall');
    expect(
      container!.querySelector('[data-wiki-path="wiki/support.md"]')?.textContent?.trim(),
    ).toBe('Study support');
    await clickWiki('wiki/recall.md');
    expect(recall?.classList.contains('is-active')).toBe(true);
  });

  it('labels neighbours saindo and entrando without quiet buttons', async () => {
    stubFetch();
    await renderView();
    await clickWiki('wiki/recall.md');
    expect(container!.textContent).toMatch(/saindo/);
    expect(container!.textContent).not.toMatch(/\boutgoing\b/);
    expect(container!.querySelector('.wiki-aside .quiet')).toBeNull();
    await clickWiki('wiki/support.md');
    expect(container!.textContent).toMatch(/entrando/);
    expect(container!.textContent).not.toMatch(/\bincoming\b/);
  });
});

function stubFetch(
  options: { missingWiki?: boolean; missingRaw?: boolean; recallBody?: string } = {},
): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetches.push({ url, method });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const notFound = json(404, {
      code: 'WEB_NOT_FOUND',
      message: 'Wiki page not found.',
      recovery: 'Choose another page from the tree.',
    });

    const wikiList = /\/api\/v1\/entities\/(topic|project)\/([^/]+)\/wiki$/u.exec(url);
    if (wikiList) {
      const key = `${wikiList[1]}/${wikiList[2]}`;
      return json(200, lists[key] ?? []);
    }
    const wikiPage = /\/api\/v1\/entities\/(topic|project)\/([^/]+)\/wiki\/(.+)$/u.exec(url);
    if (wikiPage) {
      const relative = decodeURIComponent(wikiPage[3]!);
      if (relative.includes('..') || relative.includes('secret')) return notFound;
      const path = relative.startsWith('wiki/') ? relative : `wiki/${relative}`;
      if (options.missingWiki && path === 'wiki/support.md') return notFound;
      const page = pages[path];
      if (page === undefined) return notFound;
      if (options.recallBody !== undefined && path === 'wiki/recall.md') {
        return json(200, { ...recallPage, body: options.recallBody });
      }
      return json(200, page);
    }
    const raw = /\/api\/v1\/entities\/(topic|project)\/([^/]+)\/raw\/(.+)$/u.exec(url);
    if (raw) {
      const relative = decodeURIComponent(raw[3]!);
      if (relative.includes('..')) return notFound;
      if (options.missingRaw) {
        return json(404, {
          code: 'WEB_NOT_FOUND',
          message: 'Fonte não encontrada.',
          recovery: 'A fonte citada não está neste tópico.',
        });
      }
      return new Response('Cited raw source.\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return json(404, { code: 'WEB_NOT_FOUND', message: 'missing', recovery: 'retry' });
  });
}

async function renderView(
  nextTopics: readonly { title: string; slug: string }[] = topics,
  nextProjects: readonly { title: string; slug: string }[] = projects,
): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(KnowledgeView, { topics: nextTopics, projects: nextProjects }));
    await Promise.resolve();
  });
}

async function clickWiki(path: string): Promise<void> {
  const node = container!.querySelector(`[data-wiki-path="${path}"]`);
  expect(node, `wiki path ${path}`).not.toBeNull();
  await click(node as HTMLElement);
}

async function clickNamed(text: string): Promise<void> {
  const node = [...container!.querySelectorAll('button, a, [role="button"]')].find((item) =>
    item.textContent?.includes(text),
  );
  expect(node, `clickable "${text}"`).toBeDefined();
  await click(node as HTMLElement);
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click();
    await Promise.resolve();
  });
}

function wikiPaths(): string[] {
  return [...container!.querySelectorAll('[data-wiki-path]')]
    .map((node) => node.getAttribute('data-wiki-path') ?? node.textContent?.trim() ?? '')
    .filter((path) => path.startsWith('wiki/'));
}
