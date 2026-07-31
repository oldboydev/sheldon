/* Generated-client shape for the M7 OpenAPI contract. Keep this file free of domain rules. */
export interface JobEvent {
  readonly id: number;
  readonly at: string;
  readonly stage: string;
  readonly message: string;
}

export interface Job {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface JobPage {
  readonly jobs: readonly Job[];
  readonly nextOffset?: number;
}

export interface Dashboard {
  readonly health: { readonly vault: boolean; readonly sqlite: boolean };
  readonly jobs: { readonly queued: number; readonly failed: number; readonly running: number };
  readonly activity: readonly Job[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, init);
  if (!response.ok) throw (await response.json()) as Error;
  return (await response.json()) as T;
}

export const client = {
  dashboard: () => request<Dashboard>('/dashboard'),
  entities: (kind: 'topic' | 'project') => request<unknown[]>(`/entities/${kind}`),
  plugins: () => request<unknown[]>('/plugins'),
  jobs: () => request<JobPage>('/jobs'),
  queueJob: (body: unknown) =>
    request<Job>('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  cancelJob: (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),
  retryJob: (id: string) => request<Job>(`/jobs/${id}/retry`, { method: 'POST' }),
};
