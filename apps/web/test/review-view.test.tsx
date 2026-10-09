/** @vitest-environment jsdom */

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ReviewView } from '../src/ReviewView.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const fetches: { url: string; method: string; body?: unknown }[] = [];

const wideEventsContent = `---
id: wide-events
title: Wide events
---
# Wide events

Proposed body from content.
`;

const nestedPreview = {
  proposalId: 'proposal-observability-notes-3',
  files: {
    proposalId: 'proposal-observability-notes-3',
    sources: [{ rawPath: 'raw/a/content.md', citation: 'Lines 1-4' }],
    claims: ['Wide events capture request context.'],
    contradictions: ['Sampling may drop rare events.'],
    confidence: 'high',
    files: [
      {
        path: 'wiki/wide-events.md',
        operation: 'create',
        changed: true,
        sources: ['raw/a/content.md'],
        content: wideEventsContent,
        diff: {
          text: [
            '--- a/wiki/wide-events.md',
            '+++ b/wiki/wide-events.md',
            '+id: wide-events',
            '+title: Wide events',
            '+# Wide events',
          ].join('\n'),
          addedLines: 3,
          removedLines: 0,
        },
      },
      {
        path: 'wiki/canonical-log-lines.md',
        operation: 'create',
        changed: true,
        sources: ['raw/b/content.md'],
        content: '# Canonical log lines\n',
        diff: {
          text: [
            '--- a/wiki/canonical-log-lines.md',
            '+++ b/wiki/canonical-log-lines.md',
            '+Canonical log lines',
          ].join('\n'),
          addedLines: 1,
          removedLines: 0,
        },
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
  it('lists pending proposals per topic and opens nested preview files', async () => {
    stubFetch({ list: pendingList, preview: nestedPreview });
    await renderView();

    expect(container!.querySelectorAll('[data-proposal-id]').length).toBeGreaterThan(0);
    expect(container!.textContent).toContain('Observability');
    expect(container!.textContent).toContain('proposal-observability-notes-3');
    expect(container!.querySelectorAll('select[name="topic"]').length).toBe(0);

    await clickNamed('Abrir revisão');
    expect(container!.textContent).toContain('wiki/wide-events.md');
    expect(container!.textContent).toContain('wiki/canonical-log-lines.md');
    expect(container!.querySelector('.card, .panel')).not.toBeNull();
  });

  it('renders the proposed wiki heading as html without yaml or unified-diff plus-lines as the page body', async () => {
    stubFetch({ list: pendingList, preview: nestedPreview });
    await renderView();
    await clickNamed('Abrir revisão');
    const body = container!.querySelector('.wiki-body');
    expect(body?.querySelector('h1, h2, h3')?.textContent).toMatch(/Wide events/i);
    expect(body?.textContent).toContain('Proposed body from content.');
    expect(body?.textContent).not.toContain('+id:');
    expect(body?.textContent).not.toContain('+title:');
    expect(body?.textContent).not.toMatch(/^id:/m);
    expect(body?.textContent).not.toMatch(/^title:/m);
  });

  it('renders the proposed body from file content not from diff text', async () => {
    stubFetch({
      list: pendingList,
      preview: {
        proposalId: 'proposal-observability-notes-3',
        files: {
          files: [
            {
              path: 'wiki/wide-events.md',
              operation: 'create',
              changed: true,
              sources: ['raw/a/content.md'],
              content: '# From content\n',
              diff: {
                text: '--- a/wiki/wide-events.md\n+++ b/wiki/wide-events.md\n+# From diff only\n',
                addedLines: 1,
                removedLines: 0,
              },
            },
          ],
        },
      },
    });
    await renderView();
    await clickNamed('Abrir revisão');
    const body = container!.querySelector('.wiki-body');
    expect(body?.querySelector('h1, h2, h3')?.textContent).toMatch(/From content/);
    expect(body?.textContent).not.toContain('From diff only');
  });

  it('shows delete copy and compact diff for a delete file', async () => {
    stubFetch({
      list: pendingList,
      preview: {
        proposalId: 'proposal-observability-notes-3',
        files: {
          files: [
            {
              path: 'wiki/gone.md',
              operation: 'delete',
              changed: true,
              sources: ['raw/a/content.md'],
              diff: {
                text: '--- a/wiki/gone.md\n+++ b/wiki/gone.md\n-# Gone\n',
                addedLines: 0,
                removedLines: 1,
              },
            },
          ],
        },
      },
    });
    await renderView();
    await clickNamed('Abrir revisão');
    expect(container!.textContent).toContain('Este caminho será removido.');
    expect(container!.querySelector('.wiki-body')).toBeNull();
    expect(container!.querySelector('.review-diff')).not.toBeNull();
    expect(container!.querySelector('.review-diff__line.is-remove')?.textContent).toContain(
      '# Gone',
    );
  });

  it('keeps a compact per-file diff with add and remove counts', async () => {
    stubFetch({ list: pendingList, preview: nestedPreview });
    await renderView();
    await clickNamed('Abrir revisão');
    const diff = container!.querySelector('.review-diff');
    expect(diff).not.toBeNull();
    expect(diff?.textContent).toMatch(/\+3/);
    expect(diff?.textContent).toMatch(/−0|-0/);
    expect(container!.querySelector('.review-diff__line.is-add')).not.toBeNull();
    expect(container!.textContent).not.toMatch(/^\s*--- a\/wiki\/wide-events\.md\s*$/m);
  });

  it('surfaces sources claims and contradictions with pt-BR labels', async () => {
    stubFetch({ list: pendingList, preview: nestedPreview });
    await renderView();
    await clickNamed('Abrir revisão');
    expect(container!.textContent).toContain('Fontes');
    expect(container!.textContent).toContain('raw/a/content.md');
    expect(container!.textContent).toContain('Afirmações');
    expect(container!.textContent).toContain('Wide events capture request context.');
    expect(container!.textContent).toContain('Contradições');
    expect(container!.textContent).toContain('Sampling may drop rare events.');
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

  it('fills the proposal list from the chosen topic', async () => {
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
    expect(container!.textContent).toContain('proposal-observability-notes-3');
    expect(container!.textContent).toContain('proposal-memory-notes-1');
    await clickNamed('proposal-memory-notes-1');
    const selected = container!.querySelector(
      '[data-proposal-id].is-active, [data-proposal-id][aria-current="true"]',
    );
    expect(selected?.getAttribute('data-proposal-id')).toBe('proposal-memory-notes-1');
  });

  it('approves the wiki paths from the nested preview files', async () => {
    stubFetch({ list: pendingList, preview: nestedPreview });
    await renderView();
    await clickNamed('Abrir revisão');
    expect(container!.textContent).toContain('proposal-observability-notes-3');
    await clickNamed('Aprovar');
    expect(fetches.find((item) => item.url.includes('/approve'))).toMatchObject({
      method: 'POST',
      body: {
        confirmation: 'proposal-observability-notes-3',
        paths: ['wiki/wide-events.md', 'wiki/canonical-log-lines.md'],
      },
    });
  });

  it('drops the approved proposal from the list, keeps the success banner, and notifies the parent', async () => {
    const onReviewsChanged = vi.fn();
    stubFetch({
      list: pendingList,
      preview: nestedPreview,
      listAfterDecide: { topics: [] },
    });
    await renderView(onReviewsChanged);
    await clickNamed('Abrir revisão');
    await clickNamed('Aprovar');
    expect(container!.textContent).toContain('Arquivos aprovados e promovidos para a wiki.');
    expect(container!.querySelector('[data-proposal-id]')).toBeNull();
    expect(onReviewsChanged).toHaveBeenCalled();
  });

  it('drops the rejected proposal from the list, keeps the rejected banner, and notifies the parent', async () => {
    const onReviewsChanged = vi.fn();
    stubFetch({
      list: pendingList,
      preview: nestedPreview,
      listAfterDecide: { topics: [] },
    });
    await renderView(onReviewsChanged);
    await clickNamed('Abrir revisão');
    const reason = container!.querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(reason, 'fora de escopo');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickNamed('Rejeitar');
    expect(container!.textContent).toContain('Proposta rejeitada.');
    expect(container!.querySelector('[data-proposal-id]')).toBeNull();
    expect(onReviewsChanged).toHaveBeenCalled();
  });

  it('shows empty pending copy and the success banner after the last proposal is decided', async () => {
    stubFetch({
      list: pendingList,
      preview: nestedPreview,
      listAfterDecide: { topics: [] },
    });
    await renderView();
    await clickNamed('Abrir revisão');
    await clickNamed('Aprovar');
    expect(container!.textContent).toMatch(/nenhuma proposta pendente neste vault/i);
    expect(container!.textContent).toContain('Arquivos aprovados e promovidos para a wiki.');
  });

  it('rejects with confirmation equal to the proposal id and a reason', async () => {
    stubFetch({ list: pendingList, preview: nestedPreview });
    await renderView();
    await clickNamed('Abrir revisão');
    const reason = container!.querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    expect(reason).toBeDefined();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(reason, 'fora de escopo');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickNamed('Rejeitar');
    expect(fetches.find((item) => item.url.includes('/reject'))).toMatchObject({
      method: 'POST',
      body: {
        confirmation: 'proposal-observability-notes-3',
        reason: 'fora de escopo',
      },
    });
  });
});

function stubFetch(options: {
  readonly list?: unknown;
  readonly preview?: unknown;
  readonly previewError?: { readonly message: string };
  readonly listAfterDecide?: unknown;
}): void {
  let decided = false;
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
    if (url.includes('/approve')) {
      decided = true;
      return json(200, { approved: true });
    }
    if (url.includes('/reject')) {
      decided = true;
      return json(200, { rejected: true });
    }
    if (url.endsWith('/api/v1/reviews') || url.endsWith('/api/v1/reviews/')) {
      if (decided && options.listAfterDecide !== undefined) {
        return json(200, options.listAfterDecide);
      }
      return json(200, options.list ?? { topics: [] });
    }
    if (url.includes('/api/v1/reviews/topic/')) {
      if (options.previewError) return json(400, options.previewError);
      return json(200, options.preview ?? {});
    }
    return json(404, { message: 'missing' });
  });
}

async function renderView(onReviewsChanged?: () => void): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ReviewView, { jobs: [], onReviewsChanged }));
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
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
  });
}
