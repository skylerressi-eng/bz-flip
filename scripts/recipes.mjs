#!/usr/bin/env node
// Build data/recipes.json: crafting recipes for bazaar items whose ingredients
// are all on the bazaar too, taken from the community NotEnoughUpdates repo.
//
//   node scripts/recipes.mjs --out site/data [--prev https://you.github.io/bz-flip/data/recipes.json] [--max-age-hours 24]
//
// Recipes rarely change, so if the previous file is fresh enough it is reused
// instead of re-downloading ~2,000 item files.

import fs from "node:fs/promises";
import path from "node:path";

const NEU = "https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/items";
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const outDir = args.out || "data";
const maxAgeMs = Number(args["max-age-hours"] ?? 24) * 3600e3;

async function getJson(url, { tries = 3, allow404 = false } = {}) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (allow404 && res.status === 404) return null;
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
}

// NEU writes variants as INK_SACK-3; the bazaar uses INK_SACK:3.
const toBazaarId = (neuId) => neuId.replace(/-(\d+)$/, ":$1");
const toNeuId = (bzId) => bzId.replace(/:(\d+)$/, "-$1");

// "DIAMOND:32" -> ["DIAMOND", 32]
function parseSlot(slot) {
  if (!slot) return null;
  const i = slot.lastIndexOf(":");
  if (i < 0) return [slot, 1];
  return [slot.slice(0, i), Number(slot.slice(i + 1)) || 1];
}

export function extractRecipes(item, isBazaar) {
  const grids = [];
  if (item.recipe && typeof item.recipe === "object") grids.push({ ...item.recipe, count: item.recipe.count });
  for (const r of item.recipes || []) if (!r.type || r.type === "crafting") grids.push(r);
  const out = [];
  for (const g of grids) {
    const inputs = {};
    let ok = true;
    for (const k of ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"]) {
      const s = parseSlot(g[k]);
      if (!s) continue;
      const id = toBazaarId(s[0]);
      if (!isBazaar(id)) { ok = false; break; }
      inputs[id] = (inputs[id] || 0) + s[1];
    }
    if (!ok || !Object.keys(inputs).length) continue;
    const key = JSON.stringify(inputs);
    if (out.some((r) => JSON.stringify(r.in) === key)) continue;
    out.push({ in: inputs, out: Number(g.count) || 1 });
  }
  return out;
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function main() {
  if (args.prev) {
    try {
      const prev = /^https?:/.test(args.prev) ? await getJson(args.prev, { tries: 2 }) : JSON.parse(await fs.readFile(args.prev, "utf8"));
      if (prev?.v === 1 && Date.now() - prev.at < maxAgeMs) {
        await write(prev);
        console.log(`recipes.json reused (${Object.keys(prev.recipes).length} items, built ${new Date(prev.at).toISOString()})`);
        return;
      }
    } catch (err) {
      console.warn(`No reusable recipes (${err.message}); rebuilding.`);
    }
  }

  const bazaar = await getJson("https://api.hypixel.net/v2/skyblock/bazaar");
  const ids = Object.keys(bazaar.products).filter((id) => !id.startsWith("ENCHANTMENT_") && !id.startsWith("ESSENCE_"));
  const isBazaar = (id) => !!bazaar.products[id];
  const recipes = {};
  const reqs = {};
  let fetched = 0, missing = 0;
  await pool(ids, 24, async (id) => {
    const item = await getJson(`${NEU}/${encodeURIComponent(toNeuId(id))}.json`, { allow404: true }).catch(() => null);
    if (!item) { missing++; return; }
    fetched++;
    const rs = extractRecipes(item, isBazaar);
    if (rs.length) {
      recipes[id] = rs;
      if (item.crafttext) reqs[id] = item.crafttext.replace(/§./g, "");
    }
  });
  if (fetched < ids.length * 0.5) throw new Error(`Only fetched ${fetched}/${ids.length} NEU items; refusing to publish a partial recipe list`);
  await write({ v: 1, at: Date.now(), source: "NotEnoughUpdates-REPO", recipes, reqs });
  console.log(`recipes.json: ${Object.keys(recipes).length} craftable items (${fetched} fetched, ${missing} not in NEU)`);
}

async function write(data) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "recipes.json"), JSON.stringify(data));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
