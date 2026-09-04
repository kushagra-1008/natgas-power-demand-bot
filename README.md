# U.S. Power → Natural Gas Demand Telegram Bot

A separate trading-intelligence bot that monitors U.S. electricity conditions and estimates whether the U.S. power sector is creating **more or less natural-gas demand**.

## Important data-availability rule

This project is intentionally **not** an ISO-by-ISO dashboard. It first asks Grid Status for its dataset catalog and validates that the required signals are available as genuine U.S.-aggregate datasets.

The current public Grid Status API is organized around datasets for specific markets/ISOs and the public documentation describes coverage across CAISO, ERCOT, PJM, MISO, NYISO, SPP, ISONE, and IESO. The project therefore does **not** silently add ISO-by-ISO summation. When a genuine U.S.-aggregate signal cannot be discovered, the bot reports that signal as unavailable instead of fabricating one.

The production runtime can optionally use an explicitly configured dataset override, but only when its metadata validates as a U.S.-aggregate dataset.

## Required environment variables

```text
GRIDSTATUS_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_ID=
```

Optional:

```text
# Comma-separated dataset IDs discovered/verified by you after catalog inspection.
# Leave blank to use runtime catalog discovery.
GRIDSTATUS_GAS_DATASET=
GRIDSTATUS_LOAD_DATASET=
GRIDSTATUS_WIND_DATASET=
GRIDSTATUS_SOLAR_DATASET=
GRIDSTATUS_OUTAGE_DATASET=
GRIDSTATUS_LOAD_FORECAST_DATASET=

# Default is the user's requested ceiling. The runtime stops new GridStatus
# calls when this monthly budget is reached.
GRIDSTATUS_MONTHLY_REQUEST_LIMIT=1250

# Local SQLite file. On Netlify, use a persistent external volume/store if
# you need persistence across stateless invocations.
DATABASE_PATH=data/power_demand.db

# Optional secret used to protect the scheduled HTTP endpoint.
CRON_SECRET=
```

## Architecture

```text
Grid Status catalog + validated datasets
                ↓
        small, quota-aware fetches
                ↓
          local SQLite history
                ↓
  local 24h / baseline / anomaly calculations
                ↓
     Natural Gas Power Demand signal
                ↓
            Telegram
```

## Polling schedule

The scheduler supports the requested cadence:

- Gas generation: hourly daytime, every 3 hours overnight
- Total load: hourly daytime, every 3 hours overnight
- Wind: every 6 hours
- Solar: 3 daytime observations
- Generation outages: every 6 hours
- Load forecast: every 6 hours

A single invocation can fetch multiple required metrics from already-validated datasets. Historical values are stored locally so the bot compares observations without repeatedly querying old data.

## Monthly API budget

The polling planner has a hard monthly request budget. With six signal fetches, naïve scheduling can become expensive. The application therefore:

1. caches catalog and dataset metadata locally;
2. counts every outbound GridStatus request;
3. coalesces work that falls in the same scheduled window;
4. avoids historical backfills during normal operation;
5. stops before the configured monthly ceiling is exceeded.

Grid Status's current public pricing page states that the Free plan has a lower request allowance than the 1,250 calls in this project configuration. Set `GRIDSTATUS_MONTHLY_REQUEST_LIMIT` to the limit associated with the API key you actually use.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
cp .env.example .env
python -m app.main
```

`app.main` runs one collection cycle and emits a Telegram message only when the signal can be constructed from validated U.S.-aggregate data.

## Netlify

The deployment is designed around a Netlify scheduled function. Netlify invokes the function on schedule; the function then computes which signals are due and performs only the required API calls.

The repository contains `netlify/functions/power-demand.mjs` as a thin Node-compatible scheduled-function entry point. It calls the Python collector through the deployed runtime contract used by your chosen Netlify Python setup. If your Netlify account/runtime does not support Python functions, deploy the same logic behind a small HTTP service and keep the function as the scheduler trigger.

## Safety / trading-intelligence behavior

The bot is intentionally analytical. It reports:

- current gas generation change;
- load change;
- wind and solar changes;
- outage changes;
- load-forecast change;
- a qualitative demand-pressure state;
- direction (`MORE GAS BURN`, `LESS GAS BURN`, or `MIXED`);
- a concise explanation.

It does **not** issue buy/sell recommendations.

## Data attribution

The bot is built around Grid Status data and should retain appropriate Grid Status attribution when the data is republished.
