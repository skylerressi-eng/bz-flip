# BZ Flip: Hypixel SkyBlock Bazaar Flipper

A fast, dependency-free website that scans **every product on the Hypixel SkyBlock bazaar**, works out the after-tax margin, volume, competition and risk of flipping each one, and ranks them. It rechecks automatically every hour (you can set it to 1, 5, 15 or 30 minutes), and a GitHub Action records hourly price history for charts and manipulation detection.

## Features

- **Six rankings:** Best flips (risk-adjusted profit/hr), Highest margin, Highest volume, Margin × volume, NPC flips, and your ★ Watchlist.
- **Realistic profit/hr** based on your budget, your expected share of the volume, and the 71,680-item order cap.
- **Correct bazaar math:** buy order at best bid + 0.1, sell offer at best ask − 0.1, sell tax of 1.25%, 1.125% or 1% (Bazaar Flipper upgrades).
- **Volume from 7-day trade data:** the slower of instant-buys and instant-sells per hour, because a flip is only as fast as its slow leg.
- **Risk flags:** dead/lowball spreads, illiquid items, one-sided markets, crowded order books, price spikes against recent history (manipulation), and NPC price floors.
- **Item detail panel:** step-by-step flip instructions with copy-to-clipboard prices, fill-time estimates, a price-history chart, and the top 10 levels of the order book.
- Rank movement since the last check, search, category filter, column sorting, light/dark theme, and a mobile layout.
- Settings and the watchlist are saved in your browser.

## API key?

None needed. The bazaar (`/v2/skyblock/bazaar`) and items (`/v2/resources/skyblock/items`) endpoints are **public**. **Never commit an API key or put one in a website:** anyone can read it and get it revoked. If you want the hourly job to send a key anyway, add it as a repository secret named `HYPIXEL_API_KEY` (Settings → Secrets and variables → Actions).

## Run locally

```bash
npm start           # serves on http://localhost:8080 (any static server works)
npm test            # unit tests for the flip math and history
```

## Deploy (free, with the hourly recheck)

1. Make sure this code is on the repo's **default branch** (scheduled workflows only run there).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Go to **Actions → Hourly bazaar snapshot + deploy → Run workflow** once. After that it runs every hour by itself (and on every push to `main`). Each run:
   - runs the tests,
   - fetches the bazaar and appends a snapshot to `data/history.json` (a rolling 4 days, chained from the previously deployed copy, so nothing is committed),
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
assets/js/analysis.js      flip math, flags, rankings
assets/js/history.js       compact hourly price history
assets/js/app.js           UI, auto-refresh, drawer
assets/js/chart.js         SVG price chart
assets/js/format.js        number formatting
scripts/snapshot.mjs       hourly snapshot job
tests/                     node:test unit tests
```

Not affiliated with Hypixel. Bazaar prices move constantly, so check the in-game order book before committing coins.
