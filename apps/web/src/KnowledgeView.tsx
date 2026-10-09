import { useEffect, useState } from 'react';

import { WikiBody } from './WikiBody.js';

interface EntityRef {
  readonly kind: 'topic' | 'project';
  readonly title: string;
  readonly slug: string;
}

interface WikiPage {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly body: string;
  readonly sources: readonly string[];
  readonly neighbours: readonly { path: string; relation: 'outgoing' | 'incoming' }[];
}

interface ApiProblem {
  readonly code: string;
  readonly message: string;
  readonly recovery: string;
}

export function KnowledgeView({
  topics,
  projects,
}: {
  readonly topics: readonly { title: string; slug: string }[];
  readonly projects: readonly { title: string; slug: string }[];
}) {
  const entities: readonly EntityRef[] = [
    ...topics.map((topic) => ({ kind: 'topic' as const, ...topic })),
    ...projects.map((project) => ({ kind: 'project' as const, ...project })),
  ];
  const [selected, setSelected] = useState<EntityRef>();
  const [entries, setEntries] = useState<readonly { path: string; title: string }[]>([]);
  const [page, setPage] = useState<WikiPage>();
  const [problem, setProblem] = useState<ApiProblem>();
  const [rawText, setRawText] = useState<string>();
  const [rawMissing, setRawMissing] = useState<string>();

  useEffect(() => {
    if (selected !== undefined || entities[0] === undefined) return;
    setSelected(entities[0]);
  }, [entities, selected]);

  useEffect(() => {
    if (selected === undefined) return;
    void (async () => {
      const response = await fetch(entityUrl(selected, 'wiki'));
      const value = (await response.json()) as { path: string; title?: string }[] | ApiProblem;
      if (!response.ok) {
        setEntries([]);
        return;
      }
      setEntries(
        (value as { path: string; title?: string }[]).map((item) => ({
          path: item.path,
          title: item.title !== undefined && item.title.length > 0 ? item.title : item.path,
        })),
      );
    })();
  }, [selected]);

  const openPath = async (wikiPath: string, keepOnError = false) => {
    if (selected === undefined) return;
    const response = await fetch(wikiPageUrl(selected, wikiPath));
    const value = (await response.json()) as WikiPage | ApiProblem;
    if (!response.ok) {
      setProblem(value as ApiProblem);
      if (!keepOnError) setPage(undefined);
      return;
    }
    setProblem(undefined);
    setRawText(undefined);
    setRawMissing(undefined);
    setPage(value as WikiPage);
  };

  const openSource = async (sourcePath: string) => {
    if (selected === undefined) return;
    const response = await fetch(rawUrl(selected, sourcePath));
    if (!response.ok) {
      const value = (await response.json()) as ApiProblem;
      setRawText(undefined);
      setRawMissing(value.message);
      return;
    }
    setRawMissing(undefined);
    setRawText(await response.text());
  };

  return (
    <div className="page wiki-page">
      <p className="eyebrow">Conhecimento aprovado</p>
      <h1>Uma árvore que mostra a origem.</h1>
      {entities.length === 0 ? (
        <div className="tree panel">
          <p>Nenhum tópico ainda. Crie um tópico antes de ingerir uma fonte.</p>
        </div>
      ) : (
        <div className="wiki-layout">
          <nav className="tree panel card" aria-label="Árvore da wiki">
            {entities.map((entity) => (
              <div key={`${entity.kind}:${entity.slug}`}>
                <button
                  className={
                    selected?.kind === entity.kind && selected.slug === entity.slug
                      ? 'wiki-entity selected'
                      : 'wiki-entity'
                  }
                  onClick={() => {
                    setSelected(entity);
                    setPage(undefined);
                    setProblem(undefined);
                    setRawText(undefined);
                    setRawMissing(undefined);
                  }}
                >
                  {entity.title}
                </button>
                {selected?.kind === entity.kind && selected.slug === entity.slug && (
                  <ul className="wiki-paths">
                    {entries.map((entry) => (
                      <li key={entry.path}>
                        <button
                          data-wiki-path={entry.path}
                          title={entry.path}
                          className={page?.path === entry.path ? 'is-active' : undefined}
                          onClick={() => void openPath(entry.path)}
                        >
                          {entry.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </nav>
          <article className="panel card wiki-article">
            {page && (
              <>
                <h2>{page.title}</h2>
                <WikiBody
                  markdown={page.body}
                  currentPath={page.path}
                  title={page.title}
                  onWikiLink={(target) => void openPath(target, true)}
                />
              </>
            )}
            {problem && (
              <div className="notice error">
                <b>{problem.code}</b>
                <p>{problem.message}</p>
                <small>{problem.recovery}</small>
              </div>
            )}
          </article>
          <aside className="panel card wiki-aside">
            {page ? (
              <>
                {page.sources.length > 0 && (
                  <section>
                    <p className="eyebrow">Fontes</p>
                    {page.sources.map((source) => (
                      <button key={source} title={source} onClick={() => void openSource(source)}>
                        {source}
                      </button>
                    ))}
                    {rawText && <pre className="output">{rawText}</pre>}
                    {rawMissing && <p>{rawMissing}</p>}
                  </section>
                )}
                {page.neighbours.length > 0 && (
                  <section>
                    <p className="eyebrow">Vizinhos</p>
                    {page.neighbours.map((neighbour) => (
                      <button
                        key={`${neighbour.relation}:${neighbour.path}`}
                        data-wiki-path={neighbour.path}
                        title={neighbour.path}
                        onClick={() => void openPath(neighbour.path)}
                      >
                        {neighbour.path}{' '}
                        <span className="wiki-relation">
                          {neighbour.relation === 'outgoing' ? 'saindo' : 'entrando'}
                        </span>
                      </button>
                    ))}
                  </section>
                )}
                <p className="eyebrow">Proveniência</p>
                <div className="provenance" aria-label="Fluxo de proveniência">
                  <span>raw</span>
                  <i>→</i>
                  <span>proposta</span>
                  <i>→</i>
                  <span>conceito</span>
                </div>
              </>
            ) : (
              <p className="muted">Abra uma página para ver fontes e vizinhos.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function entityUrl(entity: EntityRef, leaf: 'wiki'): string {
  return `/api/v1/entities/${entity.kind}/${encodeURIComponent(entity.slug)}/${leaf}`;
}

function wikiPageUrl(entity: EntityRef, wikiPath: string): string {
  return `${entityUrl(entity, 'wiki')}/${encodeWikiRemainder(wikiPath, 'wiki/')}`;
}

function rawUrl(entity: EntityRef, sourcePath: string): string {
  return `/api/v1/entities/${entity.kind}/${encodeURIComponent(entity.slug)}/raw/${encodeWikiRemainder(sourcePath, 'raw/')}`;
}

function encodeWikiRemainder(path: string, prefix: string): string {
  const normalized = path.replaceAll('\\', '/');
  const remainder = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  return remainder.split('/').map(encodeURIComponent).join('/');
}
