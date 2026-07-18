import { describe, expect, it } from 'vitest';

import {
  parseContractFixture,
  parsePluginManifest,
  parseRequestEnvelope,
  ProtocolValidationError,
} from '../src/index.js';

const manifest = {
  schemaVersion: 1,
  id: 'example.fixture',
  name: 'Example fixture',
  version: '1.2.3',
  protocolVersion: '1',
  license: 'MIT',
  command: { executable: 'node', arguments: ['plugin.mjs'] },
  capabilities: ['fixture'],
  priority: 10,
  platforms: ['win32'],
  permissions: { network: false, cookies: false },
  dependencies: [
    { id: 'node', kind: 'runtime', required: true, remediation: 'Install Node.js 24.' },
  ],
};

describe('protocol v1 validation', () => {
  it('parses a complete user manifest', () => {
    expect(parsePluginManifest(manifest, 'installed')).toMatchObject({
      id: 'example.fixture',
      origin: 'installed',
      protocolVersion: '1',
    });
  });

  it.each([
    ['bad id', { ...manifest, id: '../escape' }],
    ['bad semver', { ...manifest, version: 'latest' }],
    ['bad SPDX', { ...manifest, license: 'whatever' }],
    ['priority outside range', { ...manifest, priority: 101 }],
    [
      'missing license',
      Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'license')),
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => parsePluginManifest(value, 'installed')).toThrow(ProtocolValidationError);
  });

  it('parses a different protocol version so discovery can report incompatibility', () => {
    expect(parsePluginManifest({ ...manifest, protocolVersion: '2' }, 'installed')).toMatchObject({
      protocolVersion: '2',
    });
  });

  it('rejects an incompatible official license', () => {
    expect(() => parsePluginManifest({ ...manifest, license: 'GPL-3.0-only' }, 'official')).toThrow(
      /official license/i,
    );
  });

  it('parses a protocol request and rejects additional properties', () => {
    expect(
      parseRequestEnvelope({
        protocolVersion: '1',
        requestId: 'request-1',
        operation: 'probe',
        payload: { input: { kind: 'fixture' } },
      }),
    ).toMatchObject({ requestId: 'request-1', operation: 'probe' });
    expect(() =>
      parseRequestEnvelope({
        protocolVersion: '1',
        requestId: 'request-1',
        operation: 'probe',
        payload: {},
        unexpected: true,
      }),
    ).toThrow(ProtocolValidationError);
  });

  it('requires language-neutral contract cases', () => {
    expect(
      parseContractFixture({
        supportedProbe: { input: { kind: 'fixture' }, minimumConfidence: 80 },
        unsupportedProbe: { input: { kind: 'unknown' } },
        ingest: {
          input: { kind: 'fixture' },
          options: {},
          expectedRoles: ['normalized'],
        },
        cancel: { input: { kind: 'fixture', wait: true }, options: {} },
      }),
    ).toMatchObject({ ingest: { expectedRoles: ['normalized'] } });
  });
});
