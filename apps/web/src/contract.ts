const apiResponses = {
  400: {
    description: 'Entrada inválida',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiProblem' } } },
  },
  404: {
    description: 'Recurso não encontrado',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiProblem' } } },
  },
  500: {
    description: 'Falha interna',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiProblem' } } },
  },
};

/**
 * Source for the compact M7 OpenAPI document. The browser client is kept next to this contract so
 * route names and response types remain visible at the call site.
 */
export const webOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Sheldon Local API', version: '1.0.0' },
  servers: [{ url: 'http://127.0.0.1' }],
  paths: {
    '/api/v1/dashboard': {
      get: { summary: 'Read local vault health and activity', responses: apiResponses },
    },
    '/api/v1/entities/{kind}': { get: { summary: 'List topics or projects' } },
    '/api/v1/plugins': { get: { summary: 'List installed local plugins' } },
    '/api/v1/sources/probe': { post: { summary: 'Preview source plugin selection' } },
    '/api/v1/jobs': {
      get: { summary: 'List paginated jobs', responses: apiResponses },
      post: { summary: 'Queue a validated local job', responses: apiResponses },
    },
    '/api/v1/jobs/{id}': { get: { summary: 'Read one job' } },
    '/api/v1/jobs/{id}/events': { get: { summary: 'Resume job events with an SSE cursor' } },
    '/api/v1/jobs/{id}/cancel': { post: { summary: 'Request job cancellation' } },
    '/api/v1/jobs/{id}/retry': { post: { summary: 'Retry a failed local job' } },
  },
  components: {
    schemas: {
      ApiProblem: {
        type: 'object',
        required: ['code', 'message', 'recovery'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          target: { type: 'string' },
          recovery: { type: 'string' },
        },
      },
    },
  },
} as const;

export interface ApiProblem {
  readonly code: string;
  readonly message: string;
  readonly target?: string;
  readonly recovery?: string;
}
