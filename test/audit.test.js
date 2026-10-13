import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditReport, createOsvAuditor, InputError, parseAuditInput } from '../src/audit.js';

 test('parses npm lockfiles and ignores the root project', () => {
  const dependencies = parseAuditInput({
    format: 'npm-lock',
    lockfile: {
      lockfileVersion: 3,
      packages: {
        '': { name: 'example-app', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.19' },
        'node_modules/@scope/pkg': { version: '2.4.1' },
        'node_modules/parent/node_modules/child': { version: '1.2.3' },
      },
    },
  });
  assert.deepEqual(dependencies.map((item) => item.name), ['lodash', '@scope/pkg', 'child']);
  assert.equal(dependencies.length, 3);
});

test('parses pinned Python requirements and skips ranges/unpinned lines', () => {
  const dependencies = parseAuditInput({
    format: 'requirements',
    lockfile: '# app\nrequests==2.31.0\nDjango==4.2.0 ; python_version >= "3.10"\nfoo>=1.2\n-e .\n',
  });
  assert.deepEqual(dependencies, [
    { name: 'requests', version: '2.31.0', ecosystem: 'PyPI' },
    { name: 'Django', version: '4.2.0', ecosystem: 'PyPI' },
  ]);
});

test('deduplicates dependencies and rejects unsupported ecosystem', () => {
  const dependencies = parseAuditInput({ format: 'dependencies', dependencies: [
    { name: 'lodash', version: 'v4.17.19', ecosystem: 'npm' },
    { name: 'lodash', version: '4.17.19', ecosystem: 'npm' },
  ] });
  assert.equal(dependencies.length, 1);
  assert.equal(dependencies[0].version, '4.17.19');
  assert.throws(() => parseAuditInput({ format: 'dependencies', dependencies: [{ name: 'x', version: '1.0', ecosystem: 'unknown' }] }), InputError);
});

test('rejects non-exact versions, empty packages, and over-limit input', () => {
  assert.throws(() => parseAuditInput({ format: 'dependencies', dependencies: [{ name: 'x', version: '^1.0.0', ecosystem: 'npm' }] }), /No exact/);
  assert.throws(() => parseAuditInput({ format: 'requirements', lockfile: '# nothing pinned' }), /No exact/);
  assert.throws(() => parseAuditInput({ format: 'dependencies', dependencies: Array.from({ length: 2 }, (_, i) => ({ name: `p${i}`, version: '1.0.0', ecosystem: 'npm' })) }, 1), /limit is 1/);
});

test('builds a deterministic summary with advisory IDs and fix versions', () => {
  const report = buildAuditReport([
    { name: 'lodash', version: '4.17.19', ecosystem: 'npm' },
    { name: 'safe-package', version: '1.0.0', ecosystem: 'npm' },
  ], [
    { vulns: [{ id: 'GHSA-test-test-test', aliases: ['CVE-2020-0000'], summary: 'Example issue', database_specific: { severity: 'HIGH' }, affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] },], references: [{ url: 'https://example.com/advisory' }] }] },
    {},
  ], { requestId: 'test-id', now: new Date('2026-01-01T00:00:00.000Z') });

  assert.equal(report.requestId, 'test-id');
  assert.equal(report.summary.dependenciesScanned, 2);
  assert.equal(report.summary.packagesWithVulnerabilities, 1);
  assert.equal(report.summary.vulnerabilitiesFound, 1);
  assert.equal(report.summary.highestSeverity, 'HIGH');
  assert.deepEqual(report.packages[0].vulnerabilities[0].fixedVersions, ['4.17.21']);
  assert.equal(report.packages[1].vulnerable, false);
});

test('batches OSV lookups and caches repeat dependencies', async () => {
  let fetchCount = 0;
  const auditor = createOsvAuditor({
    batchSize: 2,
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ results: body.queries.map(() => ({})) }) };
    },
  });
  const dependencies = [0, 1, 2].map((i) => ({ name: `pkg${i}`, version: '1.0.0', ecosystem: 'npm' }));
  await auditor(dependencies);
  assert.equal(fetchCount, 2);
  await auditor(dependencies);
  assert.equal(fetchCount, 2);
});
