# PatchSignal — Dependency risk, ready for agents

PatchSignal is a small paid API for AI coding agents and developer automation. Send an npm `package-lock.json`, pinned Python `requirements.txt`, or a normalized list of exact package versions. It queries [OSV.dev](https://osv.dev/) and returns machine-readable vulnerability IDs, aliases, source URLs, upstream severity where supplied, and known fixed versions.

The API is intentionally deterministic: there is no LLM bill, no generated security claim, and no API key needed for the OSV query. The paid route uses the official x402 SDK middleware, which verifies and settles payment through a facilitator. It does **not** trust a random `X-Payment` header.

> **Reality check:** this is a product prototype, not guaranteed income. x402 traffic is concentrated among already-known services and discovery is still evolving. A clean deployment can receive zero paid calls until agents find it and choose it. Read `DEPLOYMENT.md` before turning on mainnet payments.

## Included

- Official x402 v2 Express middleware (`@x402/express`, `@x402/core`, `@x402/evm`, `@x402/extensions`).
- Bazaar metadata on the paid audit endpoint to make the API easier for agents and supported facilitators to index.
- `GET /health`, `GET /openapi.json`, `GET /llms.txt`, and a small public landing page.
- `POST /v1/audit` supports npm lockfiles, pinned Python requirements, and normalized dependency lists across selected ecosystems.
- Bounded request size and dependency count, rate limits, input checks before payment middleware, upstream timeouts, short in-memory caching, and structured errors.
- Automated parser/report/cache tests using Node's built-in test runner.

## Requirements

- Node.js 20 or newer.
- An EVM-compatible receive address that you control for paid deployment.
- A production facilitator that supports the network you choose. The sample uses the public x402 facilitator for **testnet only**. For a simple mainnet path, this project is configured in the deployment guide for the PayAI facilitator; verify its current terms, network support and limits before relying on it.

## Run locally

1. Install Node.js 20+ if it is not already installed.
2. Open a terminal in this folder and run `npm install`.
3. Copy `.env.example` to `.env`.
4. Keep `PAYMENTS_ENABLED=false` for a local free test. Never commit the `.env` file.
5. Run `npm test`.
6. Run `npm start`.
7. Open `http://localhost:4021` and `http://localhost:4021/health`.

Example request with payments disabled:

```bash
curl -X POST http://localhost:4021/v1/audit \
  -H "Content-Type: application/json" \
  -d '{"format":"dependencies","dependencies":[{"name":"lodash","version":"4.17.19","ecosystem":"npm"}]}'
```

The request checks the package against OSV.dev, so it needs an internet connection. The example response is not hard-coded.

## API inputs

### npm lockfile

```json
{
  "format": "npm-lock",
  "lockfile": {
    "lockfileVersion": 3,
    "packages": {
      "": { "name": "example-project" },
      "node_modules/lodash": { "version": "4.17.19" }
    }
  }
}
```

You can send `lockfile` as a JSON object or as a JSON string. Real scans should use the actual `package-lock.json`; the small object above is only a demo.

### Python requirements

```json
{
  "format": "requirements",
  "lockfile": "requests==2.31.0\nDjango==4.2.0"
}
```

Only exact pinned versions are checked. Ranges such as `requests>=2` are deliberately skipped rather than guessed.

### Normalized packages

```json
{
  "format": "dependencies",
  "dependencies": [
    { "name": "lodash", "version": "4.17.19", "ecosystem": "npm" },
    { "name": "requests", "version": "2.31.0", "ecosystem": "PyPI" }
  ]
}
```

Supported ecosystem labels are `npm`, `PyPI`, `Go`, `Maven`, `crates.io`, `Packagist`, `RubyGems`, and `NuGet`. The current parser natively extracts npm package-lock v1-v3 and exact pinned Python requirements; other ecosystems can use the normalized format.

## Endpoints

| Method | Path | Payment | Purpose |
|---|---|---|---|
| GET | `/` | Free | Landing page and usage overview |
| GET | `/health` | Free | Host health check |
| GET | `/openapi.json` | Free | Machine-readable API definition |
| GET | `/llms.txt` | Free | Text guide for agent builders |
| POST | `/v1/audit` | x402 when enabled | Audit dependency versions |

Payments are **disabled unless `PAYMENTS_ENABLED=true` is explicitly set**, so the first Render deployment can start before you have added the wallet. Do not leave payments disabled on a public service if your goal is to charge for audits. Default price is `$0.005` USDC per request, configurable by `AUDIT_PRICE`. A request can include up to 250 unique dependencies by default, configurable with `MAX_DEPENDENCIES`.

## Security notes

- Do not put a wallet private key, seed phrase, CDP secret, or other signing secret in this API server. A receive address is public; it is not a secret.
- This API does not download repositories or arbitrary URLs, so it avoids turning a scanner into an SSRF/open-proxy service.
- Do not submit private package names or proprietary code if that information is sensitive.
- An upstream OSV outage can occur after a payment has been settled. The API returns `502` and a request ID; there is no automatic refund mechanism in this prototype.
- Audit output is an aid, not a security guarantee. Advisory databases can be incomplete or delayed, and results are not a substitute for a full security review.

## Deploy

Follow `DEPLOYMENT.md` exactly. It contains the beginner-friendly GitHub + Render instructions, environment variables, mainnet settings, and first live checks.
