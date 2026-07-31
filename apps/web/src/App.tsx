import { FormEvent, useEffect, useMemo, useState } from 'react';

import { client, type Dashboard, type Job } from './client.generated.js';
import './styles.css';

type Section =
  'início' | 'fontes' | 'conhecimento' | 'revisão' | 'consulta' | 'bundles' | 'configurações';

const sections: readonly Section[] = [
  'início',
  'fontes',
  'conhecimento',
  'revisão',
  'consulta',
  'bundles',
  'configurações',
];

export function App() {
  const [section, setSection] = useState<Section>('início');
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [jobs, setJobs] = useState<readonly Job[]>([]);
  const [topics, setTopics] = useState<readonly { title: string; slug: string }[]>([]);
  const [error, setError] = useState<string>();

  const refresh = async () => {
    try {
      const [nextDashboard, nextJobs, nextTopics] = await Promise.all([
        client.dashboard(),
        client.jobs(),
        client.entities('topic') as Promise<{ title: string; slug: string }[]>,
      ]);
      setDashboard(nextDashboard);
      setJobs(nextJobs.jobs);
      setTopics(nextTopics);
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

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="wordmark">
          <span>S</span> SHELDON
        </div>
        <p className="rail-caption">bancada local de conhecimento</p>
        <nav aria-label="Navegação principal">
          {sections.map((item) => (
            <button
              key={item}
              className={section === item ? 'nav-item active' : 'nav-item'}
              onClick={() => setSection(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="loopback">● somente neste computador</div>
      </aside>
      <section className="workspace">
        <header>
          <p>VAULT LOCAL / M7</p>
          <button className="quiet" onClick={() => void refresh()}>
            Atualizar
          </button>
        </header>
        {error && <div className="notice error">{error}</div>}
        {section === 'início' && <DashboardView dashboard={dashboard} jobs={jobs} />}
        {section === 'fontes' && <SourceView topics={topics} onQueued={refresh} />}
        {section === 'conhecimento' && <KnowledgeView topics={topics} />}
        {section === 'revisão' && <ReviewView jobs={jobs} />}
        {section === 'consulta' && <QueryView topics={topics} onQueued={refresh} />}
        {section === 'bundles' && <BundleView />}
        {section === 'configurações' && <SettingsView onQueued={refresh} />}
      </section>
    </main>
  );
}

function DashboardView({
  dashboard,
  jobs,
}: {
  readonly dashboard?: Dashboard;
  readonly jobs: readonly Job[];
}) {
  return (
    <>
      <div className="title-row">
        <div>
          <p className="eyebrow">SITUAÇÃO ATUAL</p>
          <h1>Conhecimento em movimento.</h1>
        </div>
        <Provenance />
      </div>
      <div className="metrics">
        <Metric label="na fila" value={dashboard?.jobs.queued ?? '—'} />
        <Metric label="em execução" value={dashboard?.jobs.running ?? '—'} />
        <Metric label="precisam de atenção" value={dashboard?.jobs.failed ?? '—'} tone="alert" />
        <Metric label="vault" value={dashboard?.health.vault ? 'íntegro' : 'verificar'} />
      </div>
      <div className="split">
        <article className="panel">
          <p className="eyebrow">ATIVIDADE RECENTE</p>
          <JobList jobs={jobs} />
        </article>
        <article className="panel note">
          <p className="eyebrow">PRÓXIMO PASSO</p>
          <h2>Traga uma fonte.</h2>
          <p>
            Escolha um tópico, confira o plugin e inicie a captura. A revisão continua separada da
            wiki.
          </p>
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
  const [preview, setPreview] = useState<string>();
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
        effects?: Record<string, boolean>;
        permissions?: Record<string, boolean>;
      };
      if (!probe.ok) throw new Error(result.reason ?? 'Nenhum plugin aceitou esta entrada.');
      setPreview(`${result.plugin ?? 'seleção pendente'} — ${result.reason ?? capability}`);
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
      <p className="eyebrow">NOVA FONTE</p>
      <h1>Primeiro a origem, depois a síntese.</h1>
      <p className="lede">
        A seleção informa o que o plugin fará antes de a captura entrar na fila.
      </p>
      <form className="source-form" onSubmit={(event) => void submit(event)}>
        <label>
          Destino
          <select value={slug} onChange={(event) => setSlug(event.target.value)} required>
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
        <button className="primary" disabled={busy || !slug}>
          {busy ? 'Verificando…' : 'Verificar e iniciar'}
        </button>
      </form>
      {preview && (
        <div className="notice">
          <b>Plugin previsto</b>
          <br />
          {preview}
          <br />
          <small>Revise rede, cookies, OCR, STT e downloads de modelo na tela de plugins.</small>
        </div>
      )}
    </div>
  );
}

function KnowledgeView({
  topics,
}: {
  readonly topics: readonly { title: string; slug: string }[];
}) {
  return (
    <div className="page">
      <p className="eyebrow">CONHECIMENTO APROVADO</p>
      <h1>Uma árvore que mostra a origem.</h1>
      <div className="tree panel">
        {topics.length === 0 ? (
          <p>Nenhum tópico ainda. Crie um tópico antes de ingerir uma fonte.</p>
        ) : (
          topics.map((topic) => (
            <div key={topic.slug}>
              <b>{topic.title}</b>
              <span> wiki / raws / propostas</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ReviewView({ jobs }: { readonly jobs: readonly Job[] }) {
  const candidates = useMemo(
    () => jobs.filter((job) => job.type === 'compile' || job.type === 'query'),
    [jobs],
  );
  const [slug, setSlug] = useState('');
  const [proposalId, setProposalId] = useState('');
  const [preview, setPreview] = useState<{
    files?: readonly { path: string; diff?: { text: string } }[];
  }>();
  const [message, setMessage] = useState<string>();
  const load = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch(
      `/api/v1/reviews/topic/${encodeURIComponent(slug)}/${encodeURIComponent(proposalId)}`,
    );
    const value = (await response.json()) as {
      files?: readonly { path: string; diff?: { text: string } }[];
      message?: string;
    };
    if (!response.ok) throw new Error(value.message);
    setPreview(value);
  };
  const approve = async () => {
    if (!preview?.files) return;
    await request(
      `/reviews/topic/${encodeURIComponent(slug)}/${encodeURIComponent(proposalId)}/approve`,
      {
        method: 'POST',
        body: { confirmation: proposalId, paths: preview.files.map((file) => file.path) },
      },
    );
    setMessage('Arquivos aprovados e promovidos para a wiki.');
  };
  return (
    <div className="page">
      <p className="eyebrow">REVISÃO HUMANA</p>
      <h1>Nada entra na wiki por acaso.</h1>
      <form className="source-form" onSubmit={(event) => void load(event)}>
        <label>
          Tópico
          <input value={slug} onChange={(event) => setSlug(event.target.value)} required />
        </label>
        <label>
          Proposta
          <input
            value={proposalId}
            onChange={(event) => setProposalId(event.target.value)}
            required
          />
        </label>
        <button className="primary">Abrir revisão</button>
      </form>
      {preview?.files?.map((file) => (
        <article className="panel" key={file.path}>
          <b>{file.path}</b>
          <pre className="output">{file.diff?.text}</pre>
        </article>
      ))}
      {preview?.files && (
        <button className="primary" onClick={() => void approve()}>
          Aprovar todos os arquivos
        </button>
      )}
      {message && <div className="notice">{message}</div>}
      <div className="panel">
        <p>Trabalhos que podem gerar propostas:</p>
        <JobList jobs={candidates} />
      </div>
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
  const [agent, setAgent] = useState<'codex' | 'claude'>('codex');
  const [message, setMessage] = useState<string>();
  return (
    <div className="page narrow">
      <p className="eyebrow">CONSULTA CITADA</p>
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
          <select value={slug} onChange={(event) => setSlug(event.target.value)} required>
            {topics.map((topic) => (
              <option key={topic.slug} value={topic.slug}>
                {topic.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Pergunta
          <input value={question} onChange={(event) => setQuestion(event.target.value)} required />
        </label>
        <label>
          Agente
          <select
            value={agent}
            onChange={(event) => setAgent(event.target.value as 'codex' | 'claude')}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <button className="primary" disabled={!slug || !question.trim()}>
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
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const response = await request('/bundles', {
      method: 'POST',
      body: {
        bundleId,
        concept: concepts
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      },
    });
    setOutput(JSON.stringify(response, null, 2));
  };
  const preview = async () =>
    setOutput(
      JSON.stringify(
        await request(`/bundles/${encodeURIComponent(bundleId)}/preview`, { method: 'POST' }),
        null,
        2,
      ),
    );
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
      <p className="eyebrow">BUNDLES OKF</p>
      <h1>Selecione, revise, gere.</h1>
      <form className="source-form" onSubmit={(event) => void create(event)}>
        <label>
          Identificador
          <input value={bundleId} onChange={(event) => setBundleId(event.target.value)} required />
        </label>
        <label>
          Concept IDs, separados por vírgula
          <input value={concepts} onChange={(event) => setConcepts(event.target.value)} required />
        </label>
        <button className="primary">Criar definição</button>
      </form>
      <p>
        <button className="quiet" onClick={() => void preview()} disabled={!bundleId}>
          Ver prévia
        </button>
        <button className="quiet" onClick={() => void build()} disabled={!bundleId}>
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
      <p className="eyebrow">CONFIGURAÇÕES LOCAIS</p>
      <h1>Plugins e diagnósticos.</h1>
      <div className="panel">
        {plugins.length === 0 ? (
          <p>Nenhum plugin instalado.</p>
        ) : (
          plugins.map((plugin) => (
            <div className="job" key={plugin.id}>
              <b>{plugin.manifest?.name ?? plugin.id}</b>
              <button
                className="quiet"
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
    <div className={`metric ${tone ?? ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
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
