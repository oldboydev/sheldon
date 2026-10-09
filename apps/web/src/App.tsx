import { FormEvent, useEffect, useState } from 'react';

import { client, type Dashboard, type Job } from './client.generated.js';
import { KnowledgeView } from './KnowledgeView.js';
import { ReviewView } from './ReviewView.js';
import './styles.css';

type AgentKind = 'codex' | 'claude' | 'grok';

type Section =
  'início' | 'fontes' | 'conhecimento' | 'revisão' | 'consulta' | 'bundles' | 'configurações';

const navGroups: readonly { readonly label: string; readonly items: readonly Section[] }[] = [
  { label: 'Bancada', items: ['início', 'fontes'] },
  { label: 'Vault', items: ['conhecimento', 'revisão', 'consulta'] },
  { label: 'Entrega', items: ['bundles'] },
  { label: 'Sistema', items: ['configurações'] },
];

const sectionLabel: Record<Section, string> = {
  início: 'Início',
  fontes: 'Fontes',
  conhecimento: 'Conhecimento',
  revisão: 'Revisão',
  consulta: 'Consulta',
  bundles: 'Bundles',
  configurações: 'Configurações',
};

const themeKey = 'sheldon-web-theme';

export function App() {
  const [section, setSection] = useState<Section>('início');
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [jobs, setJobs] = useState<readonly Job[]>([]);
  const [topics, setTopics] = useState<readonly { title: string; slug: string }[]>([]);
  const [projects, setProjects] = useState<readonly { title: string; slug: string }[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string>();
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof window !== 'undefined' && window.localStorage.getItem(themeKey) === 'dark'
      ? 'dark'
      : 'light',
  );

  const refresh = async () => {
    try {
      const [nextDashboard, nextJobs, nextTopics, nextProjects, reviews] = await Promise.all([
        client.dashboard(),
        client.jobs(),
        client.entities('topic') as Promise<{ title: string; slug: string }[]>,
        client.entities('project') as Promise<{ title: string; slug: string }[]>,
        fetch('/api/v1/reviews').then(async (response) => {
          const value = (await response.json()) as {
            topics?: readonly { proposals: readonly unknown[] }[];
          };
          return response.ok ? (value.topics ?? []) : [];
        }),
      ]);
      setDashboard(nextDashboard);
      setJobs(nextJobs.jobs);
      setTopics(nextTopics);
      setProjects(nextProjects);
      setPendingCount(reviews.reduce((total, topic) => total + topic.proposals.length, 0));
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível ler o vault local.');
    }
  };

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      window.localStorage.setItem(themeKey, 'dark');
      return;
    }
    document.documentElement.removeAttribute('data-theme');
    window.localStorage.removeItem(themeKey);
  }, [theme]);

  return (
    <div className="win">
      <header className="titlebar">
        <div className="titlebar__brand">
          <span className="titlebar__title" data-wordmark>
            Sheldon
          </span>
          <span className="titlebar__sep" />
          <span className="titlebar__meta">{dashboard?.path ?? '…'}</span>
        </div>
        <span className="titlebar__spacer" />
        <div className="titlebar__tools">
          <span className="badge badge--on-navy">neste computador</span>
          <button className="btn btn--ghost btn--sm" type="button" onClick={() => void refresh()}>
            Atualizar
          </button>
          <button
            className="icon-btn"
            type="button"
            data-theme-toggle
            aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            <ThemeIcon dark={theme === 'dark'} />
          </button>
        </div>
      </header>
      <div className="appbody">
        <aside className="sidebar">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="sidebar__label">{group.label}</p>
              <nav className="sidebar__nav" aria-label={group.label}>
                {group.items.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={section === item ? 'navitem is-active' : 'navitem'}
                    onClick={() => setSection(item)}
                  >
                    {sectionLabel[item]}
                    {item === 'revisão' && pendingCount > 0 && (
                      <span className="navitem__count">{pendingCount}</span>
                    )}
                  </button>
                ))}
              </nav>
            </div>
          ))}
          <div className="sidebar__foot">
            <span className="session__dot" aria-hidden="true" />
            somente neste computador
          </div>
        </aside>
        <section className="content">
          <div className="content__inner">
            {error && <div className="notice error">{error}</div>}
            {section === 'início' && (
              <DashboardView
                dashboard={dashboard}
                jobs={jobs}
                onNewSource={() => setSection('fontes')}
              />
            )}
            {section === 'fontes' && <SourceView topics={topics} onQueued={refresh} />}
            {section === 'conhecimento' && <KnowledgeView topics={topics} projects={projects} />}
            {section === 'revisão' && <ReviewView jobs={jobs} onReviewsChanged={refresh} />}
            {section === 'consulta' && <QueryView topics={topics} onQueued={refresh} />}
            {section === 'bundles' && <BundleView />}
            {section === 'configurações' && <SettingsView onQueued={refresh} />}
          </div>
        </section>
      </div>
    </div>
  );
}

function DashboardView({
  dashboard,
  jobs,
  onNewSource,
}: {
  readonly dashboard?: Dashboard;
  readonly jobs: readonly Job[];
  readonly onNewSource: () => void;
}) {
  return (
    <>
      <div className="title-row">
        <div>
          <p className="eyebrow">Situação atual</p>
          <h1>Fila e saúde do vault.</h1>
        </div>
        <Provenance />
      </div>
      <div className="tiles tiles--4">
        <Metric label="Na fila" value={dashboard?.jobs.queued ?? '—'} />
        <Metric label="Em execução" value={dashboard?.jobs.running ?? '—'} />
        <Metric label="Precisam de atenção" value={dashboard?.jobs.failed ?? '—'} tone="erro" />
        <Metric label="Vault" value={dashboard?.health.vault ? 'íntegro' : 'verificar'} />
      </div>
      <div className="split">
        <article className="panel">
          <p className="eyebrow">Atividade recente</p>
          <JobList jobs={jobs} />
        </article>
        <article className="panel">
          <p className="eyebrow">Próximo passo</p>
          <h2>Traga uma fonte.</h2>
          <p className="lede">
            Escolha um tópico, confira o plugin e inicie a captura. A revisão continua separada da
            wiki.
          </p>
          <button className="btn btn--primary" type="button" onClick={onNewSource}>
            Nova fonte
          </button>
        </article>
      </div>
    </>
  );
}

function SourceView({
  topics,
  onQueued,
}: {
  readonly topics: readonly { title: string; slug: string }[];
  readonly onQueued: () => Promise<void>;
}) {
  const [kind, setKind] = useState<'url' | 'file' | 'repository'>('url');
  const [slug, setSlug] = useState(topics[0]?.slug ?? '');
  const [value, setValue] = useState('');
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<{
    readonly plugin: string;
    readonly reason: string;
    readonly effects: { readonly ocr?: boolean; readonly stt?: boolean };
    readonly permissions: { readonly network?: boolean };
  }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!slug && topics[0]) setSlug(topics[0].slug);
  }, [topics, slug]);
  const capability =
    kind === 'url' ? 'ingest-url' : kind === 'file' ? 'ingest-file' : 'ingest-repository';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setPreview(undefined);
    try {
      const uploaded =
        kind === 'file' && file
          ? await (async () => {
              const body = new FormData();
              body.set('file', file);
              const response = await fetch('/api/v1/sources/upload', { method: 'POST', body });
              const result = (await response.json()) as { path?: string; message?: string };
              if (!response.ok || result.path === undefined)
                throw new Error(result.message ?? 'Não foi possível enviar o arquivo.');
              return result.path;
            })()
          : value;
      const probe = await fetch('/api/v1/sources/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: kind, value: uploaded }),
      });
      const result = (await probe.json()) as {
        plugin?: string;
        reason?: string;
        effects?: { ocr?: boolean; stt?: boolean };
        permissions?: { network?: boolean };
      };
      if (!probe.ok) throw new Error(result.reason ?? 'Nenhum plugin aceitou esta entrada.');
      setPreview({
        plugin: result.plugin ?? 'seleção pendente',
        reason: result.reason ?? capability,
        effects: result.effects ?? {},
        permissions: result.permissions ?? {},
      });
      const type =
        kind === 'url' ? 'ingest-url' : kind === 'file' ? 'ingest-file' : 'ingest-repository';
      await client.queueJob(
        type === 'ingest-url'
          ? { type, kind: 'topic', slug, url: value }
          : type === 'ingest-file'
            ? { type, kind: 'topic', slug, file: uploaded }
            : { type, kind: 'topic', slug, directory: value },
      );
      await onQueued();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page narrow">
      <p className="eyebrow">Nova fonte</p>
      <h1>Primeiro a origem, depois a síntese.</h1>
      <p className="lede">
        A seleção informa o que o plugin fará antes de a captura entrar na fila.
      </p>
      <form className="source-form" onSubmit={(event) => void submit(event)}>
        <label>
          Destino
          <select
            className="select"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            required
          >
            <option value="">Escolha um tópico</option>
            {topics.map((topic) => (
              <option key={topic.slug} value={topic.slug}>
                {topic.title}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Tipo de entrada</legend>
          {(['url', 'file', 'repository'] as const).map((item) => (
            <label className="choice" key={item}>
              <input type="radio" checked={kind === item} onChange={() => setKind(item)} />
              {item === 'url'
                ? 'Página ou vídeo'
                : item === 'file'
                  ? 'Arquivo local'
                  : 'Repositório local'}
            </label>
          ))}
        </fieldset>
        <label>
          {kind === 'url'
            ? 'URL pública'
            : kind === 'file'
              ? 'Caminho do arquivo'
              : 'Caminho do repositório'}
          <input
            className="input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            placeholder={kind === 'url' ? 'https://…' : 'C:\\…'}
          />
        </label>
        {kind === 'file' && (
          <label
            className="upload-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              setFile(event.dataTransfer.files.item(0) ?? undefined);
            }}
          >
            Arquivo para enviar
            <input
              type="file"
              onChange={(event) => setFile(event.target.files?.item(0) ?? undefined)}
            />
            <small>{file?.name ?? 'Arraste um arquivo ou escolha no computador.'}</small>
          </label>
        )}
        <button className="btn btn--primary primary" disabled={busy || !slug}>
          {busy ? 'Verificando…' : 'Verificar e iniciar'}
        </button>
      </form>
      {preview && (
        <div className="banner banner--info">
          <b>Plugin previsto</b>
          <p>
            {preview.plugin} — {preview.reason}
          </p>
          <div className="chip-row">
            {preview.effects.ocr ? <span className="chip chip--info">OCR</span> : null}
            {preview.effects.stt ? <span className="chip chip--info">STT</span> : null}
            {preview.permissions.network ? <span className="chip chip--ok">rede</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function QueryView({
  topics,
  onQueued,
}: {
  readonly topics: readonly { title: string; slug: string }[];
  readonly onQueued: () => Promise<void>;
}) {
  const [slug, setSlug] = useState(topics[0]?.slug ?? '');
  const [question, setQuestion] = useState('');
  const [agent, setAgent] = useState<AgentKind>('codex');
  const [message, setMessage] = useState<string>();
  return (
    <div className="page narrow">
      <p className="eyebrow">Consulta citada</p>
      <h1>Pergunte à wiki aprovada.</h1>
      <form
        className="source-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            await client.queueJob({
              type: 'query',
              kind: 'topic',
              slug,
              answerId: `resposta-${Date.now()}`,
              agent,
              question,
            });
            setMessage('Consulta adicionada à fila.');
            await onQueued();
          })();
        }}
      >
        <label>
          Tópico
          <select
            className="select"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            required
          >
            {topics.map((topic) => (
              <option key={topic.slug} value={topic.slug}>
                {topic.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Pergunta
          <input
            className="input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            required
          />
        </label>
        <label>
          Agente
          <select
            className="select"
            value={agent}
            onChange={(event) => setAgent(event.target.value as AgentKind)}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
            <option value="grok">Grok</option>
          </select>
        </label>
        <button className="btn btn--primary primary" disabled={!slug || !question.trim()}>
          Consultar com citações
        </button>
      </form>
      {message && <div className="notice">{message}</div>}
    </div>
  );
}

function BundleView() {
  const [bundleId, setBundleId] = useState('');
  const [concepts, setConcepts] = useState('');
  const [output, setOutput] = useState<string>();
  const [previewed, setPreviewed] = useState(false);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    await request('/bundles', {
      method: 'POST',
      body: {
        bundleId,
        concept: concepts
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      },
    });
    setPreviewed(false);
    setOutput(undefined);
  };
  const preview = async () => {
    setOutput(
      JSON.stringify(
        await request(`/bundles/${encodeURIComponent(bundleId)}/preview`, { method: 'POST' }),
        null,
        2,
      ),
    );
    setPreviewed(true);
  };
  const build = async () =>
    setOutput(
      JSON.stringify(
        await request(`/bundles/${encodeURIComponent(bundleId)}/build`, {
          method: 'POST',
          body: { confirmation: bundleId },
        }),
        null,
        2,
      ),
    );
  return (
    <div className="page narrow">
      <p className="eyebrow">Bundles OKF</p>
      <h1>Selecione, revise, gere.</h1>
      <form className="source-form" onSubmit={(event) => void create(event)}>
        <label>
          Identificador
          <input
            className="input"
            value={bundleId}
            onChange={(event) => setBundleId(event.target.value)}
            required
          />
        </label>
        <label>
          Concept IDs, separados por vírgula
          <input
            className="input"
            value={concepts}
            onChange={(event) => setConcepts(event.target.value)}
            required
          />
        </label>
        <button className="btn btn--primary primary">Criar definição</button>
      </form>
      <p className="review-actions">
        <button
          className="btn btn--secondary quiet"
          type="button"
          onClick={() => void preview()}
          disabled={!bundleId}
        >
          Ver prévia
        </button>
        <button
          className="btn btn--secondary quiet"
          type="button"
          onClick={() => void build()}
          disabled={!bundleId || !previewed}
        >
          Confirmar build
        </button>
      </p>
      {output && <pre className="panel output">{output}</pre>}
    </div>
  );
}

function SettingsView({ onQueued }: { readonly onQueued: () => Promise<void> }) {
  const [plugins, setPlugins] = useState<readonly { id: string; manifest?: { name: string } }[]>(
    [],
  );
  useEffect(() => {
    void fetch('/api/v1/plugins')
      .then((response) => response.json())
      .then(setPlugins);
  }, []);
  return (
    <div className="page">
      <p className="eyebrow">Configurações locais</p>
      <h1>Plugins e diagnósticos.</h1>
      <div className="panel">
        {plugins.length === 0 ? (
          <p>Nenhum plugin instalado.</p>
        ) : (
          plugins.map((plugin) => (
            <div className="job" key={plugin.id}>
              <b>{plugin.manifest?.name ?? plugin.id}</b>
              <button
                className="btn btn--secondary quiet btn--sm"
                type="button"
                onClick={() =>
                  void (async () => {
                    await client.queueJob({ type: 'plugin-health', pluginId: plugin.id });
                    await onQueued();
                  })()
                }
              >
                Executar diagnóstico
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

async function request(
  path: string,
  init: { readonly method: 'POST'; readonly body?: unknown },
): Promise<unknown> {
  const response = await fetch(`/api/v1${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? 'Ação local falhou.');
  return value;
}

function Metric({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly tone?: string;
}) {
  return (
    <div className={`tile ${tone ? `tile--${tone}` : ''}`}>
      <span className="tile__accent" />
      <span className="tile__label">{label}</span>
      <strong className="tile__value">{value}</strong>
    </div>
  );
}

function JobList({ jobs }: { readonly jobs: readonly Job[] }) {
  return (
    <div className="job-list">
      {jobs.length === 0 ? (
        <p className="muted">Ainda não há trabalhos registrados.</p>
      ) : (
        jobs.map((job) => (
          <div className="job" key={job.id}>
            <span className={`status ${job.status}`}>{job.status}</span>
            <b>{job.type}</b>
            <time>{new Date(job.createdAt).toLocaleString('pt-BR')}</time>
            {job.error && <small>{job.error}</small>}
          </div>
        ))
      )}
    </div>
  );
}

function Provenance() {
  return (
    <div className="provenance" aria-label="Fluxo de proveniência">
      <span>raw</span>
      <i>→</i>
      <span>proposta</span>
      <i>→</i>
      <span>conceito</span>
    </div>
  );
}

function ThemeIcon({ dark }: { readonly dark: boolean }) {
  return dark ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="currentColor" />
      <path
        d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 10.2A5.2 5.2 0 1 1 5.8 3 4.2 4.2 0 0 0 13 10.2z" fill="currentColor" />
    </svg>
  );
}
