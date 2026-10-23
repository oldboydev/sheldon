/** @vitest-environment jsdom */

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { App } from '../src/App.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const fetches: { url: string; method: string; body?: unknown }[] = [];

const dashboard = {
  path: 'C:\\knowledge\\sheldon',
  health: { vault: true, sqlite: true },
  jobs: { queued: 2, running: 1, failed: 3 },
  activity: [],
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
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
  window.sessionStorage.clear();
});

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('App shell', () => {
  it('wordmark is the text Sheldon', async () => {
    stubFetch();
    await renderApp();
    const wordmark = container!.querySelector('.titlebar__title, [data-wordmark]');
    expect(wordmark?.textContent?.trim()).toBe('Sheldon');
    expect(container!.textContent).not.toMatch(/SHELDON/);
    expect(container!.querySelector('.wordmark span')).toBeNull();
  });

  it('titlebar shows Sheldon vault path loopback pill refresh and theme toggle', async () => {
    stubFetch();
    await renderApp();
    expect(container!.querySelector('.win, .shell')?.className).toMatch(/win/);
    expect(container!.querySelector('.desktop')).toBeNull();
    expect(container!.textContent).toContain('Sheldon');
    expect(container!.textContent).toContain('C:\\knowledge\\sheldon');
    expect(container!.textContent).toContain('neste computador');
    expect(namedButton('Atualizar')).toBeDefined();
    expect(container!.querySelector('[data-theme-toggle]')).not.toBeNull();
  });

  it('sidebar groups the seven sections and shows the pending review count', async () => {
    stubFetch();
    await renderApp();
    expect(container!.textContent).toContain('Bancada');
    expect(container!.textContent).toContain('Vault');
    expect(container!.textContent).toContain('Entrega');
    expect(container!.textContent).toContain('Sistema');
    expect(namedButton('Início')).toBeDefined();
    expect(namedButton('Fontes')).toBeDefined();
    expect(namedButton('Conhecimento')).toBeDefined();
    expect(namedButton('Consulta')).toBeDefined();
    expect(namedButton('Bundles')).toBeDefined();
    expect(namedButton('Configurações')).toBeDefined();
    const review = namedButton('Revisão');
    expect(review?.textContent).toMatch(/2/);
    expect(container!.querySelector('.navitem.is-active')?.textContent).toMatch(/Início/i);
    expect(container!.textContent).toContain('somente neste computador');
  });

  it('inicio tiles bind dashboard jobs and vault health and nova fonte opens fontes', async () => {
    stubFetch();
    await renderApp();
    expect(container!.textContent).toContain('Fila e saúde do vault.');
    expect(container!.textContent).toContain('2');
    expect(container!.textContent).toContain('1');
    expect(container!.textContent).toContain('3');
    expect(container!.textContent).toMatch(/íntegro/i);
    expect(container!.textContent).toMatch(/raw\s*→\s*proposta\s*→\s*conceito/);
    await clickNamed('Nova fonte');
    expect(container!.querySelector('.navitem.is-active')?.textContent).toMatch(/Fontes/i);
    expect(container!.textContent).toMatch(/origem|fonte/i);
  });

  it('fontes renders ocr stt rede chips and one primary cta', async () => {
    stubFetch();
    await renderApp();
    await clickNamed('Fontes');
    const primaries = container!.querySelectorAll('.btn--primary, button.primary');
    expect(primaries.length).toBe(1);
    const topic = container!.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      topic.value = 'memory';
      topic.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const url = container!.querySelector('input[placeholder*="https"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(url, 'https://example.com');
    });
    await clickNamed('Verificar e iniciar');
    expect(container!.textContent).toContain('OCR');
    expect(container!.textContent).toContain('STT');
    expect(container!.textContent).toContain('rede');
    expect(container!.querySelectorAll('.chip').length).toBeGreaterThanOrEqual(3);
  });

  it('bundles hides json until preview', async () => {
    stubFetch();
    await renderApp();
    await clickNamed('Bundles');
    const id = container!.querySelector('input') as HTMLInputElement;
    const concepts = container!.querySelectorAll('input')[1] as HTMLInputElement;
    await act(async () => {
      setNativeValue(id, 'pack-1');
      setNativeValue(concepts, 'concept-1');
    });
    await clickNamed('Criar definição');
    expect(container!.textContent).not.toContain('"bundleId"');
    await clickNamed('Ver prévia');
    expect(container!.textContent).toContain('"bundleId"');
  });

  it('sidebar pending count drops after a successful approve without a full reload', async () => {
    stubFetch();
    await renderApp();
    const review = namedButton('Revisão');
    expect(review?.textContent).toMatch(/2/);
    await clickNamed('Revisão');
    await clickNamed('Abrir revisão');
    await clickNamed('Aprovar');
    expect(container!.textContent).toContain('Arquivos aprovados e promovidos para a wiki.');
    expect(namedButton('Revisão')?.querySelector('.navitem__count')).toBeNull();
  });

  it('consulta shows in-page queued status after submit', async () => {
    stubFetch();
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    await act(async () => {
      setNativeValue(question, 'o que e harness');
    });
    await clickNamed('Consultar com citações');
    expect(container!.textContent).toContain('Consulta na fila.');
    expect(container!.textContent).not.toContain('Consulta adicionada à fila.');
  });

  it('consulta shows cited answer when the query job succeeds', async () => {
    const stub = stubFetch();
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    await act(async () => {
      setNativeValue(question, 'What is recall?');
    });
    await clickNamed('Consultar com citações');
    const posted = fetches.find((item) => item.method === 'POST' && item.url.endsWith('/jobs'));
    const answerId = (posted?.body as { answerId?: string } | undefined)?.answerId;
    expect(answerId).toMatch(/^resposta-/);
    stub.jobs.splice(0, stub.jobs.length, {
      id: 'job-query',
      type: 'query',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
    });
    stub.answerId = answerId!;
    await clickNamed('Atualizar');
    expect(container!.textContent).toContain('What is recall?');
    expect(container!.textContent).toContain('Grok');
    expect(container!.textContent).toContain('wiki/recall.md');
    expect(container!.textContent).toContain('## Wiki facts');
  });

  it('consulta shows job error when the query fails', async () => {
    const stub = stubFetch();
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    await act(async () => {
      setNativeValue(question, 'o que e harness');
    });
    await clickNamed('Consultar com citações');
    stub.jobs.splice(0, stub.jobs.length, {
      id: 'job-query',
      type: 'query',
      status: 'failed',
      createdAt: new Date().toISOString(),
      error: 'The agent command did not produce a valid cited query answer.',
    });
    await clickNamed('Atualizar');
    const notice = container!.querySelector('.notice.error');
    expect(notice?.textContent).toContain('não devolveu uma resposta citada válida');
    expect(notice?.textContent).not.toContain(
      'The agent command did not produce a valid cited query answer.',
    );
  });

  it('consulta translates grok query-answer validation failure into Portuguese', async () => {
    const stub = stubFetch();
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    const agent = container!.querySelectorAll('select')[1] as HTMLSelectElement;
    await act(async () => {
      setNativeValue(question, 'o que e harness');
      agent.value = 'grok';
      agent.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await clickNamed('Consultar com citações');
    stub.jobs.splice(0, stub.jobs.length, {
      id: 'job-query',
      type: 'query',
      status: 'failed',
      createdAt: new Date().toISOString(),
      error:
        'Proposal is invalid: A query answer text must include an explicit Wiki facts section. A query answer text must include an explicit Inferences section. A query answer text must include an explicit Gaps section. Query answer concept wiki/harness-conceitos-determinismo.md is cited more than once.',
    });
    await clickNamed('Atualizar');
    const notice = container!.querySelector('.notice.error');
    expect(notice?.textContent).toContain('Sheldon não gravou a resposta');
    expect(notice?.textContent).toContain('## Wiki facts');
    expect(notice?.textContent).toContain('Tente de novo');
    expect(notice?.textContent).not.toContain('Proposal is invalid');
  });

  it('consulta translates evidence-outside-context failure into Portuguese', async () => {
    const stub = stubFetch();
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    const agent = container!.querySelectorAll('select')[1] as HTMLSelectElement;
    await act(async () => {
      setNativeValue(question, 'o que e harness');
      agent.value = 'grok';
      agent.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await clickNamed('Consultar com citações');
    stub.jobs.splice(0, stub.jobs.length, {
      id: 'job-query',
      type: 'query',
      status: 'failed',
      createdAt: new Date().toISOString(),
      error: 'The query answer cites concept evidence outside its context: wiki/unselected.md.',
    });
    await clickNamed('Atualizar');
    const outside = container!.querySelector('.notice.error');
    expect(outside?.textContent).toContain('Sheldon não gravou a resposta');
    expect(outside?.textContent).toContain('Tente de novo');
    expect(outside?.textContent).not.toContain('outside its context');
    stub.jobs.splice(0, stub.jobs.length, {
      id: 'job-query',
      type: 'query',
      status: 'failed',
      createdAt: new Date().toISOString(),
      error: 'The query answer omits citations for the selected wiki context.',
    });
    await clickNamed('Atualizar');
    const omitted = container!.querySelector('.notice.error');
    expect(omitted?.textContent).toContain('Sheldon não gravou a resposta');
    expect(omitted?.textContent).not.toContain('omits citations');
    stub.jobs.splice(0, stub.jobs.length, {
      id: 'job-query',
      type: 'query',
      status: 'failed',
      createdAt: new Date().toISOString(),
      error: 'Proposal is invalid: A query answer must include concept citations.',
    });
    await clickNamed('Atualizar');
    const missingConcepts = container!.querySelector('.notice.error');
    expect(missingConcepts?.textContent).toContain('Sheldon não gravou a resposta');
    expect(missingConcepts?.textContent).toContain('Tente de novo');
    expect(missingConcepts?.textContent).not.toContain('Proposal is invalid');
    expect(missingConcepts?.textContent).not.toContain('must include concept citations');
  });

  it('consulta restores the last cited answer from sessionStorage', async () => {
    window.sessionStorage.setItem(
      'sheldon-web-last-query',
      JSON.stringify({
        jobId: 'job-query',
        answerId: 'answer-001',
        kind: 'topic',
        slug: 'memory',
        question: 'What is recall?',
        agent: 'grok',
      }),
    );
    const stub = stubFetch();
    stub.jobs.push({
      id: 'job-query',
      type: 'query',
      status: 'succeeded',
      createdAt: '2026-10-09T12:00:00.000Z',
    });
    stub.answerId = 'answer-001';
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    const agent = container!.querySelectorAll('select')[1] as HTMLSelectElement;
    expect(question.value).toBe('What is recall?');
    expect(agent.value).toBe('grok');
    expect(container!.textContent).toContain('## Wiki facts');
    expect(container!.textContent).toContain('wiki/recall.md');
    expect(fetches.some((item) => item.method === 'POST' && item.url.endsWith('/jobs'))).toBe(
      false,
    );
  });

  it('refresh shows the API problem message instead of the generic vault fallback', async () => {
    const stub = stubFetch();
    stub.dashboardError = {
      message: 'O vault configurado não existe.',
      code: 'VAULT_NOT_FOUND',
    };
    await renderApp();
    expect(container!.querySelector('.notice.error')?.textContent).toContain(
      'O vault configurado não existe.',
    );
    expect(container!.textContent).not.toContain('Não foi possível ler o vault local.');
  });

  it('consulta submit shows an error notice without clearing the question', async () => {
    const stub = stubFetch();
    stub.jobsPostError = {
      message: 'O tópico pedido não existe.',
      code: 'WEB_JOB_INVALID',
    };
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    await act(async () => {
      setNativeValue(question, 'o que e harness');
    });
    await clickNamed('Consultar com citações');
    expect(question.value).toBe('o que e harness');
    expect(container!.querySelector('.notice.error')?.textContent).toContain(
      'O tópico pedido não existe.',
    );
  });

  it('fontes submit shows an error notice without clearing the input', async () => {
    const stub = stubFetch();
    stub.jobsPostError = { message: 'Nenhum plugin aceitou esta entrada.' };
    await renderApp();
    await clickNamed('Fontes');
    const url = container!.querySelector('input[placeholder*="https"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(url, 'https://example.com');
    });
    await clickNamed('Verificar e iniciar');
    expect(url.value).toBe('https://example.com');
    expect(container!.querySelector('.notice.error')?.textContent).toContain(
      'Nenhum plugin aceitou esta entrada.',
    );
  });

  it('bundles submit shows an error notice without clearing the identifier', async () => {
    const stub = stubFetch();
    stub.bundlesError = { message: 'O identificador do bundle é inválido.' };
    await renderApp();
    await clickNamed('Bundles');
    const inputs = container!.querySelectorAll('input.input');
    await act(async () => {
      setNativeValue(inputs[0] as HTMLInputElement, 'pack-1');
      setNativeValue(inputs[1] as HTMLInputElement, 'concept-1');
    });
    await clickNamed('Criar definição');
    expect((inputs[0] as HTMLInputElement).value).toBe('pack-1');
    expect(container!.querySelector('.notice.error')?.textContent).toContain(
      'O identificador do bundle é inválido.',
    );
  });

  it('consulta shows a Portuguese notice for an interrupted job', async () => {
    window.sessionStorage.setItem(
      'sheldon-web-last-query',
      JSON.stringify({
        jobId: 'job-query',
        answerId: 'answer-001',
        kind: 'topic',
        slug: 'memory',
        question: 'What is recall?',
        agent: 'grok',
      }),
    );
    const stub = stubFetch();
    stub.jobs.push({
      id: 'job-query',
      type: 'query',
      status: 'interrupted',
      createdAt: '2026-10-09T12:00:00.000Z',
    });
    await renderApp();
    await clickNamed('Consulta');
    expect(container!.querySelector('.notice.error')?.textContent).toContain('interrompida');
    expect(container!.textContent).not.toContain('Consulta na fila.');
  });

  it('consulta shows a Portuguese notice for a cancelled job', async () => {
    window.sessionStorage.setItem(
      'sheldon-web-last-query',
      JSON.stringify({
        jobId: 'job-query',
        answerId: 'answer-001',
        kind: 'topic',
        slug: 'memory',
        question: 'What is recall?',
        agent: 'grok',
      }),
    );
    const stub = stubFetch();
    stub.jobs.push({
      id: 'job-query',
      type: 'query',
      status: 'cancelled',
      createdAt: '2026-10-09T12:00:00.000Z',
    });
    await renderApp();
    await clickNamed('Consulta');
    expect(container!.querySelector('.notice.error')?.textContent).toContain('cancelada');
    expect(container!.textContent).not.toContain('Consulta na fila.');
  });

  it('consulta shows a stored answer when the tracked job is missing from the jobs page', async () => {
    window.sessionStorage.setItem(
      'sheldon-web-last-query',
      JSON.stringify({
        jobId: 'job-query',
        answerId: 'answer-001',
        kind: 'topic',
        slug: 'memory',
        question: 'What is recall?',
        agent: 'grok',
      }),
    );
    stubFetch();
    await renderApp();
    await clickNamed('Consulta');
    expect(container!.textContent).toContain('## Wiki facts');
    expect(container!.textContent).toContain('wiki/recall.md');
    expect(container!.textContent).not.toContain('Consulta na fila.');
  });

  it('consulta keeps a visible answer when the answer GET fails', async () => {
    window.sessionStorage.setItem(
      'sheldon-web-last-query',
      JSON.stringify({
        jobId: 'job-query',
        answerId: 'answer-001',
        kind: 'topic',
        slug: 'memory',
        question: 'What is recall?',
        agent: 'grok',
      }),
    );
    const stub = stubFetch();
    stub.jobs.push({
      id: 'job-query',
      type: 'query',
      status: 'succeeded',
      createdAt: '2026-10-09T12:00:00.000Z',
    });
    await renderApp();
    await clickNamed('Consulta');
    expect(container!.textContent).toContain('## Wiki facts');
    stub.answerFail = true;
    await clickNamed('Atualizar');
    expect(container!.textContent).toContain('## Wiki facts');
    expect(container!.querySelector('.notice.error')?.textContent).toContain(
      'Resposta não encontrada',
    );
    expect(container!.textContent).not.toContain('Consulta na fila.');
  });

  it('consulta shows a stored answer when the interrupted job already wrote answer.json', async () => {
    window.sessionStorage.setItem(
      'sheldon-web-last-query',
      JSON.stringify({
        jobId: 'job-query',
        answerId: 'answer-001',
        kind: 'topic',
        slug: 'memory',
        question: 'What is recall?',
        agent: 'grok',
      }),
    );
    const stub = stubFetch();
    stub.jobs.push({
      id: 'job-query',
      type: 'query',
      status: 'interrupted',
      createdAt: '2026-10-09T12:00:00.000Z',
    });
    stub.answerId = 'answer-001';
    await renderApp();
    await clickNamed('Consulta');
    expect(container!.textContent).toContain('## Wiki facts');
    expect(container!.querySelector('.notice.error')?.textContent).toContain('interrompida');
    expect(container!.textContent).not.toContain('Consulta na fila.');
  });

  it('consulta submit of a second query does not show a missing-answer error while queued', async () => {
    const stub = stubFetch();
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    await act(async () => {
      setNativeValue(question, 'What is recall?');
    });
    await clickNamed('Consultar com citações');
    const posted = fetches.find((item) => item.method === 'POST' && item.url.endsWith('/jobs'));
    const firstAnswerId = (posted?.body as { answerId?: string } | undefined)?.answerId;
    stub.jobs.splice(0, stub.jobs.length, {
      id: 'job-query',
      type: 'query',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
    });
    stub.answerId = firstAnswerId!;
    await clickNamed('Atualizar');
    expect(container!.textContent).toContain('## Wiki facts');
    stub.nextQueryJobId = 'job-query-b';
    await act(async () => {
      setNativeValue(question, 'o que e harness');
    });
    await clickNamed('Consultar com citações');
    expect(container!.textContent).toContain('Consulta na fila.');
    expect(container!.textContent).not.toContain('## Wiki facts');
    expect(container!.querySelector('.notice.error')).toBeNull();
    expect(container!.textContent).not.toContain('Resposta não encontrada');
  });

  it('consulta submit shows a Portuguese notice when fetch fails', async () => {
    const stub = stubFetch();
    stub.fetchReject = new TypeError('Failed to fetch');
    await renderApp();
    await clickNamed('Consulta');
    const question = container!.querySelector('input.input') as HTMLInputElement;
    await act(async () => {
      setNativeValue(question, 'o que e harness');
    });
    await clickNamed('Consultar com citações');
    expect(question.value).toBe('o que e harness');
    expect(container!.querySelector('.notice.error')?.textContent).toContain(
      'Não foi possível iniciar a consulta.',
    );
    expect(container!.textContent).not.toContain('Failed to fetch');
  });

  it('fontes file drop submits without a path', async () => {
    stubFetch();
    await renderApp();
    await clickNamed('Fontes');
    await chooseSourceKind('Arquivo local');
    await attachLocalFile('notes.pdf');
    const path = container!.querySelector('input.input') as HTMLInputElement;
    expect(path.value).toBe('');
    expect(path.required).toBe(false);
    await clickNamed('Verificar e iniciar');
    expect(
      fetches.some((item) => item.method === 'POST' && item.url.endsWith('/sources/upload')),
    ).toBe(true);
    expect(fetches.some((item) => item.method === 'POST' && item.url.endsWith('/jobs'))).toBe(true);
  });

  it('fontes file path submits without a dropped file', async () => {
    stubFetch();
    await renderApp();
    await clickNamed('Fontes');
    await chooseSourceKind('Arquivo local');
    const path = container!.querySelector('input.input') as HTMLInputElement;
    await act(async () => {
      setNativeValue(path, 'C:\\vaults\\notes.pdf');
    });
    await clickNamed('Verificar e iniciar');
    expect(fetches.some((item) => item.method === 'POST' && item.url.endsWith('/jobs'))).toBe(true);
  });

  it('fontes url and repository inputs stay required', async () => {
    stubFetch();
    await renderApp();
    await clickNamed('Fontes');
    const path = container!.querySelector('input.input') as HTMLInputElement;
    expect(path.required).toBe(true);
    await chooseSourceKind('Repositório local');
    expect(path.required).toBe(true);
    await chooseSourceKind('Página ou vídeo');
    expect(path.required).toBe(true);
  });

  it('chrome has no milestone leak and theme toggle sets data-theme dark', async () => {
    stubFetch();
    await renderApp();
    expect(container!.textContent).not.toContain('M7');
    expect(container!.innerHTML).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    const toggle = container!.querySelector('[data-theme-toggle]') as HTMLElement;
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

function stubFetch(): {
  jobs: {
    id: string;
    type: string;
    status: string;
    createdAt: string;
    error?: string;
  }[];
  answerId: string;
  dashboardError?: { message: string; code: string };
  jobsPostError?: { message: string; code?: string };
  answerFail?: boolean;
  bundlesError?: { message: string };
  nextQueryJobId?: string;
  fetchReject?: Error;
} {
  let reviewsDecided = false;
  const stub = {
    jobs: [] as {
      id: string;
      type: string;
      status: string;
      createdAt: string;
      error?: string;
    }[],
    answerId: 'answer-001',
    dashboardError: undefined as { message: string; code: string } | undefined,
    jobsPostError: undefined as { message: string; code?: string } | undefined,
    answerFail: false,
    bundlesError: undefined as { message: string } | undefined,
    nextQueryJobId: undefined as string | undefined,
    fetchReject: undefined as Error | undefined,
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetches.push({
      url,
      method,
      ...(init?.body === undefined ||
      (typeof FormData !== 'undefined' && init.body instanceof FormData)
        ? {}
        : { body: JSON.parse(String(init.body)) as unknown }),
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/api/v1/dashboard')) {
      if (stub.dashboardError !== undefined) return json(400, stub.dashboardError);
      return json(200, dashboard);
    }
    if (url.endsWith('/api/v1/jobs') && method === 'POST') {
      if (stub.fetchReject !== undefined) throw stub.fetchReject;
      if (stub.jobsPostError !== undefined) return json(400, stub.jobsPostError);
      const body =
        init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as { type?: string });
      if (body?.type === 'query') {
        const job = {
          id: stub.nextQueryJobId ?? 'job-query',
          type: 'query',
          status: 'queued',
          createdAt: new Date().toISOString(),
        };
        stub.nextQueryJobId = undefined;
        stub.jobs.splice(0, stub.jobs.length, job);
        return json(202, job);
      }
      const ingest = {
        id: 'job-1',
        type: 'ingest-url',
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      stub.jobs.push(ingest);
      return json(202, ingest);
    }
    const jobMatch = url.match(/\/api\/v1\/jobs\/([^/?]+)$/);
    if (jobMatch !== null && method === 'GET') {
      const found = stub.jobs.find((item) => item.id === decodeURIComponent(jobMatch[1]!));
      if (found === undefined) {
        return json(404, { message: 'Trabalho não encontrado.', code: 'WEB_NOT_FOUND' });
      }
      return json(200, found);
    }
    if (url.includes('/answers/')) {
      const requested = decodeURIComponent(url.split('/answers/')[1]?.split(/[/?]/)[0] ?? '');
      if (stub.answerFail || requested !== stub.answerId) {
        return json(404, { message: 'Resposta não encontrada.', code: 'WEB_NOT_FOUND' });
      }
      return json(200, {
        schemaVersion: 1,
        id: stub.answerId,
        question: 'What is recall?',
        agent: 'grok',
        concepts: [{ path: 'wiki/recall.md', citation: 'Active recall is documented.' }],
        raws: [],
        createdAt: '2026-10-09T12:00:00.000Z',
        truncated: false,
        text: [
          '## Wiki facts',
          '- Retrieval practice is documented in wiki/recall.md.',
          '',
          '## Inferences',
          '- None.',
          '',
          '## Gaps',
          '- None.',
        ].join('\n'),
      });
    }
    if (url.endsWith('/api/v1/jobs')) return json(200, { jobs: stub.jobs });
    if (url.endsWith('/api/v1/entities/topic'))
      return json(200, [{ title: 'Memory', slug: 'memory' }]);
    if (url.endsWith('/api/v1/entities/project')) return json(200, []);
    if (url.includes('/approve')) {
      reviewsDecided = true;
      return json(200, { approved: true });
    }
    if (url.includes('/api/v1/reviews/topic/')) {
      return json(200, {
        files: {
          files: [
            {
              path: 'wiki/wide-events.md',
              operation: 'create',
              content: '# Wide events\n',
              diff: { text: '+# Wide events', addedLines: 1, removedLines: 0 },
            },
          ],
        },
      });
    }
    if (url.endsWith('/api/v1/reviews') || url.endsWith('/api/v1/reviews/')) {
      if (reviewsDecided) return json(200, { topics: [] });
      return json(200, {
        topics: [
          {
            slug: 'observability',
            title: 'Observability',
            proposals: [
              { id: 'proposal-a', agent: 'grok', createdAt: '2026-10-02T00:00:00.000Z' },
              { id: 'proposal-b', agent: 'codex', createdAt: '2026-10-02T00:00:00.000Z' },
            ],
          },
        ],
      });
    }
    if (url.endsWith('/api/v1/plugins')) return json(200, []);
    if (url.endsWith('/api/v1/sources/upload')) {
      return json(200, { path: 'C:\\tmp\\notes.pdf', originalName: 'notes.pdf', bytes: 1 });
    }
    if (url.endsWith('/api/v1/sources/probe')) {
      return json(200, {
        plugin: 'source.url',
        reason: 'url pública',
        effects: { ocr: true, stt: true, modelDownload: false },
        permissions: { network: true, cookies: false },
      });
    }
    if (url.endsWith('/api/v1/bundles') && method === 'POST') {
      if (stub.bundlesError !== undefined) return json(400, stub.bundlesError);
      return json(200, { bundleId: 'pack-1', concept: ['concept-1'] });
    }
    if (url.includes('/preview')) {
      return json(200, { bundleId: 'pack-1', files: [] });
    }
    return json(404, { message: 'missing' });
  });
  return stub;
}

async function renderApp(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function namedButton(text: string): HTMLElement | undefined {
  return [...container!.querySelectorAll('button, a, [role="button"]')].find((item) =>
    item.textContent?.includes(text),
  ) as HTMLElement | undefined;
}

function setNativeValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function chooseSourceKind(label: string): Promise<void> {
  const choice = [...container!.querySelectorAll('label.choice')].find((item) =>
    item.textContent?.includes(label),
  ) as HTMLElement | undefined;
  expect(choice, `source kind "${label}"`).toBeDefined();
  const radio = choice!.querySelector('input[type="radio"]') as HTMLInputElement;
  await act(async () => {
    radio.click();
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function attachLocalFile(name: string): Promise<void> {
  const picker = container!.querySelector('input[type="file"]') as HTMLInputElement;
  expect(picker).toBeDefined();
  const file = new File(['pdf'], name, { type: 'application/pdf' });
  const list = {
    0: file,
    length: 1,
    item: (index: number) => (index === 0 ? file : null),
  };
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: list });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function clickNamed(text: string): Promise<void> {
  const node = namedButton(text);
  expect(node, `clickable "${text}"`).toBeDefined();
  await act(async () => {
    (node as HTMLElement).click();
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
  });
}
