import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import { parseWikiMarkdown, resolveWikiHref, type WikiInline } from './wiki-markdown.js';

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
  const [paths, setPaths] = useState<readonly string[]>([]);
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
      const value = (await response.json()) as { path: string }[] | ApiProblem;
      if (!response.ok) {
        setPaths([]);
        return;
      }
      setPaths((value as { path: string }[]).map((item) => item.path));
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
    <div className="page">
      <p className="eyebrow">CONHECIMENTO APROVADO</p>
      <h1>Uma árvore que mostra a origem.</h1>
      {entities.length === 0 ? (
        <div className="tree panel">
          <p>Nenhum tópico ainda. Crie um tópico antes de ingerir uma fonte.</p>
        </div>
      ) : (
        <div className="wiki-layout">
          <nav className="tree panel" aria-label="Árvore da wiki">
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
                    {paths.map((path) => (
                      <li key={path}>
                        <button data-wiki-path={path} onClick={() => void openPath(path)}>
                          {path}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </nav>
          <article className="panel wiki-article">
            {page && (
              <>
                <h2>{page.title}</h2>
                <div className="wiki-body">
                  {parseWikiMarkdown(page.body).map((block, index) =>
                    block.type === 'heading' ? (
                      heading(block.level, inlines(block.children, page.path, openPath), index)
                    ) : (
                      <p key={index}>{inlines(block.children, page.path, openPath)}</p>
                    ),
                  )}
                </div>
                {page.sources.length > 0 && (
                  <section className="wiki-aside">
                    <p className="eyebrow">Fontes</p>
                    {page.sources.map((source) => (
                      <button
                        key={source}
                        className="quiet"
                        onClick={() => void openSource(source)}
                      >
                        {source}
                      </button>
                    ))}
                    {rawText && <pre className="output">{rawText}</pre>}
                    {rawMissing && <p>{rawMissing}</p>}
                  </section>
                )}
                {page.neighbours.length > 0 && (
                  <section className="wiki-aside">
                    <p className="eyebrow">Vizinhos</p>
                    {page.neighbours.map((neighbour) => (
                      <button
                        key={`${neighbour.relation}:${neighbour.path}`}
                        data-wiki-path={neighbour.path}
                        className="quiet"
                        onClick={() => void openPath(neighbour.path)}
                      >
                        {neighbour.path} {neighbour.relation}
                      </button>
                    ))}
                  </section>
                )}
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
        </div>
      )}
    </div>
  );
}

function heading(level: number, children: ReactNode, key: number): ReactNode {
  switch (level) {
    case 1:
      return <h1 key={key}>{children}</h1>;
    case 2:
      return <h2 key={key}>{children}</h2>;
    case 3:
      return <h3 key={key}>{children}</h3>;
    case 4:
      return <h4 key={key}>{children}</h4>;
    case 5:
      return <h5 key={key}>{children}</h5>;
    default:
      return <h6 key={key}>{children}</h6>;
  }
}

function inlines(
  nodes: readonly WikiInline[],
  currentPath: string,
  openPath: (path: string, keepOnError?: boolean) => Promise<void>,
): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value;
    if (!node.wiki) {
      return (
        <a key={index} href={node.href}>
          {node.text}
        </a>
      );
    }
    const target = resolveWikiHref(currentPath, node.href);
    return (
      <a
        key={index}
        href={node.href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          void openPath(target, true);
        }}
      >
        {node.text}
      </a>
    );
  });
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
