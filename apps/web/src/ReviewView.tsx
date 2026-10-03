import { FormEvent, useEffect, useMemo, useState } from 'react';

import type { Job } from './client.generated.js';

interface PendingProposal {
  readonly id: string;
  readonly agent: string;
  readonly createdAt: string;
}

interface PendingTopic {
  readonly slug: string;
  readonly title: string;
  readonly proposals: readonly PendingProposal[];
}

interface PreviewFile {
  readonly path: string;
  readonly diff?: { readonly text: string };
}

export function ReviewView({ jobs }: { readonly jobs: readonly Job[] }) {
  const candidates = useMemo(
    () => jobs.filter((job) => job.type === 'compile' || job.type === 'query'),
    [jobs],
  );
  const [topics, setTopics] = useState<readonly PendingTopic[]>([]);
  const [slug, setSlug] = useState('');
  const [proposalId, setProposalId] = useState('');
  const [preview, setPreview] = useState<readonly PreviewFile[]>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/v1/reviews');
        const value = (await response.json()) as {
          topics?: readonly PendingTopic[];
          message?: string;
        };
        if (!response.ok) {
          setMessage(value.message ?? 'Não foi possível listar as propostas pendentes.');
          return;
        }
        const next = value.topics ?? [];
        setTopics(next);
        const first = next[0];
        if (first) {
          setSlug(first.slug);
          setProposalId(first.proposals[0]?.id ?? '');
        }
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : 'Não foi possível listar as propostas pendentes.',
        );
      }
    })();
  }, []);

  const selected = topics.find((topic) => topic.slug === slug);
  const proposals = selected?.proposals ?? [];

  const load = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(undefined);
    setPreview(undefined);
    try {
      const response = await fetch(
        `/api/v1/reviews/topic/${encodeURIComponent(slug)}/${encodeURIComponent(proposalId)}`,
      );
      const value = (await response.json()) as {
        files?: unknown;
        message?: string;
      };
      if (!response.ok) {
        setMessage(value.message ?? 'Não foi possível abrir a revisão.');
        return;
      }
      setPreview(previewFiles(value));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível abrir a revisão.');
    }
  };

  const approve = async () => {
    if (!preview) return;
    try {
      await request(
        `/reviews/topic/${encodeURIComponent(slug)}/${encodeURIComponent(proposalId)}/approve`,
        {
          method: 'POST',
          body: { confirmation: proposalId, paths: preview.map((file) => file.path) },
        },
      );
      setMessage('Arquivos aprovados e promovidos para a wiki.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível aprovar a proposta.');
    }
  };

  return (
    <div className="page">
      <p className="eyebrow">REVISÃO HUMANA</p>
      <h1>Nada entra na wiki por acaso.</h1>
      {topics.length === 0 ? (
        <p className="muted">{message ?? 'Nenhuma proposta pendente neste vault.'}</p>
      ) : (
        <form className="source-form" onSubmit={(event) => void load(event)}>
          <label>
            Tópico
            <select
              name="topic"
              value={slug}
              onChange={(event) => {
                const nextSlug = event.target.value;
                setSlug(nextSlug);
                const next = topics.find((topic) => topic.slug === nextSlug);
                setProposalId(next?.proposals[0]?.id ?? '');
                setPreview(undefined);
                setMessage(undefined);
              }}
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
            Proposta
            <select
              name="proposal"
              value={proposalId}
              onChange={(event) => {
                setProposalId(event.target.value);
                setPreview(undefined);
                setMessage(undefined);
              }}
              required
            >
              {proposals.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id} ({item.agent})
                </option>
              ))}
            </select>
          </label>
          <button className="primary">Abrir revisão</button>
        </form>
      )}
      {preview?.map((file) => (
        <article className="panel" key={file.path}>
          <b>{file.path}</b>
          <pre className="output">{file.diff?.text}</pre>
        </article>
      ))}
      {preview && preview.length > 0 && (
        <button className="primary" onClick={() => void approve()}>
          Aprovar todos os arquivos
        </button>
      )}
      {message && topics.length > 0 && <div className="notice">{message}</div>}
      <div className="panel">
        <p>Trabalhos que podem gerar propostas:</p>
        <JobList jobs={candidates} />
      </div>
    </div>
  );
}

function previewFiles(value: { readonly files?: unknown }): readonly PreviewFile[] {
  const files = value.files;
  if (Array.isArray(files)) return files as PreviewFile[];
  if (files && typeof files === 'object' && Array.isArray((files as { files?: unknown }).files)) {
    return (files as { files: PreviewFile[] }).files;
  }
  return [];
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

async function request(
  path: string,
  init: { readonly method: 'POST'; readonly body?: unknown },
): Promise<unknown> {
  const response = await fetch(`/api/v1${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const value = (await response.json()) as { message?: string };
  if (!response.ok) throw new Error(value.message ?? 'Ação local falhou.');
  return value;
}
