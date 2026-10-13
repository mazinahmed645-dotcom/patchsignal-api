const ALLOWED_ECOSYSTEMS = new Set([
  'npm',
  'PyPI',
  'Go',
  'Maven',
  'crates.io',
  'Packagist',
  'RubyGems',
  'NuGet',
]);

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'UNKNOWN'];
const MAX_LOCKFILE_CHARS = 1_000_000;
const MAX_DEPENDENCIES_DEFAULT = 250;
const MAX_BATCH_SIZE = 100;

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'InputError';
    this.status = status;
  }
}

function asText(value, fieldName) {
  if (typeof value !== 'string') throw new InputError(`"${fieldName}" must be a string.`);
  const text = value.trim();
  if (!text) throw new InputError(`"${fieldName}" must not be empty.`);
  if (text.length > MAX_LOCKFILE_CHARS) {
    throw new InputError(`"${fieldName}" is too large. Maximum size is 1,000,000 characters.`, 413);
  }
  return text;
}

function parseJson(value, fieldName) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
  const text = asText(value, fieldName);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InputError(`"${fieldName}" must contain a JSON object.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`"${fieldName}" is not valid JSON.`);
  }
}

function normalizeVersion(version) {
  if (typeof version !== 'string') return null;
  const clean = version.trim();
  // OSV needs an exact installed version, not ranges such as ^1.2 or >=2.0.
  if (!clean || /[<>=*|^~\s]/.test(clean)) return null;
  return clean.replace(/^v(?=\d)/i, '');
}

function addDependency(output, { name, version, ecosystem }) {
  if (typeof name !== 'string' || typeof version !== 'string') return;
  const cleanName = name.trim();
  const cleanVersion = normalizeVersion(version);
  if (!cleanName || cleanName.length > 250 || !cleanVersion || cleanVersion.length > 100) return;
  if (!ALLOWED_ECOSYSTEMS.has(ecosystem)) throw new InputError(`Unsupported ecosystem "${ecosystem}".`);
  output.push({ name: cleanName, version: cleanVersion, ecosystem });
}

function packageNameFromLockPath(path) {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index === -1) return null;
  return path.slice(index + marker.length).replace(/\/$/, '') || null;
}

function parseNpmLock(lockfile, output) {
  const document = parseJson(lockfile, 'lockfile');
  if (document.packages && typeof document.packages === 'object') {
    for (const [path, metadata] of Object.entries(document.packages)) {
      if (!path || !metadata || typeof metadata !== 'object') continue;
      const name = metadata.name || packageNameFromLockPath(path);
      addDependency(output, { name, version: metadata.version, ecosystem: 'npm' });
    }
    return;
  }

  // Support legacy package-lock v1's nested dependencies object.
  const root = document.dependencies;
  if (!root || typeof root !== 'object') {
    throw new InputError('Unsupported npm lockfile. Provide package-lock.json (lockfileVersion 1, 2, or 3).');
  }
  const walk = (dependencies) => {
    for (const [name, metadata] of Object.entries(dependencies || {})) {
      if (!metadata || typeof metadata !== 'object') continue;
      addDependency(output, { name, version: metadata.version, ecosystem: 'npm' });
      if (metadata.dependencies) walk(metadata.dependencies);
    }
  };
  walk(root);
}

function canonicalPythonName(name) {
  return name.trim().replace(/[-_.]+/g, '-');
}

function parseRequirements(lockfile, output) {
  const text = asText(lockfile, 'lockfile');
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // requirements.txt lines with a pinned exact version: package[extra]==1.2.3
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*==\s*([^;\s#]+)(?:\s*;.*)?$/);
    if (!match) continue;
    addDependency(output, {
      name: canonicalPythonName(match[1]),
      version: match[2],
      ecosystem: 'PyPI',
    });
  }
}

function parseDependencyArray(dependencies, output) {
  if (!Array.isArray(dependencies)) throw new InputError('"dependencies" must be an array.');
  for (const item of dependencies) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new InputError('Each dependency must be an object with name, version, and ecosystem.');
    }
    addDependency(output, {
      name: item.name,
      version: item.version,
      ecosystem: item.ecosystem,
    });
  }
}

export function parseAuditInput(body, maxDependencies = MAX_DEPENDENCIES_DEFAULT) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InputError('Request body must be a JSON object.');
  }
  if (typeof body.format !== 'string') {
    throw new InputError('Missing "format". Use "npm-lock", "requirements", or "dependencies".');
  }

  const dependencies = [];
  if (body.format === 'npm-lock') {
    parseNpmLock(body.lockfile, dependencies);
  } else if (body.format === 'requirements') {
    parseRequirements(body.lockfile, dependencies);
  } else if (body.format === 'dependencies') {
    parseDependencyArray(body.dependencies, dependencies);
  } else {
    throw new InputError('Unsupported format. Use "npm-lock", "requirements", or "dependencies".');
  }

  const unique = new Map();
  for (const dependency of dependencies) {
    const key = `${dependency.ecosystem.toLowerCase()}|${dependency.name.toLowerCase()}|${dependency.version.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, dependency);
  }
  const normalized = [...unique.values()];
  if (normalized.length === 0) {
    throw new InputError('No exact, version-pinned dependencies found. Use a lockfile or exact installed versions.');
  }
  if (normalized.length > maxDependencies) {
    throw new InputError(`Too many dependencies (${normalized.length}). The limit is ${maxDependencies}.`, 413);
  }
  return normalized;
}

function getSeverity(vulnerability) {
  const raw = vulnerability?.database_specific?.severity;
  if (typeof raw === 'string') {
    const normalized = raw.toUpperCase();
    if (['CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW'].includes(normalized)) {
      return normalized === 'MEDIUM' ? 'MODERATE' : normalized;
    }
  }
  return 'UNKNOWN';
}

function fixedVersions(vulnerability) {
  const values = new Set();
  for (const affected of vulnerability?.affected || []) {
    for (const range of affected.ranges || []) {
      for (const event of range.events || []) {
        if (typeof event.fixed === 'string' && event.fixed) values.add(event.fixed);
      }
    }
  }
  return [...values].sort();
}

function publicVulnerability(vulnerability) {
  return {
    id: vulnerability.id || 'UNKNOWN-ID',
    aliases: Array.isArray(vulnerability.aliases) ? vulnerability.aliases.slice(0, 20) : [],
    summary: String(vulnerability.summary || 'No summary supplied by the advisory source.').slice(0, 500),
    details: String(vulnerability.details || '').slice(0, 1200),
    severity: getSeverity(vulnerability),
    fixedVersions: fixedVersions(vulnerability),
    published: vulnerability.published || null,
    modified: vulnerability.modified || null,
    references: (Array.isArray(vulnerability.references) ? vulnerability.references : [])
      .map((reference) => reference?.url)
      .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
      .slice(0, 5),
  };
}

export function buildAuditReport(dependencies, osvResults, { requestId, now = new Date() } = {}) {
  const packages = dependencies.map((dependency, index) => {
    const rawVulnerabilities = Array.isArray(osvResults[index]?.vulns) ? osvResults[index].vulns : [];
    const seen = new Set();
    const vulnerabilities = rawVulnerabilities
      .filter((vulnerability) => {
        const key = vulnerability?.id || JSON.stringify(vulnerability);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(publicVulnerability)
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

    return { ...dependency, vulnerable: vulnerabilities.length > 0, vulnerabilityCount: vulnerabilities.length, vulnerabilities };
  });

  const allVulnerabilities = packages.flatMap((item) => item.vulnerabilities);
  const bySeverity = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  for (const vulnerability of allVulnerabilities) {
    const key = vulnerability.severity.toLowerCase();
    if (Object.hasOwn(bySeverity, key)) bySeverity[key] += 1;
    else bySeverity.unknown += 1;
  }
  const highestSeverity = SEVERITY_ORDER.find((severity) => allVulnerabilities.some((item) => item.severity === severity)) || 'NONE';

  return {
    status: 'ok',
    requestId: requestId || null,
    generatedAt: now.toISOString(),
    source: 'OSV.dev vulnerability database',
    summary: {
      dependenciesScanned: packages.length,
      packagesWithVulnerabilities: packages.filter((item) => item.vulnerable).length,
      vulnerabilitiesFound: allVulnerabilities.length,
      highestSeverity,
      vulnerabilitiesBySeverity: bySeverity,
      clean: allVulnerabilities.length === 0,
    },
    packages,
    limitations: [
      'Results reflect OSV.dev data available at scan time and are not a guarantee that software is safe.',
      'Only exact versions supplied in the request are checked. Unpinned requirements are not inferred.',
      'A missing severity label means the upstream advisory did not provide a severity value used by this service.',
    ],
  };
}

export function createOsvAuditor({
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  cacheTtlMs = 300_000,
  nowMs = () => Date.now(),
  batchSize = MAX_BATCH_SIZE,
} = {}) {
  const cache = new Map();

  async function queryChunk(dependencies) {
    const results = new Array(dependencies.length);
    const uncached = [];
    dependencies.forEach((dependency, index) => {
      const key = `${dependency.ecosystem.toLowerCase()}|${dependency.name.toLowerCase()}|${dependency.version.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > nowMs()) results[index] = cached.value;
      else {
        if (cached) cache.delete(key);
        uncached.push({ index, key, dependency });
      }
    });

    if (uncached.length === 0) return results;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          queries: uncached.map(({ dependency }) => ({
            package: { name: dependency.name, ecosystem: dependency.ecosystem },
            version: dependency.version,
          })),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('OSV.dev timed out while checking vulnerabilities. Please retry.');
      throw new Error('Could not reach OSV.dev. Please retry later.');
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`OSV.dev returned HTTP ${response.status}. Please retry later.`);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('OSV.dev returned an unreadable response. Please retry later.');
    }
    if (!Array.isArray(data.results) || data.results.length !== uncached.length) {
      throw new Error('OSV.dev returned an unexpected response. Please retry later.');
    }

    uncached.forEach(({ index, key }, position) => {
      const value = data.results[position] || { vulns: [] };
      results[index] = value;
      cache.set(key, { value, expiresAt: nowMs() + cacheTtlMs });
    });

    // Bound memory use for long-lived hosting processes.
    if (cache.size > 5_000) {
      const now = nowMs();
      for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
      while (cache.size > 5_000) cache.delete(cache.keys().next().value);
    }
    return results;
  }

  return async function audit(dependencies) {
    const result = [];
    for (let offset = 0; offset < dependencies.length; offset += batchSize) {
      const chunk = dependencies.slice(offset, offset + batchSize);
      result.push(...await queryChunk(chunk));
    }
    return result;
  };
}

export const auditLimits = {
  maxDependencies: MAX_DEPENDENCIES_DEFAULT,
  maxLockfileChars: MAX_LOCKFILE_CHARS,
  allowedEcosystems: [...ALLOWED_ECOSYSTEMS],
};
