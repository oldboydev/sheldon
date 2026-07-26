import type { CommittedRepositorySnapshot } from './snapshot.js';

export const REPOSITORY_SECRET_DETECTED = 'REPOSITORY_SECRET_DETECTED' as const;

export type RepositorySecretCategory =
  | 'aws-access-key-id'
  | 'github-token'
  | 'google-api-key'
  | 'npm-token'
  | 'private-key'
  | 'slack-token';

export interface RepositorySecretFinding {
  readonly category: RepositorySecretCategory;
}

interface SecretCategoryPatterns {
  readonly category: RepositorySecretCategory;
  readonly patterns: readonly RegExp[];
}

const secretPatterns: readonly SecretCategoryPatterns[] = [
  {
    category: 'aws-access-key-id',
    patterns: [/(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/u],
  },
  {
    category: 'github-token',
    patterns: [
      /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})(?![A-Za-z0-9_])/u,
    ],
  },
  {
    category: 'google-api-key',
    patterns: [/(?:^|[^0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/u],
  },
  {
    category: 'npm-token',
    patterns: [/(?:^|[^0-9A-Za-z])npm_[0-9A-Za-z]{36}(?![0-9A-Za-z])/u],
  },
  {
    category: 'private-key',
    patterns: [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u],
  },
  {
    category: 'slack-token',
    patterns: [
      /(?:^|[^0-9A-Za-z])(?:xox[cbaprs]|xoxe|xwfp)-[0-9A-Za-z-]{20,}(?![0-9A-Za-z-])/u,
      new RegExp(
        `(?:^|[^0-9A-Za-z])${['xa', 'pp'].join('')}-[0-9]+-[0-9A-Za-z]+-[0-9]+-[0-9A-Za-z-]{20,}(?![0-9A-Za-z-])`,
        'u',
      ),
    ],
  },
];
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

type RepositorySecretScanInput = Pick<
  CommittedRepositorySnapshot,
  'canonicalUri' | 'inventory' | 'selectedFiles'
>;

export class RepositorySecretError extends Error {
  readonly code = REPOSITORY_SECRET_DETECTED;
  readonly findings: readonly RepositorySecretFinding[];

  constructor(findings: readonly RepositorySecretFinding[]) {
    const safeFindings = secretPatterns.flatMap(({ category }) =>
      findings.some((finding) => finding.category === category)
        ? [Object.freeze({ category })]
        : [],
    );
    const diagnostics = safeFindings.map(({ category }) => category).join(', ');
    super(
      diagnostics ? `${REPOSITORY_SECRET_DETECTED}: ${diagnostics}` : REPOSITORY_SECRET_DETECTED,
    );
    this.name = 'RepositorySecretError';
    this.findings = Object.freeze(safeFindings);
  }
}

export function findRepositorySecrets(
  snapshot: RepositorySecretScanInput,
): readonly RepositorySecretFinding[] {
  const publishableText = [
    snapshot.canonicalUri,
    ...snapshot.selectedFiles.map(({ path }) => path),
    ...snapshot.inventory.map(({ path }) => path),
    ...snapshot.selectedFiles.map(({ bytes }) => utf8Decoder.decode(bytes)),
  ];
  const findings = secretPatterns.flatMap(({ category, patterns }) =>
    publishableText.some((value) => patterns.some((pattern) => pattern.test(value)))
      ? [Object.freeze({ category })]
      : [],
  );
  return Object.freeze(findings.map((finding) => Object.freeze(finding)));
}

export function assertRepositorySnapshotHasNoSecrets(snapshot: RepositorySecretScanInput): void {
  const findings = findRepositorySecrets(snapshot);
  if (findings.length > 0) throw new RepositorySecretError(findings);
}
