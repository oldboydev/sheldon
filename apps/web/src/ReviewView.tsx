import { FormEvent, useEffect, useMemo, useState } from 'react';

import type { Job } from './client.generated.js';
import { WikiBody } from './WikiBody.js';
import { stripWikiFrontmatter } from './wiki-markdown.js';

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
  readonly operation?: 'create' | 'modify' | 'delete';
  readonly content?: string;
  readonly diff?: {
    readonly text: string;
    readonly addedLines?: number;
    readonly removedLines?: number;
  };
}

interface PreviewSource {
  readonly rawPath: string;
  readonly citation?: string;
}

interface PreviewState {
  readonly files: readonly PreviewFile[];
  readonly sources: readonly PreviewSource[];
  readonly claims: readonly string[];
  readonly contradictions: readonly string[];
}

export function ReviewView({
  jobs,
  onReviewsChanged,
}: {
  readonly jobs: readonly Job[];
  readonly onReviewsChanged?: () => void | Promise<void>;
}) {
  const candidates = useMemo(
    () => jobs.filter((job) => job.type === 'compile' || job.type === 'query'),
    [jobs],
  );
  const [topics, setTopics] = useState<readonly PendingTopic[]>([]);
  const [slug, setSlug] = useState('');
  const [proposalId, setProposalId] = useState('');
  const [preview, setPreview] = useState<PreviewState>();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string>();

  const refreshTopics = async (): Promise<readonly PendingTopic[]> => {
    const response = await fetch('/api/v1/reviews');
    const value = (await response.json()) as {
      topics?: readonly PendingTopic[];
      message?: string;
    };
    if (!response.ok) {
      throw new Error(value.message ?? 'Não foi possível listar as propostas pendentes.');
    }
    const next = value.topics ?? [];
    setTopics(next);
    return next;
  };

  useEffect(() => {
    void (async () => {
      try {
        const next = await refreshTopics();
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
        sources?: unknown;
        claims?: unknown;
        contradictions?: unknown;
        message?: string;
      };
      if (!response.ok) {
        setMessage(value.message ?? 'Não foi possível abrir a revisão.');
        return;
      }
      setPreview(unwrapPreview(value));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível abrir a revisão.');
    }
  };

  const afterDecide = async (notice: string) => {
    const next = await refreshTopics();
    if (!next.some((topic) => topic.proposals.some((item) => item.id === proposalId))) {
      const first = next[0];
      setSlug(first?.slug ?? '');
      setProposalId(first?.proposals[0]?.id ?? '');
    }
    setMessage(notice);
    await onReviewsChanged?.();
  };

  const approve = async () => {
    if (!preview) return;
    try {
      await request(
        `/reviews/topic/${encodeURIComponent(slug)}/${encodeURIComponent(proposalId)}/approve`,
        {
          method: 'POST',
          body: { confirmation: proposalId, paths: preview.files.map((file) => file.path) },
        },
      );
      await afterDecide('Arquivos aprovados e promovidos para a wiki.');
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
      await afterDecide('Proposta rejeitada.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível rejeitar a proposta.');
    }
  };

  return (
    <div className="page">
      <p className="eyebrow">Revisão humana</p>
      <h1>Nada entra na wiki por acaso.</h1>
      {topics.length === 0 ? (
        <p className="muted">Nenhuma proposta pendente neste vault.</p>
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
      {preview && (
        <>
          {(preview.sources.length > 0 ||
            preview.claims.length > 0 ||
            preview.contradictions.length > 0) && (
            <aside className="card card__pad review-context">
              {preview.sources.length > 0 && (
                <section>
                  <p className="eyebrow">Fontes</p>
                  <ul>
                    {preview.sources.map((source) => (
                      <li key={source.rawPath}>
                        {source.rawPath}
                        {source.citation ? ` — ${source.citation}` : ''}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {preview.claims.length > 0 && (
                <section>
                  <p className="eyebrow">Afirmações</p>
                  <ul>
                    {preview.claims.map((claim) => (
                      <li key={claim}>{claim}</li>
                    ))}
                  </ul>
                </section>
              )}
              {preview.contradictions.length > 0 && (
                <section>
                  <p className="eyebrow">Contradições</p>
                  <ul>
                    {preview.contradictions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              )}
            </aside>
          )}
          {preview.files.map((file) => (
            <article className="card card__pad panel" key={file.path}>
              <b>{file.path}</b>
              {file.operation === 'delete' ? (
                <p>Este caminho será removido.</p>
              ) : (
                file.content !== undefined && (
                  <WikiBody markdown={stripWikiFrontmatter(file.content)} currentPath={file.path} />
                )
              )}
              <CompactDiff file={file} />
            </article>
          ))}
        </>
      )}
      {preview && preview.files.length > 0 && (
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
      {message && <div className="notice">{message}</div>}
      <div className="panel">
        <p>Trabalhos que podem gerar propostas:</p>
        <JobList jobs={candidates} />
      </div>
    </div>
  );
}

function CompactDiff({ file }: { readonly file: PreviewFile }) {
  const diff = file.diff;
  if (diff === undefined) return null;
  const added = diff.addedLines ?? 0;
  const removed = diff.removedLines ?? 0;
  const lines = compactDiffLines(diff.text);
  return (
    <div className="review-diff">
      <p className="muted">
        {file.path} +{added} −{removed}
      </p>
      {lines.length > 0 && (
        <pre className="review-diff__body">
          {lines.map((line, index) => (
            <span key={`${line.kind}:${index}`} className={`review-diff__line is-${line.kind}`}>
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function compactDiffLines(
  text: string,
): readonly { readonly kind: 'add' | 'remove' | 'context'; readonly text: string }[] {
  const lines: { kind: 'add' | 'remove' | 'context'; text: string }[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) lines.push({ kind: 'add', text: line });
    else if (line.startsWith('-')) lines.push({ kind: 'remove', text: line });
    else if (line.startsWith(' ')) lines.push({ kind: 'context', text: line });
  }
  return lines;
}

function unwrapPreview(value: {
  readonly files?: unknown;
  readonly sources?: unknown;
  readonly claims?: unknown;
  readonly contradictions?: unknown;
}): PreviewState {
  const nested =
    value.files && typeof value.files === 'object' && !Array.isArray(value.files)
      ? (value.files as {
          readonly files?: unknown;
          readonly sources?: unknown;
          readonly claims?: unknown;
          readonly contradictions?: unknown;
        })
      : undefined;
  const files = Array.isArray(value.files)
    ? value.files
    : Array.isArray(nested?.files)
      ? nested.files
      : [];
  return {
    files: files as PreviewFile[],
    sources: asSources(nested?.sources ?? value.sources),
    claims: asStrings(nested?.claims ?? value.claims),
    contradictions: asStrings(nested?.contradictions ?? value.contradictions),
  };
}

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asSources(value: unknown): readonly PreviewSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [{ rawPath: item }];
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { rawPath?: unknown }).rawPath === 'string'
    ) {
      const source = item as { rawPath: string; citation?: unknown };
      return [
        {
          rawPath: source.rawPath,
          ...(typeof source.citation === 'string' ? { citation: source.citation } : {}),
        },
      ];
    }
    return [];
  });
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
