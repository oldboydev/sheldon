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
  const [reason, setReason] = useState('');
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

  const load = async (event?: FormEvent) => {
    event?.preventDefault();
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

  const reject = async () => {
    if (!preview) return;
    try {
      await request(
        `/reviews/topic/${encodeURIComponent(slug)}/${encodeURIComponent(proposalId)}/reject`,
        {
          method: 'POST',
          body: { confirmation: proposalId, reason },
        },
      );
      setMessage('Proposta rejeitada.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível rejeitar a proposta.');
    }
  };

  return (
    <div className="page">
      <p className="eyebrow">Revisão humana</p>
      <h1>Nada entra na wiki por acaso.</h1>
      {topics.length === 0 ? (
        <p className="muted">{message ?? 'Nenhuma proposta pendente neste vault.'}</p>
      ) : (
        <>
          <ul className="proposal-list">
            {topics.map((topic) => (
              <li key={topic.slug} className="card card__pad">
                <p className="eyebrow">{topic.title}</p>
                {topic.proposals.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={
                      slug === topic.slug && proposalId === item.id
                        ? 'proposal-item is-active'
                        : 'proposal-item'
                    }
                    data-proposal-id={item.id}
                    aria-current={
                      slug === topic.slug && proposalId === item.id ? 'true' : undefined
                    }
                    onClick={() => {
                      setSlug(topic.slug);
                      setProposalId(item.id);
                      setPreview(undefined);
                      setMessage(undefined);
                    }}
                  >
                    {item.id}
                    <small className="muted"> {item.agent}</small>
                  </button>
                ))}
              </li>
            ))}
          </ul>
          <form className="source-form" onSubmit={(event) => void load(event)}>
            <button className="btn btn--primary primary">Abrir revisão</button>
          </form>
        </>
      )}
      {preview?.map((file) => (
        <article className="card card__pad panel" key={file.path}>
          <b>{file.path}</b>
          <pre className="output">{file.diff?.text}</pre>
        </article>
      ))}
      {preview && preview.length > 0 && (
        <div className="card card__pad">
          <p>
            Confirma a proposta <b>{proposalId}</b>.
          </p>
          <label className="field">
            Motivo da rejeição
            <textarea
              className="textarea"
              name="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="review-actions">
            <button
              className="btn btn--primary primary"
              type="button"
              onClick={() => void approve()}
            >
              Aprovar
            </button>
            <button
              className="btn btn--danger-soft"
              type="button"
              onClick={() => void reject()}
              disabled={!reason.trim()}
            >
              Rejeitar
            </button>
          </div>
        </div>
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
