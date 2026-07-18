import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { valid as validSemver } from 'semver';
import parseSpdx from 'spdx-expression-parse';

import { ProtocolValidationError } from './errors.js';
import {
  contractFixtureSchema,
  healthcheckResultSchema,
  jsonValueSchema,
  pluginDescriptionSchema,
  pluginManifestSchema,
  probeResultSchema,
  requestEnvelopeSchema,
  responseEnvelopeSchema,
  sourceArtifactsSchema,
} from './schemas.js';
import type {
  ContractFixture,
  HealthcheckResult,
  PluginDescription,
  PluginManifest,
  PluginOrigin,
  ProbeResult,
  RequestEnvelope,
  ResponseEnvelope,
  SourceArtifact,
} from './types.js';

const officialLicenses = new Set([
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MPL-2.0',
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(jsonValueSchema);
ajv.addFormat('semver', (value) => validSemver(value) !== null);
ajv.addFormat('spdx', (value) => {
  try {
    parseSpdx(value);
    return true;
  } catch {
    return false;
  }
});

const validateManifest = ajv.compile(pluginManifestSchema);
const validateRequest = ajv.compile(requestEnvelopeSchema);
const validateResponse = ajv.compile(responseEnvelopeSchema);
const validateContract = ajv.compile(contractFixtureSchema);
const validateDescription = ajv.compile(pluginDescriptionSchema);
const validateProbe = ajv.compile(probeResultSchema);
const validateHealthcheck = ajv.compile(healthcheckResultSchema);
const validateArtifacts = ajv.compile(sourceArtifactsSchema);

function parseWith<T>(validator: ValidateFunction, value: unknown, label: string): T {
  if (validator(value)) return value as T;
  const issues = (validator.errors ?? []).map(formatIssue);
  throw new ProtocolValidationError(`${label} is invalid: ${issues.join('; ')}`, issues);
}

function formatIssue(issue: ErrorObject): string {
  return `${issue.instancePath || '/'} ${issue.message ?? 'is invalid'}`;
}

export function parsePluginManifest(value: unknown, origin: PluginOrigin): PluginManifest {
  const parsed = parseWith<Omit<PluginManifest, 'origin'>>(
    validateManifest,
    value,
    'Plugin manifest',
  );
  if (origin === 'official' && !officialLicenses.has(parsed.license)) {
    throw new ProtocolValidationError(
      `Plugin manifest has incompatible official license: ${parsed.license}`,
      [`/license must be one of ${[...officialLicenses].join(', ')}`],
    );
  }
  return { ...parsed, origin };
}

export const parseRequestEnvelope = (value: unknown): RequestEnvelope =>
  parseWith<RequestEnvelope>(validateRequest, value, 'Protocol request');
export const parseResponseEnvelope = (value: unknown): ResponseEnvelope =>
  parseWith<ResponseEnvelope>(validateResponse, value, 'Protocol response');
export const parsePluginDescription = (value: unknown): PluginDescription =>
  parseWith<PluginDescription>(validateDescription, value, 'Plugin description');
export const parseProbeResult = (value: unknown): ProbeResult =>
  parseWith<ProbeResult>(validateProbe, value, 'Probe result');
export const parseHealthcheckResult = (value: unknown): HealthcheckResult =>
  parseWith<HealthcheckResult>(validateHealthcheck, value, 'Healthcheck result');
export const parseSourceArtifacts = (value: unknown): readonly SourceArtifact[] =>
  parseWith<readonly SourceArtifact[]>(validateArtifacts, value, 'Source artifacts');
export const parseContractFixture = (value: unknown): ContractFixture =>
  parseWith<ContractFixture>(validateContract, value, 'Contract fixture');
