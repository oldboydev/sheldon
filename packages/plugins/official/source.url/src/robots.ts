export type RobotsParseResult =
  | {
      readonly status: 'rules';
      allows(pathname: string): boolean;
    }
  | {
      readonly status: 'ambiguous';
      readonly warning: 'ROBOTS_POLICY_AMBIGUOUS';
    }
  | {
      readonly status: 'unreadable';
      readonly warning: 'ROBOTS_UTF8_INVALID';
    };

interface RobotsGroup {
  readonly agents: Array<string | undefined>;
  readonly directives: RobotsDirective[];
  hasDirectives: boolean;
}

type RobotsDirective =
  | {
      readonly kind: 'allow' | 'disallow';
      readonly pattern?: string;
    }
  | {
      readonly kind: 'crawl-delay' | 'malformed';
    };

interface CompiledRule {
  readonly allow: boolean;
  readonly matcher: RegExp;
  readonly rank: number;
}

const ambiguous: RobotsParseResult = {
  status: 'ambiguous',
  warning: 'ROBOTS_POLICY_AMBIGUOUS',
};

const unreadable: RobotsParseResult = {
  status: 'unreadable',
  warning: 'ROBOTS_UTF8_INVALID',
};

export function parseRobotsPolicy(
  bytes: Uint8Array,
  productToken: 'SheldonBot',
): RobotsParseResult {
  let contents: string;
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return unreadable;
  }

  const groups = parseGroups(contents.replace(/\r\n?/gu, '\n'));
  const exactToken = productToken.toLowerCase();
  const exactGroups = groups.filter((group) => group.agents.includes(exactToken));
  const applicable =
    exactGroups.length > 0 ? exactGroups : groups.filter((group) => group.agents.includes('*'));

  const rules: CompiledRule[] = [];
  for (const group of applicable) {
    if (group.agents.includes(undefined)) return ambiguous;
    for (const directive of group.directives) {
      if (!('pattern' in directive)) return ambiguous;
      if (directive.pattern === undefined) {
        return ambiguous;
      }
      if (directive.kind === 'disallow' && directive.pattern === '') continue;
      rules.push(compileRule(directive.kind === 'allow', directive.pattern));
    }
  }

  return {
    status: 'rules',
    allows(pathname: string): boolean {
      let selected: CompiledRule | undefined;
      for (const rule of rules) {
        if (!rule.matcher.test(pathname)) continue;
        if (
          selected === undefined ||
          rule.rank > selected.rank ||
          (rule.rank === selected.rank && rule.allow && !selected.allow)
        ) {
          selected = rule;
        }
      }
      return selected?.allow ?? true;
    },
  };
}

function parseGroups(contents: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;

  const finishCurrent = (): void => {
    if (current !== undefined) groups.push(current);
    current = undefined;
  };

  for (const sourceLine of contents.split('\n')) {
    const commentIndex = sourceLine.indexOf('#');
    const line = (commentIndex === -1 ? sourceLine : sourceLine.slice(0, commentIndex)).trim();
    if (line === '') continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      const whitespaceIndex = line.search(/\s/u);
      const field = (whitespaceIndex === -1 ? line : line.slice(0, whitespaceIndex)).toLowerCase();
      const value = whitespaceIndex === -1 ? '' : line.slice(whitespaceIndex).trim();
      if (field === 'user-agent') {
        if (current?.hasDirectives) finishCurrent();
        current ??= createGroup();
        if (validProductToken(value)) current.agents.push(value.toLowerCase());
        current.agents.push(undefined);
      } else if (
        current !== undefined &&
        (field === 'allow' || field === 'disallow' || field === 'crawl-delay')
      ) {
        current.hasDirectives = true;
        current.directives.push({ kind: 'malformed' });
      }
      continue;
    }

    const field = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    if (field === 'user-agent') {
      if (current?.hasDirectives) finishCurrent();
      current ??= createGroup();
      current.agents.push(validProductToken(value) ? value.toLowerCase() : undefined);
      continue;
    }

    if (current === undefined) continue;
    current.hasDirectives = true;
    if (field === 'allow' || field === 'disallow') {
      current.directives.push({
        kind: field,
        pattern: validPattern(value, field) ? value : undefined,
      });
    } else if (field === 'crawl-delay') {
      current.directives.push({ kind: 'crawl-delay' });
    }
  }
  finishCurrent();
  return groups;
}

function createGroup(): RobotsGroup {
  return { agents: [], directives: [], hasDirectives: false };
}

function validProductToken(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value);
}

function validPattern(value: string, kind: 'allow' | 'disallow'): boolean {
  if (value === '') return kind === 'disallow';
  return value.startsWith('/');
}

function compileRule(allow: boolean, originalPattern: string): CompiledRule {
  const anchored = originalPattern.endsWith('$');
  const pathPattern = anchored ? originalPattern.slice(0, -1) : originalPattern;
  const expression = pathPattern
    .split('*')
    .map((part) => escapeRegExp(part))
    .join('.*');
  const rank = new TextEncoder().encode(originalPattern.replaceAll('*', '')).byteLength;
  return {
    allow,
    matcher: new RegExp(`^${expression}${anchored ? '$' : ''}`, 'u'),
    rank,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
