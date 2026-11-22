// metric-api.js: toàn bộ backend của Metric Router Lab trong một file (API client, so sánh venue, watcher, quote checker, JSON API, plugin Vite).
// Dùng: import metricApi from "./metric-api.js"; rồi thêm metricApi() vào plugins của vite.config.js. Cần: npm i viem


// server/vite-plugin.mjs
import fs from "node:fs";

// src/services.mjs
import { parseUnits as parseUnits2 } from "viem";

// src/constants.mjs
var API_BASE = process.env.METRIC_API_URL ?? "https://api.metric.xyz";
var CONTRACTS = {
  router: "0x02201E6f13c41506c7Bb635d7543F98826229aB7",
  // MetricOmmSimpleRouter
  quoter: "0x3B9ea79f482094323d06064E637a7F4528560fcb",
  // MetricOmmSwapQuoter
  dataProvider: "0x9BB15FE2B214E37d19A6c59eE7B132e787FdfB2a",
  poolFactory: "0x2a53833cc95548cf52c7b159110e22D3a9018f32"
};
var Q64 = 1n << 64n;
var MAX_U128 = (1n << 128n) - 1n;
var noPriceLimit = (zeroForOne) => zeroForOne ? 0n : MAX_U128;

// src/metric-api.mjs
var MetricApiError = class extends Error {
  constructor(status, body, url) {
    const detail = typeof body === "object" && body ? body.error ?? body.code ?? JSON.stringify(body) : String(body);
    super(`Metric API ${status} ${url}: ${detail}`);
    this.status = status;
    this.body = body;
    this.code = body?.code;
  }
};
var sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
var MetricClient = class {
  constructor({
    baseUrl = API_BASE,
    apiKey = process.env.METRIC_API_KEY || void 0,
    fetchImpl = globalThis.fetch,
    maxRetries = 3,
    sleep: sleep2 = sleepDefault
  } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.maxRetries = maxRetries;
    this.sleep = sleep2;
  }
  async request(method, path, { query, body } = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== void 0 && v !== null) url.searchParams.set(k, String(v));
    const headers = { Accept: "application/json" };
    if (body !== void 0) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body) });
      if (res.ok) return res.json();
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      const retryable = res.status === 429 || [500, 502, 503].includes(res.status);
      if (retryable && attempt < this.maxRetries) {
        const ra = Number(res.headers?.get?.("retry-after"));
        const waitMs = res.status === 429 && ra > 0 ? Math.min(ra, 30) * 1e3 : 300 * 2 ** attempt;
        await this.sleep(waitMs);
        continue;
      }
      throw new MetricApiError(res.status, parsed, url.pathname);
    }
  }
  chains() {
    return this.request("GET", "/public/v1/chains");
  }
  metadata(chainId, query = {}) {
    return this.request("GET", `/public/v1/evm/${chainId}/metadata`, { query });
  }
  /** Lấy nhiều trang metadata (count tối đa 500 mỗi trang). */
  async listPools(chainId, { maxPools = 500, ...query } = {}) {
    const pools = [];
    let offset = 0;
    while (pools.length < maxPools) {
      const page = await this.metadata(chainId, { count: Math.min(500, maxPools - pools.length), offset, ...query });
      pools.push(...page.data);
      if (page.nextOffset === null || page.nextOffset === void 0) break;
      offset = page.nextOffset;
    }
    return pools;
  }
  bidAsk(chainId, pool, { depth = true } = {}) {
    return this.request("GET", `/public/v1/evm/${chainId}/${pool}/bid_ask`, { query: { depth } });
  }
  /** Tối đa 100 pool mỗi request; tự chia lô. Trả về mảng `results` theo thứ tự đầu vào (đã khử trùng lặp). */
  async bidAskBatch(chainId, pools, { depth = true, chunk = 100 } = {}) {
    const unique = [...new Set(pools.map((p) => p.toLowerCase()))];
    const results = [];
    for (let i = 0; i < unique.length; i += chunk) {
      const res = await this.request("POST", `/public/v1/evm/${chainId}/bid_ask/batch`, {
        body: { pools: unique.slice(i, i + chunk), depth }
      });
      results.push(...res.results);
    }
    return results;
  }
  /** body: { tokenIn, tokenOut, amountIn | amountOut, tradeType?, maxRoutes?, poolAddress? } (amount là raw, dạng chuỗi) */
  findRoute(chainId, body) {
    return this.request("POST", `/public/v1/evm/${chainId}/route`, { body });
  }
};
var isRoutable = (pool) => pool.priceProviderStatus === "healthy" && Number(pool.pauseLevel ?? 0) === 0;
function buildTokenIndex(pools) {
  const bySymbol = /* @__PURE__ */ new Map();
  const byAddress = /* @__PURE__ */ new Map();
  for (const p of pools) {
    for (const i of [0, 1]) {
      const address = p[`token${i}`]?.toLowerCase();
      const symbol = p[`token${i}Symbol`];
      const decimals = p[`token${i}Decimals`];
      if (!address || symbol === void 0 || decimals === void 0) continue;
      const tok = { address, symbol, decimals: Number(decimals) };
      if (!byAddress.has(address)) byAddress.set(address, tok);
      if (!bySymbol.has(symbol.toUpperCase())) bySymbol.set(symbol.toUpperCase(), tok);
    }
  }
  return {
    bySymbol,
    byAddress,
    resolve(ref) {
      const t = /^0x[0-9a-fA-F]{40}$/.test(ref) ? byAddress.get(ref.toLowerCase()) : bySymbol.get(ref.toUpperCase());
      if (!t) throw new Error(`Kh\xF4ng t\xECm th\u1EA5y token "${ref}" trong metadata Metric. H\xE3y d\xF9ng \u0111\u1ECBa ch\u1EC9 ho\u1EB7c symbol c\xF3 pool.`);
      return t;
    }
  };
}

// src/math.mjs
import { formatUnits } from "viem";
function humanAmount(raw, decimals) {
  return Number(formatUnits(BigInt(raw), decimals));
}
function execPrice(amountIn, decIn, amountOut, decOut) {
  const i = humanAmount(amountIn, decIn);
  return i === 0 ? NaN : humanAmount(amountOut, decOut) / i;
}
function bpsDiff(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!y) return NaN;
  return (x - y) / y * 1e4;
}
function sideAvailability({ bidAdj, askAdj }) {
  return {
    sellToken0: BigInt(bidAdj) > 0n,
    // trader bán token0 -> dùng bid
    buyToken0: BigInt(askAdj) < MAX_U128
    // trader mua token0 -> dùng ask
  };
}

// src/compare.mjs
import { parseUnits } from "viem";
async function compareVenues({ venues, chainId, tokenIn, tokenOut, amounts }) {
  const rows = [];
  for (const a of amounts) {
    const amountIn = parseUnits(String(a), tokenIn.decimals);
    const results = await Promise.all(
      venues.map(async (v) => {
        try {
          const q = await v.quote({ chainId, tokenIn, tokenOut, amountIn });
          return { venue: v.name, group: v.group, amount: a, amountIn, amountOut: q.amountOut, price: execPrice(amountIn, tokenIn.decimals, q.amountOut, tokenOut.decimals), meta: q.meta };
        } catch (e) {
          return { venue: v.name, group: v.group, amount: a, amountIn, error: e.message };
        }
      })
    );
    const metric = results.find((r) => r.group === "metric" && !r.error);
    for (const r of results) if (!r.error && metric) r.vsMetricBps = r.group === "metric" ? 0 : bpsDiff(r.amountOut, metric.amountOut);
    rows.push(...results);
  }
  const base = /* @__PURE__ */ new Map();
  for (const r of rows) if (!r.error && !base.has(r.venue)) base.set(r.venue, r.price);
  for (const r of rows) if (!r.error) r.impactBps = -bpsDiff(r.price, base.get(r.venue));
  return rows;
}

// src/venues.mjs
import { encodeFunctionData as encodeFunctionData2, decodeFunctionResult as decodeFunctionResult2, parseAbi as parseAbi2 } from "viem";

// src/onchain.mjs
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, decodeErrorResult, parseAbi } from "viem";
var quoterAbi = parseAbi([
  "function quoteLiveExactInSingle(address pool, address sender, bool zeroForOne, uint128 amountIn, uint128 priceLimitX64) returns (uint256 amountIn_, uint256 amountOut)",
  "function quoteLiveExactOutSingle(address pool, address sender, bool zeroForOne, uint128 amountOutDesired, uint128 priceLimitX64) returns (uint256 amountIn_, uint256 amountOut)",
  "function quoteLiveExactIn(address sender, (address[] pools, bytes[] extensionDatas, uint256 zeroForOneBitMap, uint128 amountIn) params) returns (uint256 amountIn_, uint256 amountOut)",
  "error WrappedError(address target, bytes4 selector, bytes reason)",
  "error InvalidPriceProvider()",
  "error PoolPaused(address pool, uint8 level)",
  "error QuoteDidNotRevert()",
  "error AmountTooLarge(uint128 amount)",
  "error InvalidSwapDeltas()",
  "error InvalidPath()",
  "error InvalidInputAmountAtHop(uint8 hop, uint256 a, uint256 b)",
  "error InvalidOutputAmountAtHop(uint8 hop, uint256 a, uint256 b)",
  "error InvalidAmount()",
  "error FinalAmountIsZero()",
  "error BidIsZero()",
  "error BidGreaterThanAsk()",
  "error ReferencePriceOutOfRange()",
  "error BidAskRefAsymmetryOutOfBounds()"
]);
function makePublicClient(chainId, rpcUrl) {
  const url = rpcUrl ?? process.env[`RPC_URL_${chainId}`];
  if (!url) throw new Error(`Thi\u1EBFu RPC cho chain ${chainId}: truy\u1EC1n --rpc ho\u1EB7c \u0111\u1EB7t bi\u1EBFn m\xF4i tr\u01B0\u1EDDng RPC_URL_${chainId}`);
  return createPublicClient({ transport: http(url) });
}
function revertReason(err) {
  let e = err;
  while (e) {
    const data = e.data ?? e.raw;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: quoterAbi, data });
        if (d.errorName === "WrappedError") {
          const inner = revertReason({ data: d.args[2] });
          return `WrappedError \u2192 ${inner}`;
        }
        return `${d.errorName}(${d.args?.map(String).join(", ") ?? ""})`;
      } catch {
      }
    }
    e = e.cause;
  }
  return err?.shortMessage ?? err?.message ?? String(err);
}
async function callQuoter(client, functionName, args) {
  const data = encodeFunctionData({ abi: quoterAbi, functionName, args });
  const res = await client.call({ to: CONTRACTS.quoter, data });
  if (!res.data) throw new Error("Quoter kh\xF4ng tr\u1EA3 d\u1EEF li\u1EC7u");
  const [amountIn, amountOut] = decodeFunctionResult({ abi: quoterAbi, functionName, data: res.data });
  return { amountIn, amountOut };
}
function quoteExactInSingle(client, { pool, sender, zeroForOne, amountIn }) {
  return callQuoter(client, "quoteLiveExactInSingle", [pool, sender, zeroForOne, BigInt(amountIn), noPriceLimit(zeroForOne)]);
}
function quoteExactInMulti(client, { sender, pools, directions, amountIn, extensionDatas }) {
  const bitmap = directions.reduce((m, z, i) => z ? m | 1n << BigInt(i) : m, 0n);
  return callQuoter(client, "quoteLiveExactIn", [
    sender,
    { pools, extensionDatas: extensionDatas ?? pools.map(() => "0x"), zeroForOneBitMap: bitmap, amountIn: BigInt(amountIn) }
  ]);
}
function quoteRoute(client, route, sender) {
  const legs = route.legs;
  if (legs.length === 1) {
    return quoteExactInSingle(client, { pool: legs[0].poolAddress, sender, zeroForOne: legs[0].zeroForOne, amountIn: route.amountIn });
  }
  return quoteExactInMulti(client, {
    sender,
    pools: legs.map((l) => l.poolAddress),
    directions: legs.map((l) => l.zeroForOne),
    amountIn: route.amountIn
  });
}

// src/venues.mjs
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(fetchImpl, url, init, { retries = 2 } = {}) {
  for (let i = 0; ; i++) {
    const res = await fetchImpl(url, init);
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && i < retries) {
      await sleep(400 * 2 ** i);
      continue;
    }
    throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
}
function metricVenue(client) {
  return {
    name: "Metric",
    group: "metric",
    async quote({ chainId, tokenIn, tokenOut, amountIn }) {
      const r = await client.findRoute(chainId, { tokenIn: tokenIn.address, tokenOut: tokenOut.address, tradeType: "exact_in", amountIn: amountIn.toString(), maxRoutes: 4 });
      return {
        amountOut: BigInt(r.amountOut),
        meta: {
          impactBps: Number(r.priceImpactBestRoute) * 1e4,
          routes: r.routes.map((x) => `${x.routeType}:${x.legs.map((l) => l.pair).join(">")}`).join(" | "),
          pools: [...new Set(r.routes.flatMap((x) => x.legs.map((l) => l.poolAddress)))]
        }
      };
    }
  };
}
function veloraVenue({ dex, fetchImpl = globalThis.fetch, baseUrl = "https://api.paraswap.io" } = {}) {
  return {
    name: dex ? dex : "Velora (best of all DEXs)",
    group: dex ? "dex" : "aggregator",
    via: dex ? "Velora includeDEXS" : void 0,
    async quote({ chainId, tokenIn, tokenOut, amountIn }) {
      const u = new URL("/prices", baseUrl);
      const p = { srcToken: tokenIn.address, destToken: tokenOut.address, srcDecimals: String(tokenIn.decimals), destDecimals: String(tokenOut.decimals), amount: amountIn.toString(), side: "SELL", network: String(chainId), version: "6.2" };
      if (dex) p.includeDEXS = dex;
      u.search = new URLSearchParams(p).toString();
      const j = await getJson(fetchImpl, u, { headers: { Accept: "application/json" } });
      if (!j.priceRoute?.destAmount) throw new Error(`Velora: ${j.error ?? "no priceRoute"}`);
      return { amountOut: BigInt(j.priceRoute.destAmount), meta: { gasUsd: j.priceRoute.gasCostUSD, routes: dex ? void 0 : [...new Set((j.priceRoute.bestRoute ?? []).flatMap((r) => r.swaps.flatMap((s) => s.swapExchanges.map((e) => e.exchange))))].join(", ") } };
    }
  };
}
var KYBER_SLUG = { 1: "ethereum", 56: "bsc" };
function kyberVenue({ fetchImpl = globalThis.fetch, baseUrl = "https://aggregator-api.kyberswap.com" } = {}) {
  return {
    name: "KyberSwap (best of all DEXs)",
    group: "aggregator",
    async quote({ chainId, tokenIn, tokenOut, amountIn }) {
      const slug = KYBER_SLUG[chainId];
      if (!slug) throw new Error(`KyberSwap: chain ${chainId} not configured`);
      const u = new URL(`/${slug}/api/v1/routes`, baseUrl);
      u.search = new URLSearchParams({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: amountIn.toString() }).toString();
      const j = await getJson(fetchImpl, u, { headers: { Accept: "application/json", "X-Client-Id": "metric-toolkit" } });
      const s = j?.data?.routeSummary;
      if (!s?.amountOut) throw new Error(`KyberSwap: ${j?.message ?? "no route"}`);
      return { amountOut: BigInt(s.amountOut), meta: { gasUsd: s.gasUsd } };
    }
  };
}
var uniQuoterAbi = parseAbi2([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
]);
var v2Abi = parseAbi2(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"]);
var UNI_V3_QUOTER = { 1: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", 56: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077" };
var V2_ROUTERS = {
  "Uniswap V2": { 1: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" },
  "SushiSwap V2": { 1: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F" },
  "PancakeSwap V2": { 56: "0x10ED43C718714eb63d5aA57B78B54704E256024E" }
};
function uniswapV3Venue({ rpcUrl, quoterAddress, fees = [100, 500, 3e3, 1e4] } = {}) {
  return {
    name: "Uniswap V3 (onchain)",
    group: "dex",
    async quote({ chainId, tokenIn, tokenOut, amountIn }) {
      const to = quoterAddress ?? UNI_V3_QUOTER[chainId];
      if (!to) throw new Error(`No Uniswap V3 QuoterV2 configured for chain ${chainId}`);
      const client = makePublicClient(chainId, rpcUrl);
      let best = null;
      await Promise.all(fees.map(async (fee) => {
        try {
          const data = encodeFunctionData2({ abi: uniQuoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, fee, sqrtPriceLimitX96: 0n }] });
          const r = await client.call({ to, data });
          const [out] = decodeFunctionResult2({ abi: uniQuoterAbi, functionName: "quoteExactInputSingle", data: r.data });
          if (!best || out > best.amountOut) best = { amountOut: out, meta: { fee } };
        } catch {
        }
      }));
      if (!best) throw new Error("No Uniswap V3 pool quoted this pair directly");
      return best;
    }
  };
}
function v2Venue({ name, rpcUrl, router }) {
  return {
    name: `${name} (onchain)`,
    group: "dex",
    async quote({ chainId, tokenIn, tokenOut, amountIn }) {
      const to = router ?? V2_ROUTERS[name]?.[chainId];
      if (!to) throw new Error(`${name} is not configured for chain ${chainId}`);
      const client = makePublicClient(chainId, rpcUrl);
      try {
        const data = encodeFunctionData2({ abi: v2Abi, functionName: "getAmountsOut", args: [amountIn, [tokenIn.address, tokenOut.address]] });
        const r = await client.call({ to, data });
        const amounts = decodeFunctionResult2({ abi: v2Abi, functionName: "getAmountsOut", data: r.data });
        return { amountOut: amounts[amounts.length - 1], meta: {} };
      } catch {
        throw new Error(`${name}: no direct pool for this pair`);
      }
    }
  };
}
var FAMOUS_DEXS = ["UniswapV2", "UniswapV3", "UniswapV4", "SushiSwap", "SushiSwapV3", "CurveV1", "CurveV2", "BalancerV2", "BalancerV3", "PancakeswapV3", "MaverickV2", "Fluid", "Aerodrome", "Camelot"];
function collectNames(node, out = /* @__PURE__ */ new Set()) {
  if (typeof node === "string") out.add(node);
  else if (Array.isArray(node)) node.forEach((x) => collectNames(x, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (/^(name|adapter|dex|exchange|key)$/i.test(k) && typeof v === "string") out.add(v);
      else if (!/^\d+$/.test(k) && k.length < 40) out.add(k);
      if (v && typeof v === "object") collectNames(v, out);
    }
  }
  return out;
}
async function discoverDexs(chainId, { fetchImpl = globalThis.fetch, baseUrl = "https://api.paraswap.io" } = {}) {
  try {
    const j = await getJson(fetchImpl, new URL(`/adapters/list/${chainId}`, baseUrl), { headers: { Accept: "application/json" } }, { retries: 1 });
    const have = collectNames(j);
    const lower = new Map([...have].map((n) => [n.toLowerCase(), n]));
    const found = FAMOUS_DEXS.map((d) => lower.get(d.toLowerCase())).filter(Boolean);
    if (found.length) return found;
  } catch {
  }
  return ["UniswapV2", "UniswapV3", "SushiSwap", "CurveV1", "CurveV2", "BalancerV2", "PancakeswapV3"];
}
async function resolveVenues(names, { client, rpcUrl, chainId, fetchImpl = globalThis.fetch, dexCache } = {}) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (v) => {
    if (!seen.has(v.name)) {
      seen.add(v.name);
      out.push(v);
    }
  };
  const expand = names.flatMap((n) => n.toLowerCase() === "all" ? ["metric", "velora", "kyber", "dexs", ...rpcUrl ? ["uniswapv3", "uniswapv2", "sushiv2", "pancakev2"] : []] : [n]);
  for (const raw of expand) {
    const n = raw.toLowerCase();
    if (n === "metric") add(metricVenue(client));
    else if (n === "velora" || n === "paraswap") add(veloraVenue({ fetchImpl }));
    else if (n === "kyber" || n === "kyberswap") {
      if (KYBER_SLUG[chainId]) add(kyberVenue({ fetchImpl }));
    } else if (n === "uniswapv3") add(uniswapV3Venue({ rpcUrl }));
    else if (n === "uniswapv2") add(v2Venue({ name: "Uniswap V2", rpcUrl }));
    else if (n === "sushiv2") add(v2Venue({ name: "SushiSwap V2", rpcUrl }));
    else if (n === "pancakev2") {
      if (chainId === 56) add(v2Venue({ name: "PancakeSwap V2", rpcUrl }));
    } else if (n === "dexs") for (const d of await (dexCache?.(chainId) ?? discoverDexs(chainId, { fetchImpl }))) add(veloraVenue({ dex: d, fetchImpl }));
    else if (n.startsWith("dex:")) add(veloraVenue({ dex: raw.slice(4), fetchImpl }));
    else throw new Error(`Unknown venue "${raw}". Use: metric, velora, kyber, uniswapv3, uniswapv2, sushiv2, pancakev2, dexs, dex:<Name>, all`);
  }
  return out;
}

// src/quote-check.mjs
async function checkRoutes({ route, client, sender, toleranceBps = 5 }) {
  const out = [];
  for (const [i, r] of route.routes.entries()) {
    const label = `${r.routeType}:${r.legs.map((l) => l.pair).join(">")}`;
    try {
      const q = await quoteRoute(client, r, sender);
      const dev = bpsDiff(q.amountOut, r.amountOut);
      const status = Math.abs(dev) <= toleranceBps ? "ok" : dev > 0 ? "warn" : "fail";
      out.push({ index: i, label, amountIn: r.amountIn, apiOut: BigInt(r.amountOut), chainOut: q.amountOut, deviationBps: dev, status });
    } catch (e) {
      out.push({ index: i, label, amountIn: r.amountIn, apiOut: BigInt(r.amountOut), status: "fail", error: revertReason(e) });
    }
  }
  return out;
}

// src/services.mjs
var Cache = class {
  constructor(ttlMs = 15e3, now = () => Date.now()) {
    this.ttl = ttlMs;
    this.now = now;
    this.m = /* @__PURE__ */ new Map();
  }
  get(key, loader, ttl = this.ttl) {
    const hit = this.m.get(key);
    if (hit && this.now() - hit.t < ttl) return hit.p;
    const p = loader();
    this.m.set(key, { t: this.now(), p });
    p.catch(() => this.m.delete(key));
    return p;
  }
  clear() {
    this.m.clear();
  }
};
var plain = (n) => Number(Number(n).toPrecision(2)).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 12 });
var SUGGEST_USD = [5e3, 25e3, 1e5, 5e5];
function createContext({ apiUrl, apiKey, rpcUrls = {}, fetchImpl, ttlMs = 15e3 } = {}) {
  const client = new MetricClient({ baseUrl: apiUrl, apiKey, fetchImpl: fetchImpl ?? globalThis.fetch });
  const cache = new Cache(ttlMs);
  const rpc = (chainId) => rpcUrls[chainId] ?? process.env[`RPC_URL_${chainId}`];
  const ctx = {
    client,
    cache,
    rpc,
    /** TOÀN BỘ pool của một chain (tự phân trang, kể cả pool TVL thấp hoặc không healthy). */
    pools: (chainId) => cache.get(`pools:${chainId}`, () => client.listPools(chainId, { maxPools: 5e3, minTvlFiat: 0, include24h: true })),
    async tokens(chainId) {
      return buildTokenIndex(await ctx.pools(chainId));
    },
    /** Trạng thái từng pool: metadata + bid/ask (depth=true để phát hiện chiều bị từ chối). */
    health: (chainId) => cache.get(`health:${chainId}`, async () => {
      const pools = await ctx.pools(chainId);
      const results = await client.bidAskBatch(chainId, pools.map((p) => p.poolAddress), { depth: true, chunk: 25 });
      const byAddr = new Map(results.map((r) => [r.poolAddress.toLowerCase(), r]));
      return pools.map((p) => {
        const r = byAddr.get(p.poolAddress.toLowerCase());
        const q = r?.quote;
        const sides = q ? sideAvailability(q) : null;
        const row = {
          poolAddress: p.poolAddress,
          pair: p.pair,
          token0: p.token0,
          token1: p.token1,
          tier: p.classificationSummary?.tierQualification ?? null,
          reasons: p.classificationSummary?.reasonCodes ?? [],
          status: q?.priceProviderStatus ?? p.priceProviderStatus ?? "unknown",
          pause: Number(p.pauseLevel ?? 0),
          sell: sides?.sellToken0 ?? null,
          buy: sides?.buyToken0 ?? null,
          tvl: p.tvlFiat ?? null,
          curator: p.adminUsername ?? null,
          verified: p.verifiedAdmin ?? null,
          error: r?.error ? `${r.error.status}: ${r.error.error}` : void 0
        };
        row.routable = isRoutable({ priceProviderStatus: row.status, pauseLevel: row.pause }) && row.sell !== false && row.buy !== false;
        return row;
      });
    }, 1e4),
    /** Các cặp token (cả hai chiều) với số pool và cỡ lệnh gợi ý theo giá fiat. */
    async pairs(chainId) {
      const health = await ctx.health(chainId);
      const pools = await ctx.pools(chainId);
      const meta = new Map(pools.map((p) => [p.poolAddress.toLowerCase(), p]));
      const groups = /* @__PURE__ */ new Map();
      for (const h of health) {
        const p = meta.get(h.poolAddress.toLowerCase());
        const a = p.token0.toLowerCase(), b = p.token1.toLowerCase();
        const key = [a, b].sort().join("|");
        const g = groups.get(key) ?? { t0: { address: a, symbol: p.token0Symbol, decimals: Number(p.token0Decimals), usd: null }, t1: { address: b, symbol: p.token1Symbol, decimals: Number(p.token1Decimals), usd: null }, pools: 0, routable: 0, tvl: 0, top: null };
        const same = a === g.t0.address;
        const fiat0 = p.token0FiatPrice, fiat1 = p.token1FiatPrice;
        if (g.t0.usd == null) g.t0.usd = same ? fiat0 : fiat1;
        if (g.t1.usd == null) g.t1.usd = same ? fiat1 : fiat0;
        g.pools++;
        g.tvl += h.tvl ?? 0;
        if (h.routable) {
          g.routable++;
          g.top ??= h.poolAddress;
        }
        groups.set(key, g);
      }
      const out = [];
      for (const g of groups.values()) {
        for (const [i, o] of [[g.t0, g.t1], [g.t1, g.t0]]) {
          out.push({
            id: `${i.symbol}>${o.symbol}:${i.address}`,
            label: `${i.symbol}/${o.symbol}`,
            in: { address: i.address, symbol: i.symbol, decimals: i.decimals },
            out: { address: o.address, symbol: o.symbol, decimals: o.decimals },
            pools: g.pools,
            routablePools: g.routable,
            tvl: g.tvl,
            topPool: g.top,
            amounts: i.usd ? SUGGEST_USD.map((u) => plain(u / i.usd)) : null,
            priceUsd: i.usd
          });
        }
      }
      return out.sort((x, y) => y.routablePools - x.routablePools || y.tvl - x.tvl);
    },
    /** DEX Velora hỗ trợ trên chain (cache 1 giờ). */
    dexs: (chainId) => cache.get(`dexs:${chainId}`, () => discoverDexs(chainId, { fetchImpl }), 36e5),
    availableVenues(chainId) {
      return ["all", "metric", "velora", ...[1, 56].includes(chainId) ? ["kyber"] : [], "dexs", ...rpc(chainId) ? ["uniswapv3", "uniswapv2", "sushiv2", ...chainId === 56 ? ["pancakev2"] : []] : []];
    },
    compare: ({ chainId, tokenIn, tokenOut, amounts, venues = ["all"] }) => cache.get(`cmp:${chainId}:${tokenIn}:${tokenOut}:${amounts}:${venues}`, async () => {
      const tokens = await ctx.tokens(chainId);
      const tin = tokens.resolve(tokenIn), tout = tokens.resolve(tokenOut);
      const vs = await resolveVenues(venues, { client, rpcUrl: rpc(chainId), chainId, fetchImpl, dexCache: ctx.dexs });
      const rows = await compareVenues({ venues: vs, chainId, tokenIn: tin, tokenOut: tout, amounts });
      return {
        chainId,
        tokenIn: tin,
        tokenOut: tout,
        at: Date.now(),
        rows: rows.map((r) => ({
          amount: r.amount,
          venue: r.venue,
          group: r.group,
          amountIn: r.amountIn?.toString(),
          amountOut: r.amountOut?.toString(),
          out: r.amountOut === void 0 ? void 0 : humanAmount(r.amountOut, tout.decimals),
          price: r.price,
          vsMetricBps: r.vsMetricBps,
          impactBps: r.impactBps,
          error: r.error,
          meta: r.meta
        }))
      };
    }, 4e3),
    /** Đối chiếu route của API với quoter onchain (cần RPC của chain). */
    async check({ chainId, tokenIn, tokenOut, amount, sender = "0x0000000000000000000000000000000000000000", toleranceBps = 5 }) {
      const url = rpc(chainId);
      if (!url) {
        const e = new Error(`Quote checker needs an RPC URL: set RPC_URL_${chainId}`);
        e.status = 501;
        throw e;
      }
      const tokens = await ctx.tokens(chainId);
      const tin = tokens.resolve(tokenIn), tout = tokens.resolve(tokenOut);
      const route = await client.findRoute(chainId, { tokenIn: tin.address, tokenOut: tout.address, tradeType: "exact_in", amountIn: parseUnits2(String(amount), tin.decimals).toString(), maxRoutes: 4 });
      const res = await checkRoutes({ route, client: makePublicClient(chainId, url), sender, toleranceBps });
      return {
        chainId,
        tokenIn: tin,
        tokenOut: tout,
        amount,
        toleranceBps,
        routes: res.map((r) => ({ ...r, amountIn: String(r.amountIn), apiOut: r.apiOut.toString(), chainOut: r.chainOut?.toString(), apiOutHuman: humanAmount(r.apiOut, tout.decimals), chainOutHuman: r.chainOut === void 0 ? void 0 : humanAmount(r.chainOut, tout.decimals) }))
      };
    }
  };
  return ctx;
}
var toJson = (v) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);

// src/watch.mjs
function priceAlerts(rows, { thresholdBps, pairLabel }) {
  const alerts = [];
  for (const r of rows) {
    if (r.group === "metric" || r.venue === "Metric" || r.error || r.vsMetricBps === void 0) continue;
    if (Math.abs(r.vsMetricBps) < thresholdBps) continue;
    const better = r.vsMetricBps < 0;
    alerts.push({
      key: `price:${pairLabel}:${r.amount}:${r.venue}:${better ? "better" : "worse"}`,
      kind: better ? "good" : "warn",
      text: better ? `${pairLabel} (${r.amount}): Metric beats ${r.venue} by ${Math.abs(r.vsMetricBps).toFixed(1)} bps, prefer routing through Metric.` : `${pairLabel} (${r.amount}): Metric trails ${r.venue} by ${r.vsMetricBps.toFixed(1)} bps, check whether the Metric price is stale or off.`
    });
  }
  return alerts;
}
function healthState(row) {
  const problems = [];
  if (row.status !== "healthy") problems.push(`provider=${row.status}`);
  if (Number(row.pause) !== 0) problems.push(`pauseLevel=${row.pause}`);
  if (row.sell === false) problems.push("sell side has no price");
  if (row.buy === false) problems.push("buy side has no price");
  return { ok: problems.length === 0, reason: problems.join(", ") };
}
function healthAlerts(prev, rows) {
  const alerts = [];
  const state = {};
  for (const row of rows) {
    const id = row.poolAddress.toLowerCase();
    if (row.error) {
      if (prev[id]) state[id] = prev[id];
      continue;
    }
    const st = { ...healthState(row), pair: row.pair };
    state[id] = st;
    const was = prev[id];
    if (was === void 0 && st.ok) continue;
    if (was && was.ok === st.ok && was.reason === st.reason) continue;
    const short = `${row.poolAddress.slice(0, 6)}\u2026${row.poolAddress.slice(-4)}`;
    alerts.push({
      key: `health:${id}:${st.ok ? "up" : st.reason}`,
      kind: st.ok ? "good" : "bad",
      text: st.ok ? `Pool ${row.pair} (${short}) recovered.` : `Pool ${row.pair} (${short}) has a problem: ${st.reason}`
    });
  }
  return { alerts, state };
}
var AlertGate = class {
  constructor(cooldownSec = 300, now = () => Date.now()) {
    this.cool = cooldownSec * 1e3;
    this.now = now;
    this.seen = /* @__PURE__ */ new Map();
  }
  filter(alerts) {
    const t = this.now();
    return alerts.filter((a) => {
      const last = this.seen.get(a.key);
      if (last !== void 0 && t - last < this.cool) return false;
      this.seen.set(a.key, t);
      return true;
    });
  }
};
async function notify(text, { fetchImpl = globalThis.fetch, env = process.env, quiet = false } = {}) {
  if (!quiet) console.log(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${text}`);
  const jobs = [];
  if (env.DISCORD_WEBHOOK_URL) jobs.push(fetchImpl(env.DISCORD_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }) }));
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) jobs.push(fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }) }));
  await Promise.allSettled(jobs);
}
function createWatcher({ ctx, config = {}, send = notify, now = () => Date.now() }) {
  const chainId = config.chainId ?? 1;
  const gate = new AlertGate(config.cooldownSec ?? 300, now);
  const events = [];
  const subs = /* @__PURE__ */ new Set();
  let seq = 0, prev = {}, timer = null, lastRun = null, lastError = null, runs = 0;
  function emit(a) {
    const ev = { id: ++seq, ts: now(), kind: a.kind, text: a.text };
    events.push(ev);
    if (events.length > 300) events.shift();
    subs.forEach((fn) => fn(ev));
    return Promise.resolve(send(a.text)).catch(() => {
    });
  }
  async function tick() {
    const alerts = [];
    try {
      for (const p of config.pairs ?? []) {
        const res = await ctx.compare({ chainId, tokenIn: p.in, tokenOut: p.out, amounts: p.amounts, venues: config.venues ?? ["metric", "velora", "kyber"] });
        alerts.push(...priceAlerts(res.rows, { thresholdBps: config.thresholdBps ?? 15, pairLabel: `${p.in}/${p.out}` }));
      }
      if (config.health !== false) {
        const h = await ctx.health(chainId);
        const r = healthAlerts(prev, h);
        prev = r.state;
        alerts.push(...r.alerts);
      }
      lastError = null;
    } catch (e) {
      lastError = e.message;
      alerts.push({ key: `err:${e.message}`, kind: "warn", text: `Watcher cycle failed: ${e.message}` });
    }
    lastRun = now();
    runs++;
    const fresh = gate.filter(alerts);
    for (const a of fresh) await emit(a);
    return fresh;
  }
  return {
    tick,
    start() {
      if (timer) return;
      const loop = async () => {
        await tick();
        timer = setTimeout(loop, (config.intervalSec ?? 30) * 1e3);
        timer.unref?.();
      };
      timer = setTimeout(loop, 0);
    },
    stop() {
      clearTimeout(timer);
      timer = null;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    state: () => ({ running: !!timer, runs, lastRun, lastError, thresholdBps: config.thresholdBps ?? 15, intervalSec: config.intervalSec ?? 30, pairs: config.pairs ?? [], events: [...events].reverse() })
  };
}

// server/api.mjs
var intParam = (v, d) => {
  const n = Number(v ?? d);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error(`Invalid chain id: ${v}`), { status: 400 });
  return n;
};
var need = (q, k) => {
  const v = q.get(k);
  if (!v) throw Object.assign(new Error(`Missing query parameter: ${k}`), { status: 400 });
  return v;
};
function createApiHandler({ ctx, watcher, defaultChain = 1 }) {
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(toJson(body));
  };
  async function route(req, res, url) {
    const q = url.searchParams;
    const chainId = intParam(q.get("chain"), defaultChain);
    switch (url.pathname) {
      case "/api/status":
        return send(res, 200, { ok: true, defaultChain, venues: ctx.availableVenues(chainId), rpc: !!ctx.rpc(chainId), watcher: watcher ? { running: watcher.state().running } : null });
      case "/api/pools": {
        const pools = await ctx.pools(chainId);
        return send(res, 200, { chainId, total: pools.length, data: pools });
      }
      case "/api/health": {
        const rows = await ctx.health(chainId);
        return send(res, 200, { chainId, total: rows.length, routable: rows.filter((r) => r.routable).length, at: Date.now(), data: rows });
      }
      case "/api/pairs":
        return send(res, 200, { chainId, data: await ctx.pairs(chainId) });
      case "/api/compare": {
        const amounts = need(q, "amounts").split(",").map((s) => s.trim()).filter(Boolean);
        if (!amounts.length || amounts.length > 8) throw Object.assign(new Error("amounts: 1 to 8 values"), { status: 400 });
        const venues = (q.get("venues") ?? "all").split(",");
        return send(res, 200, await ctx.compare({ chainId, tokenIn: need(q, "in"), tokenOut: need(q, "out"), amounts, venues }));
      }
      case "/api/check":
        return send(res, 200, await ctx.check({ chainId, tokenIn: need(q, "in"), tokenOut: need(q, "out"), amount: need(q, "amount"), sender: q.get("sender") ?? void 0, toleranceBps: Number(q.get("tolerance") ?? 5) }));
      case "/api/watch":
        return send(res, 200, watcher ? watcher.state() : { running: false, events: [] });
      case "/api/stream": {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write("retry: 3000\n\n");
        const off = watcher?.subscribe((ev) => res.write(`data: ${toJson(ev)}

`));
        const ping = setInterval(() => res.write(": ping\n\n"), 2e4);
        req.on("close", () => {
          clearInterval(ping);
          off?.();
        });
        return;
      }
      default:
        return send(res, 404, { error: "Unknown endpoint" });
    }
  }
  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return true;
      }
      await route(req, res, url);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      send(res, status === 401 ? 502 : status, { error: e.message, code: e.code });
    }
    return true;
  };
}

// server/vite-plugin.mjs
function metricApi(options = {}) {
  let handler = null;
  const init = () => {
    if (handler) return handler;
    const chainId = Number(process.env.METRIC_CHAIN ?? options.chainId ?? 1);
    const cfgPath = process.env.WATCH_CONFIG ?? options.watchConfig;
    const config = cfgPath ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : { chainId, intervalSec: 30, thresholdBps: 15, venues: ["metric", "velora", "kyber"], pairs: [] };
    const ctx = createContext({ apiUrl: process.env.METRIC_API_URL, apiKey: process.env.METRIC_API_KEY });
    const watcher = process.env.NO_WATCH === "1" ? null : createWatcher({ ctx, config, send: notify });
    watcher?.start();
    handler = createApiHandler({ ctx, watcher, defaultChain: chainId });
    return handler;
  };
  const mount = (server) => {
    server.config.logger.info("  [metric-api] API plugin mounted: /api/status, /api/pools, /api/compare ...");
    server.middlewares.use(async (req, res, next) => {
      const isApi = req.url?.startsWith("/api/");
      try {
        if (!await init()(req, res)) next();
      } catch (e) {
        server.config.logger.error(`[metric-api] ${e.stack ?? e.message}`);
        if (!isApi) return next(e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `API plugin failed to start: ${e.message}` }));
      }
    });
  };
  return { name: "metric-api", configureServer: mount, configurePreviewServer: mount };
}
export {
  metricApi as default
};