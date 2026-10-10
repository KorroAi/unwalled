// Catalogue of ready-made sources: discover(name, "preset:<id>"). Addresses were checked when they were added;
// small public APIs without a published description are described here from their documented, tested endpoints.

/** @param {string} name @param {string} description @param {Record<string, any>} [schema] @param {boolean} [required] */
const query = (name, description, schema = { type: "string" }, required = false) => ({ name, in: "query", required, description, schema });

const COINGECKO = {
  openapi: "3.0.3",
  info: { title: "CoinGecko public API (free tier)", version: "3" },
  servers: [{ url: "https://api.coingecko.com/api/v3" }],
  paths: {
    "/simple/price": { get: { operationId: "simple_price", summary: "Current price of coins", parameters: [query("ids", "Coin ids, comma-separated (e.g. bitcoin,ethereum)", undefined, true), query("vs_currencies", "Currencies, comma-separated (e.g. usd,eur)", undefined, true), query("include_24hr_change", "true to add the 24 h change", { type: "boolean" }), query("include_market_cap", "true to add the market cap", { type: "boolean" })] } },
    "/coins/markets": { get: { operationId: "coins_markets", summary: "Coins with price, market cap and volume", parameters: [query("vs_currency", "e.g. usd", undefined, true), query("ids", "Only these coin ids"), query("order", "e.g. market_cap_desc"), query("per_page", "1-250", { type: "integer" }), query("page", "Page number", { type: "integer" })] } },
    "/coins/{id}/market_chart": { get: { operationId: "coin_market_chart", summary: "Price, market cap and volume history", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Coin id (e.g. bitcoin)" }, query("vs_currency", "e.g. usd", undefined, true), query("days", "1, 7, 30, 365...", undefined, true)] } },
    "/search": { get: { operationId: "search", summary: "Find coins, exchanges and categories by name", parameters: [query("query", "Search text", undefined, true)] } },
    "/ping": { get: { operationId: "ping", summary: "API status" } },
  },
};

const OPEN_METEO = {
  openapi: "3.0.3",
  info: { title: "Open-Meteo forecast API", version: "1" },
  servers: [{ url: "https://api.open-meteo.com" }],
  paths: {
    "/v1/forecast": {
      get: {
        operationId: "forecast",
        summary: "Weather forecast for a position (no key needed)",
        parameters: [
          query("latitude", "e.g. 48.85", { type: "number" }, true), query("longitude", "e.g. 2.35", { type: "number" }, true),
          query("current", "Current variables, e.g. temperature_2m,precipitation,wind_speed_10m"), query("hourly", "Hourly variables, e.g. temperature_2m"),
          query("daily", "Daily variables, e.g. temperature_2m_max,precipitation_sum"), query("timezone", "auto, or e.g. Europe/Paris"), query("forecast_days", "1-16", { type: "integer" }),
        ],
      },
    },
  },
};

const OPEN_METEO_GEOCODING = {
  openapi: "3.0.3",
  info: { title: "Open-Meteo geocoding API", version: "1" },
  servers: [{ url: "https://geocoding-api.open-meteo.com" }],
  paths: { "/v1/search": { get: { operationId: "search_place", summary: "Coordinates of a place by name", parameters: [query("name", "Place name, e.g. Lyon", undefined, true), query("count", "Number of results", { type: "integer" }), query("language", "e.g. fr")] } } },
};

const BINANCE_STREAMS = {
  asyncapi: "2.6.0",
  info: { title: "Binance public market streams", version: "1" },
  servers: { public: { url: "wss://stream.binance.com:9443", protocol: "wss" } },
  channels: Object.fromEntries(
    ["btcusdt@trade", "btcusdt@ticker", "ethusdt@trade", "ethusdt@ticker"].map((stream) => [
      `/ws/${stream}`,
      { subscribe: { message: { payload: { type: "object", properties: { e: { type: "string" }, s: { type: "string" }, p: { type: "string" }, c: { type: "string" } } } } } },
    ]),
  ),
};

/**
 * @typedef {object} Preset
 * @property {string} title
 * @property {string} [auth] how to give credentials, when the API needs them
 * @property {{ url: string } | { spec: any } | { asyncapi: any }} source
 */

/** @type {Record<string, Preset>} */
export const PRESETS = {
  github: { title: "GitHub REST API", auth: 'set_credentials(host="api.github.com", headers={"authorization": "Bearer <token>"}) — a token from "gh auth token" or GitHub settings', source: { url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json" } },
  stripe: { title: "Stripe API", auth: 'set_credentials(host="api.stripe.com", headers={"authorization": "Bearer sk_..."})', source: { url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json" } },
  vercel: { title: "Vercel REST API", auth: 'set_credentials(host="api.vercel.com", headers={"authorization": "Bearer <token>"})', source: { url: "https://openapi.vercel.sh/" } },
  elevenlabs: { title: "ElevenLabs API", auth: 'set_credentials(host="api.elevenlabs.io", headers={"xi-api-key": "<key>"})', source: { url: "https://api.elevenlabs.io/openapi.json" } },
  discord: { title: "Discord HTTP API", auth: 'set_credentials(host="discord.com", headers={"authorization": "Bot <token>"})', source: { url: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json" } },
  binance: { title: "Binance public spot REST API (market data without key)", source: { url: "https://raw.githubusercontent.com/binance/binance-api-swagger/master/spot_api.yaml" } },
  "binance-streams": { title: "Binance live trades and tickers (WebSocket, no key)", source: { asyncapi: BINANCE_STREAMS } },
  coingecko: { title: "CoinGecko prices and market data (free, no key)", source: { spec: COINGECKO } },
  "open-meteo": { title: "Open-Meteo weather forecast (free, no key)", source: { spec: OPEN_METEO } },
  "open-meteo-geocoding": { title: "Open-Meteo place search (free, no key)", source: { spec: OPEN_METEO_GEOCODING } },
  petstore: { title: "Swagger Petstore (demo)", source: { url: "https://petstore3.swagger.io/api/v3/openapi.json" } },
  youtube: { title: "YouTube Data API v3", auth: GOOGLE_AUTH("youtube.googleapis.com"), source: { url: google("youtube", "v3") } },
  "youtube-analytics": { title: "YouTube Analytics API v2", auth: GOOGLE_AUTH("youtubeanalytics.googleapis.com", true), source: { url: google("youtubeAnalytics", "v2") } },
  gmail: { title: "Gmail API", auth: GOOGLE_AUTH("gmail.googleapis.com", true), source: { url: google("gmail", "v1") } },
  drive: { title: "Google Drive API", auth: GOOGLE_AUTH("www.googleapis.com", true), source: { url: google("drive", "v3") } },
  sheets: { title: "Google Sheets API", auth: GOOGLE_AUTH("sheets.googleapis.com", true), source: { url: google("sheets", "v4") } },
  calendar: { title: "Google Calendar API", auth: GOOGLE_AUTH("www.googleapis.com", true), source: { url: google("calendar", "v3") } },
};

/** @param {string} api @param {string} version */
function google(api, version) {
  return `https://www.googleapis.com/discovery/v1/apis/${api}/${version}/rest`;
}

/** @param {string} host @param {boolean} [userData] */
function GOOGLE_AUTH(host, userData = false) {
  return userData
    ? `your own data needs an OAuth access token: set_credentials(host="${host}", headers={"authorization": "Bearer <token>"})`
    : `public data needs an API key: set_credentials(host="${host}", headers={"x-goog-api-key": "<key>"})`;
}

/**
 * @param {string} reference "preset:<id>" or "preset:google:<api>/<version>"
 * @returns {Preset & { id: string }}
 */
export function resolvePreset(reference) {
  const id = reference.replace(/^preset:/i, "").trim().toLowerCase();
  const googleApi = /^google:([a-z0-9]+)\/(v[\w.]+)$/i.exec(reference.replace(/^preset:/i, "").trim());
  if (googleApi) return { id, title: `Google ${googleApi[1]} ${googleApi[2]}`, auth: GOOGLE_AUTH(`${googleApi[1].toLowerCase()}.googleapis.com`), source: { url: google(googleApi[1], googleApi[2]) } };
  const preset = PRESETS[id];
  if (!preset) throw new Error(`Unknown preset "${id}". Presets: ${listPresets()}.`);
  return { id, ...preset };
}

/** One-line list for tool descriptions and errors. */
export function listPresets() {
  return `${Object.keys(PRESETS).join(", ")}, google:<api>/<version> (any Google API)`;
}
