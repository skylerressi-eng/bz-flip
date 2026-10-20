#!/usr/bin/env node
// Build fusions.json: every Attribute Shard fusion recipe, from the wiki-maintained
// SkyShards data (skyblock-wiki/SkyShards-Parser-Wiki, MIT), in a compact form.
//
//   node scripts/fusions.mjs --out site/data [--prev https://you.github.io/bz-flip/data/fusions.json] [--max-age-hours 24]
//
// Output: { v: 1, at, source,
//           shards:  { C1: { id: "SHARD_GROVE", name, rarity, family, type, fuse } },
//           recipes: { C1: { "2": "C4,U1;C4,U2;..." } } }   // output -> output qty -> "A,B" pairs
// A fusion consumes `fuse` of each input shard and yields the output quantity
// (more with the Crocodile bonus when an input is a Reptile).

import fs from "node:fs/promises";
import path from "node:path";

const SOURCE = "https://raw.githubusercontent.com/skyblock-wiki/SkyShards-Parser-Wiki/master/dist/fusion-data.json";
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const outDir = args.out || "data";
const maxAgeMs = Number(args["max-age-hours"] ?? 24) * 3600e3;

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
}

export function compactFusionData(raw) {
  const shards = {};
  for (const [code, s] of Object.entries(raw.shards || {})) {
    shards[code] = {
      id: s.internal_id,
      name: s.name,
      rarity: s.rarity,
      family: (s.family || "").replace(/ Family$/, ""),
      type: s.type,
      fuse: s.fuse_amount || 1,
    };
  }
  const recipes = {};
  for (const [out, byQty] of Object.entries(raw.recipes || {})) {
    if (!shards[out]) continue;
    recipes[out] = {};
    for (const [qty, pairs] of Object.entries(byQty)) {
      const ok = pairs.filter(([a, b]) => shards[a] && shards[b]);
      if (ok.length) recipes[out][qty] = ok.map(([a, b]) => `${a},${b}`).join(";");
    }
  }
  return { shards, recipes };
}

async function main() {
  if (args.prev) {
    try {
      const prev = /^https?:/.test(args.prev) ? await getJson(args.prev, 2) : JSON.parse(await fs.readFile(args.prev, "utf8"));
      if (prev?.v === 1 && Date.now() - prev.at < maxAgeMs) {
        await write(prev);
        console.log(`fusions.json reused (built ${new Date(prev.at).toISOString()})`);
        return;
      }
    } catch (err) {
      console.warn(`No reusable fusions (${err.message}); rebuilding.`);
    }
  }
  const data = compactFusionData(await getJson(SOURCE));
  const pairs = Object.values(data.recipes).reduce((n, r) => n + Object.values(r).reduce((m, s) => m + s.split(";").length, 0), 0);
  if (Object.keys(data.shards).length < 100 || pairs < 1000) throw new Error(`Fusion data looks incomplete (${Object.keys(data.shards).length} shards, ${pairs} recipes)`);
  await write({ v: 1, at: Date.now(), source: "skyblock-wiki/SkyShards-Parser-Wiki", ...data });
  console.log(`fusions.json: ${Object.keys(data.shards).length} shards, ${pairs} recipes`);
}

async function write(data) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "fusions.json"), JSON.stringify(data));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
