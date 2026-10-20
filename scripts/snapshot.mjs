#!/usr/bin/env node
// Hourly job: fetch the bazaar, append a price snapshot to the rolling 4-day
// history (96 hourly points), and write it into the site's data dir.
//
//   node scripts/snapshot.mjs --out site/data [--prev https://you.github.io/bz-flip/data/history.json]
//
// The previous history is pulled from the live site so no commits are needed.
// The Bazaar and items endpoints are public and need no API key; if
// HYPIXEL_API_KEY is set it is sent anyway.

import fs from "node:fs/promises";
import path from "node:path";
import { appendSnapshot, isHistory, EMPTY_HISTORY } from "../assets/js/history.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const outDir = args.out || "data";
const headers = process.env.HYPIXEL_API_KEY ? { "API-Key": process.env.HYPIXEL_API_KEY } : {};

async function getJson(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (i - 1)));
    }
  }
}

async function loadPrevious(src) {
  if (!src) return EMPTY_HISTORY();
  try {
    const h = /^https?:/.test(src) ? await getJson(src, 2) : JSON.parse(await fs.readFile(src, "utf8"));
    if (isHistory(h)) return h;
  } catch (err) {
    console.warn(`No previous history (${err.message}); starting fresh.`);
  }
  return EMPTY_HISTORY();
}

const bazaar = await getJson("https://api.hypixel.net/v2/skyblock/bazaar");
if (!bazaar.success) throw new Error("Bazaar API returned success=false");

const history = appendSnapshot(await loadPrevious(args.prev), bazaar, { maxPoints: 96, minFlow: 1 });

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "history.json"), JSON.stringify(history));
console.log(`history.json: ${history.t.length} snapshots, ${Object.keys(history.p).length} products`);
