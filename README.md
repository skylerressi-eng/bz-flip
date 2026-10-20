# BZ Flip: Hypixel SkyBlock Bazaar Flipper

A fast, dependency-free website that scans **every product and craft on the Hypixel SkyBlock bazaar**, works out the after-tax margin, volume, competition and risk of each flip, ranks them, and plans how to spread your coins across them. Prices come live from the Hypixel API every minute; a GitHub Action also records hourly price history for charts and manipulation detection.

## Features

- **Live data:** refreshes every minute by default (30s–1h is configurable) and shows how old Hypixel's snapshot is, with a warning if the API falls behind. It pauses while the tab is hidden, and prices that changed flash green or red.
- **Eight rankings:** Best flips (risk-adjusted profit/hr), Highest margin, Highest volume, Margin × volume, NPC flips, **Craft flips**, **Fusion flips**, and your ★ Watchlist.
- **Fusion flips:** all 131k Attribute Shard fusion recipes from the wiki-maintained [SkyShards data](https://github.com/skyblock-wiki/SkyShards-Parser-Wiki) (refreshed daily). Finds the cheapest profitable recipe for every shard at live prices, with fuse amounts, output counts and the Crocodile bonus for Reptile inputs, plus alternative recipes. **Track a fusion** in My flips: it watches both input buy orders for outbids, then your output sell offer for undercuts.
- **Craft flips:** recipes from the [NotEnoughUpdates repo](https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO), refreshed daily. Shows both patient (buy orders → sell offer) and instant (insta-buy → insta-sell) profit, crafts/hr limited by every ingredient's volume, and the collection level each recipe needs.
- **Flip planner:** enter your coins and it allocates them across the best flips. It sizes each order to about an hour of volume, caps how much goes into one item, and respects your order slots (14, 21 or 28 with Bazaar Flipper). One click copies the plan.
- **Mayor-aware tax:** reads the live election API, applies Derpy's QUAD TAXES automatically, and shows any other perk that touches bazaar tax.
- **Correct bazaar math:** buy order at best bid + 0.1, sell offer at best ask − 0.1, and sell tax of 1.25%, 1.125% or 1% (Bazaar Flipper I/II). Volume is the slower of the 7-day instant-buys and instant-sells.
- **Accurate profit/hr:** coins are tied up until both the buy order and the sell offer fill, so profit/hr is profit per flip divided by the full cycle time. Your share of volume is estimated from how many competing orders sit at the top of the book.
- **7-day history check:** the top items are compared against Coflnet's 7-day price history, so temporary or manipulated margins are discounted and steady ones are marked ✓.
- **Risk flags:** dead/lowball spreads, illiquid items, one-sided markets, crowded order books, price spikes against recent history (manipulation), and NPC price floors.
- **Item panel:** step-by-step flip instructions with copy buttons (including the `/bz` command), fill-time estimates, the craft recipe, a price-history chart, and the top 10 levels of the order book.
- **My flips tracker:** log the orders you placed (one click from any item, or “Track all” from the planner). Every refresh checks the live order book and tells you when you've been **outbid or undercut**, with the exact relist price (and a warning when relisting would go below break-even). It sends a browser notification, shows ⚠ in the tab title, and keeps your real profit for the last 24h and all time.
- **Watchlist alerts:** get a notification when a starred item's margin reaches your target.
- 7-day sparklines, break-even and dump-loss prices, rank movement, real item icons, search, category filter, sortable columns, keyboard shortcuts (`/`, `R`, `1`–`8`, `Esc`), light/dark themes, and a mobile layout.

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
   - rebuilds `data/recipes.json` (NEU) and `data/fusions.json` (SkyShards) once a day (the site falls back to the copies in `assets/data/` if that fails),
   - deploys the site to `https://<user>.github.io/bz-flip/`.

GitHub pauses scheduled workflows after 60 days with no repo activity. Re-enable it from the Actions tab if that happens.

## How the math works

```
buyAt         = best buy order + 0.1          sellAt = best sell offer − 0.1
margin        = sellAt × (1 − tax) − buyAt    (tax × 4 while Derpy is mayor)
your share    = 1 / (competing orders within 1% of the top + 1)   ("Auto"; or a fixed %)
buy fill rate = instant-sells/hr × share      sell fill rate = instant-buys/hr × share
order size    = min(budget / buyAt, ~2h of buy fills, 71,680 items, 1B coins of sell offers)
cycle time    = size / buy rate + size / sell rate + 6 min to claim & relist
profit/hr     = margin × size / cycle time
confidence    = liquidity × spread sanity × competition × buy/sell balance × price stability × 7-day normalcy
score (0–100) = 100 × sqrt(profit/hr × confidence ÷ best in market)
```

The top ~30 items are checked against 7-day history from [Coflnet](https://sky.coflnet.com). A margin far above the item's normal margin is flagged "Above normal" and discounted; one that matches is flagged "Steady margin" and gets a ✓.

The analysis lives in `assets/js/analysis.js` (pure functions, shared with the tests).

## Project layout

```
index.html                 page shell
assets/css/styles.css      styles (dark and light themes)
assets/js/analysis.js      flip + craft math, flags, rankings, planner, mayor effects
assets/js/history.js       compact hourly price history
assets/js/app.js           UI, auto-refresh, drawer
assets/js/tracker.js       “My flips” outbid/undercut checks and profit totals
assets/js/chart.js         SVG price chart
assets/js/format.js        number formatting
scripts/snapshot.mjs       hourly price snapshot job
scripts/recipes.mjs        daily recipe extractor (NEU repo)
scripts/fusions.mjs        daily shard fusion data (SkyShards wiki parser)
assets/data/recipes.json   bundled fallback recipes
assets/data/fusions.json   bundled fallback fusion recipes
tests/                     node:test unit tests
```

Not affiliated with Hypixel. Bazaar prices move constantly, so check the in-game order book before committing coins.
