/** @vitest-environment jsdom */

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ReviewView } from '../src/ReviewView.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const fetches: { url: string; method: string; body?: unknown }[] = [];

const nestedPreview = {
  proposalId: 'proposal-observability-notes-3',
  files: {
    proposalId: 'proposal-observability-notes-3',
    sources: [],
    claims: [],
    contradictions: [],
    confidence: 'high',
    files: [
      {
        path: 'wiki/wide-events.md',
        operation: 'create',
        changed: true,
        sources: ['raw/a/content.md'],
        diff: { text: '+Wide events body', addedLines: 1, removedLines: 0 },
      },
      {
        path: 'wiki/canonical-log-lines.md',
        operation: 'create',
        changed: true,
        sources: ['raw/b/content.md'],
        diff: { text: '+Canonical log lines', addedLines: 1, removedLines: 0 },
      },
    ],
  },
};

const pendingList = {
  topics: [
    {
      slug: 'observability',
      title: 'Observability',
      proposals: [
        {
          id: 'proposal-observability-notes-3',
          agent: 'grok',
          createdAt: '2026-10-02T22:24:23.050Z',
        },
      ],
    },
  ],
};

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

describe('ReviewView', () => {
  it('offers topic and proposal selects from pending reviews and renders nested preview files', async () => {
    stubFetch({ list: pendingList, preview: nestedPreview });
    await renderView();

    const topic = container!.querySelector('select[name="topic"]') as HTMLSelectElement;
    const proposal = container!.querySelector('select[name="proposal"]') as HTMLSelectElement;
    expect([...topic.options].map((option) => option.value)).toEqual(['observability']);
    expect([...proposal.options].map((option) => option.value)).toEqual([
      'proposal-observability-notes-3',
    ]);

    await clickNamed('Abrir revisão');
    expect(container!.textContent).toContain('wiki/wide-events.md');
    expect(container!.textContent).toContain('+Wide events body');
    expect(container!.textContent).toContain('wiki/canonical-log-lines.md');
  });

  it('shows the API error when preview fails', async () => {
    stubFetch({
      list: pendingList,
      previewError: { message: 'A proposal with status error cannot be promoted.' },
    });
    await renderView();
    await clickNamed('Abrir revisão');
    expect(container!.textContent).toContain('A proposal with status error cannot be promoted.');
    expect(container!.textContent).not.toContain('wiki/wide-events.md');
  });

  it('shows an empty state when no topic has a pending proposal', async () => {
    stubFetch({ list: { topics: [] } });
    await renderView();
    expect(container!.textContent).toMatch(/nenhuma proposta pendente/i);
    expect(container!.querySelector('select[name="topic"]')).toBeNull();
  });

  it('fills the proposal select from the chosen topic', async () => {
    stubFetch({
      list: {
        topics: [
          {
            slug: 'observability',
            title: 'Observability',
            proposals: [
              {
                id: 'proposal-observability-notes-3',
                agent: 'grok',
                createdAt: '2026-10-02T22:24:23.050Z',
              },
            ],
          },
          {
            slug: 'memory',
            title: 'Memory',
            proposals: [
              {
                id: 'proposal-memory-notes-1',
                agent: 'codex',
                createdAt: '2026-10-01T00:00:00.000Z',
              },
            ],
          },
        ],
      },
    });
    await renderView();
    const topic = container!.querySelector('select[name="topic"]') as HTMLSelectElement;
    expect([...topic.options].map((option) => option.value)).toEqual(['observability', 'memory']);
    await act(async () => {
      topic.value = 'memory';
      topic.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const proposal = container!.querySelector('select[name="proposal"]') as HTMLSelectElement;
    expect([...proposal.options].map((option) => option.value)).toEqual([
      'proposal-memory-notes-1',
    ]);
  });

  it('approves the wiki paths from the nested preview files', async () => {
    stubFetch({ list: pendingList, preview: nestedPreview });
    await renderView();
    await clickNamed('Abrir revisão');
    await clickNamed('Aprovar todos os arquivos');
    expect(fetches.find((item) => item.url.includes('/approve'))).toMatchObject({
      method: 'POST',
      body: {
        confirmation: 'proposal-observability-notes-3',
        paths: ['wiki/wide-events.md', 'wiki/canonical-log-lines.md'],
      },
    });
  });
});

function stubFetch(options: {
  readonly list?: unknown;
  readonly preview?: unknown;
  readonly previewError?: { readonly message: string };
}): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetches.push({
      url,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/api/v1/reviews') || url.endsWith('/api/v1/reviews/')) {
      return json(200, options.list ?? { topics: [] });
    }
    if (url.includes('/approve')) return json(200, { approved: true });
    if (url.includes('/api/v1/reviews/topic/')) {
      if (options.previewError) return json(400, options.previewError);
      return json(200, options.preview ?? {});
    }
    return json(404, { message: 'missing' });
  });
}

async function renderView(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ReviewView, { jobs: [] }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickNamed(text: string): Promise<void> {
  const node = [...container!.querySelectorAll('button, a, [role="button"]')].find((item) =>
    item.textContent?.includes(text),
  );
  expect(node, `clickable "${text}"`).toBeDefined();
  await act(async () => {
    (node as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}
