# U.S. Power → Natural Gas Demand Telegram Bot

A separate trading-intelligence bot that monitors U.S. electricity conditions and estimates whether the U.S. power sector is creating **more or less natural-gas demand**.

## Data policy — no silent ISO aggregation

The bot starts from the Grid Status `/datasets` catalog and validates dataset metadata before use. It accepts a dataset only when Grid Status metadata explicitly identifies U.S./national scope and does not identify an ISO/RTO. It **never sums ISO feeds** to manufacture a U.S. signal.

Grid Status's public product documentation describes 550+ datasets and coverage across the major North American ISOs. If the catalog available to the API key does not contain a genuine U.S.-aggregate dataset for a requested signal, that signal remains `N/A` and is explicitly listed in the Telegram report. citeturn0search0turn0search5

Run `python -m app.main inspect` locally with your API key to perform the real account-specific catalog test. A private API key is required for an authenticated catalog/data test; no secret is stored in this repository.

## Signals

- 🔥 Natural gas generation — hourly 06:00–17:59 America/New_York; every 3h overnight
- ⚡ Total load — same cadence
- 🌬️ Wind generation — every 6h
- ☀️ Solar generation — 08:00, 12:00, 16:00 America/New_York
- 🚨 Generation outages — every 6h
- 🔮 Load forecast — every 6h

The Netlify scheduler fires hourly and decides locally which signals are due. If gas/wind/solar share one fuel-mix dataset, one Grid Status request supplies all of those signals for that tick. The same coalescing is applied to any other shared dataset.

## API budget

The requested ceiling is **1,250 Grid Status API requests/month**. The runtime has a hard request counter and refuses calls once the configured ceiling is reached.

The cadence mathematically requires up to 47 requests/day if all six signals are separate datasets (about 1,457 over a 31-day month), so **the requested cadence can only remain below 1,250 when the Grid Status datasets are shared/coalesced enough**. In the common case where gas/wind/solar come from one aggregate fuel-mix dataset, the schedule is about 40 requests/day, or 1,240 for 31 days, before catalog/metadata discovery. The bot therefore refuses to fake missing aggregate data or exceed the configured cap.

Grid Status currently advertises 250 API requests/month on its Free plan, so verify the actual entitlement on your API key before deployment; this repository defaults to the user's 1,250 setting but lets you lower it with `GRIDSTATUS_MONTHLY_REQUEST_LIMIT`. citeturn0search3

## Environment

Required:

```text
GRIDSTATUS_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_ID=
```

Optional verified dataset IDs:

```text
GRIDSTATUS_GAS_DATASET=
GRIDSTATUS_LOAD_DATASET=
GRIDSTATUS_WIND_DATASET=
GRIDSTATUS_SOLAR_DATASET=
GRIDSTATUS_OUTAGE_DATASET=
GRIDSTATUS_LOAD_FORECAST_DATASET=
```

Optional:

```text
GRIDSTATUS_MONTHLY_REQUEST_LIMIT=1250
DATABASE_PATH=data/power_demand.db
CRON_SECRET=
```

Secrets belong in local `.env` or Netlify environment variables, never Git.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m app.main inspect
python -m app.main --force
```

The authenticated catalog inspection is the first production-data test. It reports every required signal as either a validated U.S.-aggregate dataset or missing/unverified.

## Persistence

Local development uses SQLite (`DATABASE_PATH`) for observations, catalog cache, and API-usage accounting.

Netlify Functions run in an ephemeral runtime, so a normal SQLite file cannot be relied upon across invocations. The scheduled Netlify implementation therefore uses **Netlify Blobs** as its persistent history/usage store. Netlify documents Blobs as persistent key/value storage available from Functions and across new deploys. citeturn5search0

## Netlify deployment

Netlify Scheduled Functions are supported on all plans and run according to UTC cron schedules. The function in `netlify/functions/power-demand.mjs` uses `@hourly`; its own scheduler decides which data is due. citeturn3search0

1. Create a new Netlify site from this repository.
2. Set the required environment variables in the Netlify project settings.
3. Deploy the `main` branch.
4. Confirm `power-demand` appears with a **Scheduled** badge.
5. Use **Run now** in Netlify to perform an end-to-end test before waiting for the next hourly tick. citeturn3search0
6. Netlify Blobs must be available to the site for persistent history.

Netlify environment variables are available to scheduled functions and are intended for securely supplying API keys/tokens. citeturn3search7

## Telegram output

Example shape:

```text
🔥 U.S. POWER → NATGAS

🔥 Gas Generation      +4.8% vs 24h
⚡ Total Load           +2.1% vs 24h
🌬️ Wind                -6.3% vs 24h
☀️ Solar               -11.2% vs 24h
🚨 Generation Outage   +1.4 MW vs 24h
🔮 Load Forecast        +1.8% vs 24h

Demand Pressure: 🟢 HIGH
Direction:        ↑ MORE GAS BURN

Reason:
Higher load and/or weaker renewable supply is increasing gas-burn pressure.
```

The bot is analytical only. **No buy/sell signals are generated.**

## Grid Status API notes

Grid Status documents authentication using the `x-api-key` header and documents dataset queries with `start_time`, `end_time`, and `limit`. It also documents `latest`/`latest_report` behavior for forecast-style datasets. citeturn1search0turn1search1turn1search2

## Repository isolation

This repository is intentionally separate from `natgas-news-intelligence`. No files in the other project are referenced or modified.
