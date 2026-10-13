import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware } from '@x402/express';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { buildAuditReport, createOsvAuditor, InputError, parseAuditInput } from './audit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'PatchSignal Dependency Audit API',
    version: '1.0.0',
    description: 'Deterministic vulnerability checks for exact dependency versions using OSV.dev. The audit endpoint accepts a verified x402 micropayment when payments are enabled.',
  },
  servers: [{ url: 'https://YOUR-DEPLOYED-DOMAIN' }],
  paths: {
    '/health': { get: { summary: 'Health check', responses: { '200': { description: 'Service is healthy' } } } },
    '/v1/audit': {
      post: {
        summary: 'Audit dependency versions',
        description: 'Accepts an npm package-lock v1-v3 JSON document, a pinned Python requirements file, or a normalized dependency list. Returns OSV advisories and source links. x402 price applies when payments are enabled.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { type: 'object', required: ['format', 'lockfile'], properties: { format: { const: 'npm-lock' }, lockfile: { oneOf: [{ type: 'string' }, { type: 'object' }] } } },
                  { type: 'object', required: ['format', 'lockfile'], properties: { format: { const: 'requirements' }, lockfile: { type: 'string' } } },
                  { type: 'object', required: ['format', 'dependencies'], properties: { format: { const: 'dependencies' }, dependencies: { type: 'array', maxItems: 250, items: { type: 'object', required: ['name', 'version', 'ecosystem'], properties: { name: { type: 'string' }, version: { type: 'string' }, ecosystem: { type: 'string', enum: ['npm', 'PyPI', 'Go', 'Maven', 'crates.io', 'Packagist', 'RubyGems', 'NuGet'] } } } } } },
                ],
              },
              examples: {
                npm: { summary: 'npm lockfile', value: { format: 'npm-lock', lockfile: { lockfileVersion: 3, packages: { '': { name: 'demo' }, 'node_modules/lodash': { version: '4.17.19' } } } } },
                python: { summary: 'Pinned Python requirements', value: { format: 'requirements', lockfile: 'requests==2.31.0\nDjango==4.2.0' } },
                normalized: { summary: 'Normalized dependencies', value: { format: 'dependencies', dependencies: [{ name: 'lodash', version: '4.17.19', ecosystem: 'npm' }] } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Dependency audit report' },
          '400': { description: 'Invalid request' },
          '402': { description: 'Payment required; use a compatible x402 client' },
          '413': { description: 'Request exceeds service limits' },
          '429': { description: 'Rate limit reached' },
          '502': { description: 'Vulnerability data source unavailable' },
        },
      },
    },
  },
};

function isValidEvmAddress(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function validateAuditBody(req, res, next, maxDependencies) {
  try {
    parseAuditInput(req.body, maxDependencies);
    next();
  } catch (error) {
    const status = error instanceof InputError ? error.status : 400;
    res.status(status).json({
      error: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : 'Invalid request body.',
    });
  }
}

export function createApp({
  env = process.env,
  paymentsEnabled = env.PAYMENTS_ENABLED === 'true',
  auditor = createOsvAuditor({
    timeoutMs: Number(env.OSV_TIMEOUT_MS || 12_000),
    cacheTtlMs: Number(env.OSV_CACHE_TTL_SECONDS || 300) * 1000,
  }),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: env.NODE_ENV === 'production' ? '1h' : 0 }));

  const perMinute = Math.max(10, Number(env.RATE_LIMIT_PER_MINUTE || 120));
  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Too many requests. Wait a minute and try again.' },
  });
  app.use('/v1', apiLimiter);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'patchsignal-api', version: '1.0.0' }));
  app.get('/openapi.json', (_req, res) => {
    const spec = structuredClone(OPENAPI);
    const baseUrl = env.PUBLIC_BASE_URL;
    if (baseUrl) spec.servers[0].url = baseUrl.replace(/\/$/, '');
    else spec.servers[0].url = 'https://YOUR-DEPLOYED-DOMAIN';
    res.json(spec);
  });
  app.get('/llms.txt', (_req, res) => {
    res.type('text/plain').send([
      '# PatchSignal API',
      '',
      '> Deterministic package vulnerability audits for AI coding agents.',
      '',
      '## Endpoints',
      '- GET /health: free health check.',
      '- GET /openapi.json: machine-readable API schema.',
      '- POST /v1/audit: checks exact dependency versions against OSV.dev. Supports format=npm-lock, format=requirements, or format=dependencies. This endpoint requires x402 payment when payments are enabled.',
      '',
      '## Important',
      '- Use package-lock.json rather than package.json so exact installed versions are checked.',
      '- Result data comes from OSV.dev and can be incomplete or delayed.',
      '- Never submit secrets, private package names, or proprietary source code.',
    ].join('\n'));
  });

  // Validate obvious client mistakes BEFORE payment middleware runs, so malformed calls are not charged.
  app.post('/v1/audit', (req, res, next) => validateAuditBody(req, res, next, Number(env.MAX_DEPENDENCIES || 250)), (_req, _res, next) => next());

  if (paymentsEnabled) {
    const payTo = env.PAY_TO_ADDRESS;
    if (!isValidEvmAddress(payTo) || /^0x0{40}$/i.test(payTo)) {
      throw new Error('PAY_TO_ADDRESS must be your own valid, non-zero EVM receive address. Do not use the placeholder in .env.example.');
    }
    const network = env.X402_NETWORK || 'eip155:8453';
    const facilitatorUrl = env.X402_FACILITATOR_URL || 'https://facilitator.payai.network';
    const price = env.AUDIT_PRICE || '$0.005';
    const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
    const resourceServer = new x402ResourceServer(facilitator);
    resourceServer.register('eip155:*', new ExactEvmScheme());

    const discovery = declareDiscoveryExtension({
      input: {
        format: 'npm-lock',
        lockfile: { lockfileVersion: 3, packages: { '': { name: 'example-project' }, 'node_modules/lodash': { version: '4.17.19' } } },
      },
      inputSchema: {
        type: 'object',
        required: ['format', 'lockfile'],
        properties: {
          format: { type: 'string', enum: ['npm-lock', 'requirements', 'dependencies'], description: 'Input format. Use npm-lock for package-lock.json.' },
          lockfile: { type: ['string', 'object'], description: 'The exact lockfile or pinned requirements content.' },
          dependencies: { type: 'array', description: 'For format=dependencies, exact name/version/ecosystem records.' },
        },
      },
      output: {
        example: {
          status: 'ok',
          summary: { dependenciesScanned: 1, packagesWithVulnerabilities: 1, vulnerabilitiesFound: 1, highestSeverity: 'HIGH', clean: false },
          packages: [{ name: 'lodash', version: '4.17.19', ecosystem: 'npm', vulnerable: true, vulnerabilityCount: 1 }],
        },
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            requestId: { type: 'string' },
            generatedAt: { type: 'string' },
            summary: { type: 'object' },
            packages: { type: 'array' },
            limitations: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    });

    const routes = {
      'POST /v1/audit': {
        accepts: { scheme: 'exact', price, network, payTo },
        description: 'Audit exact npm or Python dependency versions against OSV.dev. Returns structured vulnerability IDs, severity labels where supplied, fix versions, and source links.',
        mimeType: 'application/json',
        resource: {
          url: `${(env.PUBLIC_BASE_URL || 'https://YOUR-DEPLOYED-DOMAIN').replace(/\/$/, '')}/v1/audit`,
          description: 'Deterministic dependency vulnerability scan for AI coding agents',
          mimeType: 'application/json',
          serviceName: 'PatchSignal',
          tags: ['security', 'dependencies', 'vulnerabilities', 'developer-tools', 'npm'],
        },
        extensions: { ...discovery },
      },
    };
    app.use(paymentMiddleware(routes, resourceServer));
  }

  app.post('/v1/audit', async (req, res) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const dependencies = parseAuditInput(req.body, Number(env.MAX_DEPENDENCIES || 250));
      const results = await auditor(dependencies);
      const report = buildAuditReport(dependencies, results, { requestId });
      report.meta = { durationMs: Date.now() - startedAt, cacheTtlSeconds: Number(env.OSV_CACHE_TTL_SECONDS || 300) };
      res.set('Cache-Control', 'no-store');
      res.json(report);
    } catch (error) {
      if (error instanceof InputError) {
        return res.status(error.status).json({ error: 'INVALID_REQUEST', message: error.message, requestId });
      }
      console.error(JSON.stringify({ event: 'audit_failed', requestId, message: error?.message || 'Unknown error' }));
      return res.status(502).json({
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'The vulnerability database could not complete this scan. Please retry later.',
        requestId,
      });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Endpoint not found. Visit / for API documentation.' });
  });

  app.use((error, _req, res, _next) => {
    const status = error?.type === 'entity.too.large' ? 413 : error?.type === 'entity.parse.failed' ? 400 : 500;
    const message = status === 413 ? 'Request body exceeds the 1 MB limit.' : status === 400 ? 'Request body is not valid JSON.' : 'Unexpected server error.';
    if (status === 500) console.error('Unhandled request error:', error?.message || error);
    res.status(status).json({ error: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message });
  });

  return app;
}
