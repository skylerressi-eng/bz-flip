# BZ Flip: Hypixel SkyBlock Bazaar Flipper

A fast, dependency-free website that scans **every product and craft on the Hypixel SkyBlock bazaar**, works out the after-tax margin, volume, competition and risk of each flip, ranks them, and plans how to spread your coins across them. Prices come live from the Hypixel API every minute; a GitHub Action also records hourly price history for charts and manipulation detection.

## Features

- **Live data:** refreshes every minute by default (30s–1h is configurable) and shows how old Hypixel's snapshot is, with a warning if the API falls behind. It pauses while the tab is hidden, and prices that changed flash green or red.
- **Seven rankings:** Best flips (risk-adjusted profit/hr), Highest margin, Highest volume, Margin × volume, NPC flips, **Craft flips**, and your ★ Watchlist.
- **Craft flips:** recipes from the [NotEnoughUpdates repo](https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO), refreshed daily. Shows both patient (buy orders → sell offer) and instant (insta-buy → insta-sell) profit, crafts/hr limited by every ingredient's volume, and the collection level each recipe needs.
- **Flip planner:** enter your coins and it allocates them across the best flips. It sizes each order to about an hour of volume, caps how much goes into one item, and respects your order slots (14, 21 or 28 with Bazaar Flipper). One click copies the plan.
- **Mayor-aware tax:** reads the live election API, applies Derpy's QUAD TAXES automatically, and shows any other perk that touches bazaar tax.
- **Correct bazaar math:** buy order at best bid + 0.1, sell offer at best ask − 0.1, and sell tax of 1.25%, 1.125% or 1% (Bazaar Flipper I/II). Volume is the slower of the 7-day instant-buys and instant-sells.
- **Risk flags:** dead/lowball spreads, illiquid items, one-sided markets, crowded order books, price spikes against recent history (manipulation), and NPC price floors.
- **Item panel:** step-by-step flip instructions with copy buttons (including the `/bz` command), fill-time estimates, the craft recipe, a price-history chart, and the top 10 levels of the order book.
- **Watchlist alerts:** get a notification when a starred item's margin reaches your target.
- 24h sparklines, rank movement, real item icons, search, category filter, sortable columns, keyboard shortcuts (`/`, `R`, `1`–`7`, `Esc`), light/dark themes, and a mobile layout.

## API key?

None needed. The bazaar (`/v2/skyblock/bazaar`) and items (`/v2/resources/skyblock/items`) endpoints are **public**. **Never commit an API key or put one in a website:** anyone can read it and get it revoked. If you want the hourly job to send a key anyway, add it as a repository secret named `HYPIXEL_API_KEY` (Settings → Secrets and variables → Actions).

## Run locally

```bash
npm start           # serves on http://localhost:8080 (any static server works)
npm test            # unit tests for the flip, craft, planner and history math
npm run data        # optional: build data/history.json + data/recipes.json locally
npm run recipes     # refresh the bundled fallback recipes in assets/data
```

## Deploy (free, with the hourly recheck)

1. Make sure this code is on the repo's **default branch** (scheduled workflows only run there).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Go to **Actions → Hourly bazaar snapshot + deploy → Run workflow** once. After that it runs every hour by itself (and on every push to `main`). Each run:
   - runs the tests,
   - fetches the bazaar and appends a snapshot to `data/history.json` (a rolling 4 days, chained from the previously deployed copy, so nothing is committed),
   - rebuilds `data/recipes.json` from the NEU repo once a day (the site falls back to `assets/data/recipes.json` if that fails),
   - deploys the site to `https://<user>.github.io/bz-flip/`.

GitHub pauses scheduled workflows after 60 days with no repo activity. Re-enable it from the Actions tab if that happens.

## How the score works

```
margin        = sellOffer × (1 − tax) − buyOrder
volume/hr     = min(instaSellsWeek, instaBuysWeek) / 168
units/hr      = min(volume/hr × yourShare, budget / buyOrder, 71,680)
profit/hr     = margin × units/hr
confidence    = liquidity × spreadSanity × (1 − competition/2) × buySellBalance × priceStability
score (0–100) = 100 × sqrt(profit/hr × confidence ÷ best in market)
```

The analysis lives in `assets/js/analysis.js` (pure functions, shared with the tests).

## Project layout

```
index.html                 page shell
assets/css/styles.css      styles (dark and light themes)
assets/js/analysis.js      flip + craft math, flags, rankings, planner, mayor effects
assets/js/history.js       compact hourly price history
assets/js/app.js           UI, auto-refresh, drawer
assets/js/chart.js         SVG price chart
assets/js/format.js        number formatting
scripts/snapshot.mjs       hourly price snapshot job
scripts/recipes.mjs        daily recipe extractor (NEU repo)
assets/data/recipes.json   bundled fallback recipes
tests/                     node:test unit tests
```

Not affiliated with Hypixel. Bazaar prices move constantly, so check the in-game order book before committing coins.
