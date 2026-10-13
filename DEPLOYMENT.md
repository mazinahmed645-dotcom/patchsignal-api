# Beginner deployment guide: GitHub → Render → x402

This guide assumes you're starting with the downloaded PatchSignal folder and have never deployed this exact API before. You do not need to write code by hand, but you must do the account/setup steps yourself. Do not share your wallet's private key or recovery phrase with me, a coding assistant, GitHub, or Render.

## What you're building

PatchSignal is an API, not a traditional app that needs people to click buttons. An AI coding agent calls `POST /v1/audit`, pays the advertised price through x402 if it supports x402, and receives a structured report from OSV.dev. Listing the API is a discovery step, not a guarantee of traffic or earnings.

## Step 1 — Download and extract the project

1. Download the ZIP attached with this guide.
2. In Windows File Explorer, right-click the ZIP and choose **Extract All**.
3. Keep the extracted `patchsignal-api` folder somewhere easy to find, such as Documents.

## Step 2 — Create a GitHub account or sign in

1. Open [GitHub](https://github.com/) and sign in.
2. Open [GitHub Desktop](https://desktop.github.com/) and install it if you don't already have it.
3. In GitHub Desktop, sign into the same GitHub account.

## Step 3 — Publish the folder to GitHub

1. In GitHub Desktop, choose **File → Add Local Repository**.
2. Select the extracted `patchsignal-api` folder.
3. If GitHub Desktop says it is not a repository yet, choose the option to create a repository there. Use the name `patchsignal-api`.
4. Leave `.env` out of the repository. Only `.env.example` belongs in GitHub. The included `.gitignore` already excludes `.env`.
5. Click **Publish repository**. A public repository makes it easier for other developers to inspect the code; do not add credentials or personal information to it.
6. Open the repository on GitHub in your browser and check that you can see `index.js`, `src/`, `public/`, `package.json`, and `DEPLOYMENT.md`.

## Step 4 — Create a Render web service

1. Open [Render](https://render.com/) and sign in.
2. Choose **New + → Web Service**.
3. Connect GitHub if Render asks, then select `patchsignal-api`.
4. Use these settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/health` (if the field is shown)
5. Choose the free instance for a first smoke test, or a paid always-on instance when you are ready for real use. Free instances may sleep after inactivity, causing slow first responses; agents can stop using slow/unreliable endpoints.
6. Click **Create Web Service**.

Wait for Render's build log to show that the service started successfully. Render will give you a public URL like `https://patchsignal-api-xxxx.onrender.com`. Open that URL and then add `/health`; you should see JSON containing `"status":"ok"`.

## Step 5 — Set up the receive wallet

1. Use a wallet you control that supports receiving USDC on the network you plan to accept.
2. Copy the **public receive address only**. For Base, it normally starts with `0x` and has 42 characters.
3. Never paste your wallet's private key or recovery phrase into the project. This service only needs your public receive address.
4. Confirm that you understand on-chain payments can be irreversible and that facilitator/network fees and tax obligations may apply. If you are not old enough to open or use a wallet under the provider's terms, ask a parent/guardian to help you handle the account requirements.

## Step 6 — Turn on payments for real requests

In Render, open your service and choose **Environment**. Add or update these environment variables:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PAYMENTS_ENABLED` | `true` |
| `PAY_TO_ADDRESS` | Your own public receive address, starting with `0x` |
| `AUDIT_PRICE` | `$0.005` |
| `X402_NETWORK` | `eip155:8453` |
| `X402_FACILITATOR_URL` | `https://facilitator.payai.network` |
| `MAX_DEPENDENCIES` | `250` |
| `RATE_LIMIT_PER_MINUTE` | `120` |
| `OSV_TIMEOUT_MS` | `12000` |
| `OSV_CACHE_TTL_SECONDS` | `300` |

Then set `PUBLIC_BASE_URL` to the exact Render URL from Step 4, without a trailing slash, for example `https://your-service.onrender.com`.

**Important:** `eip155:8453` is Base mainnet (real USDC). Do not switch to mainnet until your receive address is correct and you understand how payments work. This guide uses the PayAI facilitator because its published documentation lists Base support and says no API key is required; review its current terms, fees, rate limits and status before relying on it. If it changes its API, the facilitator configuration may need updating.

For testnet only, use:
- `X402_NETWORK=eip155:84532`
- `X402_FACILITATOR_URL=https://x402.org/facilitator`

Testnet funds are not real revenue. The public `x402.org` facilitator is for testnet development and should not be assumed to handle production mainnet payments.

Click **Save Changes**. Render should redeploy the service. In the logs, confirm it says `Payments: ENABLED` and lists the chosen network.

## Step 7 — Check the live service

Open each of these in your browser, replacing the sample URL with yours:

- `https://YOUR-URL/` — PatchSignal landing page.
- `https://YOUR-URL/health` — should return `status: ok`.
- `https://YOUR-URL/openapi.json` — machine-readable API description.
- `https://YOUR-URL/llms.txt` — short agent-facing instructions.

A plain request to `POST /v1/audit` should now return **HTTP 402 Payment Required** until the caller retries with valid x402 payment proof. That is expected. The service must use the official middleware, not a homemade check for whether a payment header merely exists.

Do not test by making a real payment until you've confirmed the address, network and price. For free local testing, set `PAYMENTS_ENABLED=false` in `.env` and run it on your own computer; don't turn payments off on a public production service if you intend to charge.

## Step 8 — Get discovered by agents

1. Check that `PUBLIC_BASE_URL` is correct; this is included in service metadata.
2. Keep `GET /openapi.json` and `GET /llms.txt` public so coding agents and developer tools can understand the input/output.
3. The route includes x402 Bazaar discovery metadata. The facilitator may index it after a successful settled payment. This depends on the facilitator/catalog, and even an indexed endpoint may receive no calls.
4. Add the service to any relevant x402 directories only where submissions are accepted and do not misrepresent performance. The official x402 project lists community directories such as x402scan and other marketplaces.
5. Share a reproducible sample request in developer communities where this solves a real problem. Don't spam people or fake transactions/clicks; marketplaces and developers need repeat usage and trust.

## Step 9 — Know the revenue maths

At `$0.005` gross per paid audit:

| Paid requests per day | Approximate gross per 30-day month |
|---:|---:|
| 10 | $1.50 |
| 100 | $15 |
| 500 | $75 |
| 1,000 | $150 |
| 5,000 | $750 |

These are arithmetic examples only, not forecasts. Subtract facilitator fees after any free quota, hosting, any rate-limit/usage costs, taxes, and time spent maintaining the service. Zero paid requests means zero revenue. Don't assume agents will automatically call a new endpoint just because it exists.

## Step 10 — Update the code later

1. Make changes in the folder on your computer.
2. Open GitHub Desktop and review the changed files.
3. Write a short summary in **Summary**, then click **Commit to main**.
4. Click **Push origin**.
5. Render normally notices the new GitHub commit and deploys it automatically. Check the deployment log and `/health` after each update.

## If something goes wrong

- **`npm install` fails:** open Render's build log and look at the first dependency error. This project uses official x402 v2 package names and aligned `^2.17.0` ranges; don't replace the payment middleware with a fake header check.
- **Service starts, then exits:** confirm `PAY_TO_ADDRESS` is a valid non-zero public EVM address and that `PAYMENTS_ENABLED` is not `true` with a placeholder address.
- **HTTP 402 appears:** expected for an unpaid request on the paid endpoint. Use an x402-compatible client and a funded wallet on the correct network.
- **Payment fails to settle:** confirm network/facilitator compatibility, public service URL and facilitator status. Mainnet payments are real transfers.
- **`502 UPSTREAM_UNAVAILABLE`:** OSV.dev may be timing out or temporarily unavailable. Check Render logs and the OSV service status before retrying.
- **No paid calls arrive:** first confirm the service is indexed and try an agent/client that actually supports x402. Discovery is not demand. You may need to improve the product or promote it directly to relevant developers.
