import { performance } from "node:perf_hooks";
import { abortableDelay, createRequestGate, readBoundedResponse } from "./request-control.mjs";

const COMMUNITY_API_BASE = "https://bbs-api-os.hoyolab.com";
const WIKI_API_BASE = "https://sg-act-public-api-static.hoyolab.com";

// Keep the public endpoint contract in one place so request construction and tests use the same paths.
export const HOYOLAB_ENDPOINTS = Object.freeze({
  searchPosts: `${COMMUNITY_API_BASE}/community/search/wapi/search/post`,
  searchWiki: `${COMMUNITY_API_BASE}/community/painter/wapi/search`,
  article: `${COMMUNITY_API_BASE}/community/post/wapi/getPostFull`,
  replies: `${COMMUNITY_API_BASE}/community/post/wapi/getPostReplies`,
  postCard: `${COMMUNITY_API_BASE}/community/painter/wapi/post/card`,
  wiki: `${WIKI_API_BASE}/hoyowiki`
});

// HoYoLAB exposes these values through its language resource (including short aliases such as JA/JP).
// Normalize aliases before sending the header so a valid-looking but unsupported locale cannot silently fall back to English.
const LANGUAGE_ALIASES = Object.freeze({
  "zh-cn": "zh-cn", chs: "zh-cn",
  "zh-tw": "zh-tw", cht: "zh-tw",
  "de-de": "de-de", de: "de-de",
  "en-us": "en-us", en: "en-us",
  "es-es": "es-es", es: "es-es",
  "fr-fr": "fr-fr", fr: "fr-fr",
  "id-id": "id-id", id: "id-id",
  "it-it": "it-it", it: "it-it",
  "ja-jp": "ja-jp", ja: "ja-jp", jp: "ja-jp",
  "ko-kr": "ko-kr", ko: "ko-kr", kr: "ko-kr",
  "pt-pt": "pt-pt", pt: "pt-pt",
  "ru-ru": "ru-ru", ru: "ru-ru",
  "th-th": "th-th", th: "th-th",
  "tr-tr": "tr-tr", tr: "tr-tr",
  "vi-vn": "vi-vn", vi: "vi-vn", vn: "vi-vn"
});
const LANGUAGE_CODES = Object.freeze([...new Set(Object.values(LANGUAGE_ALIASES))]);
const SEARCH_ORDER_TYPE_VALUES = Object.freeze([0, 2]);
// HoYoLAB has an additional followed-account author_type, but anonymous public search rejects it; keep author_type=3 out of the MCP/API surface.
const SEARCH_AUTHOR_TYPE_VALUES = Object.freeze([0, 1, 2]);

// HoYoLAB uses locale headers to select multilingual article, reply, and Wiki responses.

export class HoYoLabApiError extends Error {
  constructor(message, { status, url, retcode, cause, code = "API_ERROR", retryable = false, retryAfterMs } = {}) {
    super(message, { cause });
    this.name = "HoYoLabApiError";
    this.status = status;
    this.url = url;
    this.retcode = retcode;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function normalizeHoYoLabLanguage(language) {
  if (language === undefined || language === null || language === "") return "";
  const normalized = LANGUAGE_ALIASES[String(language).trim().toLowerCase()];
  if (!normalized) {
    throw new HoYoLabApiError(`Unsupported language: ${language}. Supported codes: ${LANGUAGE_CODES.join(", ")}`, { code: "INVALID_LANGUAGE" });
  }
  return normalized;
}

export function normalizeReplyCursor(value) {
  const cursor = typeof value === "string" ? value.trim()
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  return cursor && cursor.length <= 128 ? cursor : undefined;
}

export function normalizeHoYoLabId(value) {
  const id = typeof value === "string" ? value.trim()
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  return /^\d{1,32}$/.test(id) ? id : undefined;
}

function safeInteger(value, fallback, { min, max }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function safeEnumInteger(value, fallback, values) {
  const number = Number(value);
  return values.includes(number) ? number : fallback;
}

function stringId(value, name) {
  const id = normalizeHoYoLabId(value);
  if (!id) throw new HoYoLabApiError(`${name} must be a numeric ID of at most 32 digits`, { code: "INVALID_SELECTION" });
  return id;
}

function setIfDefined(url, key, value) {
  if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
}

function languageHeaders(language, extra = {}) {
  const normalizedLanguage = normalizeHoYoLabLanguage(language);
  const headers = { accept: "application/json", ...extra };
  if (normalizedLanguage) {
    headers["x-rpc-language"] = normalizedLanguage;
    headers["accept-language"] = normalizedLanguage;
  }
  return headers;
}

// Normalize timeout failures to the same public error type as HTTP and API-level failures.
function abortError(url, timeoutMs, cancelled) {
  return new HoYoLabApiError(cancelled ? "HoYoLAB request was cancelled" : `HoYoLAB request timed out after ${timeoutMs}ms`, {
    url, code: cancelled ? "CANCELLED" : "TIMEOUT", retryable: !cancelled
  });
}

function unwrapApiResponse(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    return payload.data;
  }
  return payload;
}

export function createHoYoLabClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.HOYOLAB_API_TIMEOUT_MS || 20000),
  defaultLanguage = process.env.HOYOLAB_LANGUAGE || "",
  defaultGameId = Number(process.env.HOYOLAB_GAME_ID || 2),
  endpoints = HOYOLAB_ENDPOINTS,
  maxRetries = 1,
  maxRetryDelayMs = 2000,
  maxResponseBytes = 8 * 1024 * 1024,
  concurrency = 4,
  maxQueue = 24,
  minRequestIntervalMs = 100
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  const requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;
  const acquire = createRequestGate({ concurrency: safeInteger(concurrency, 4, { min: 1, max: 32 }), maxQueue: safeInteger(maxQueue, 24, { min: 0, max: 1000 }) });
  const retryLimit = safeInteger(maxRetries, 1, { min: 0, max: 3 });
  const responseLimit = safeInteger(maxResponseBytes, 8 * 1024 * 1024, { min: 1, max: 64 * 1024 * 1024 });
  const interval = safeInteger(minRequestIntervalMs, 100, { min: 0, max: 10000 });
  let nextRequestAt = 0;

  async function pacedFetch(url, options) {
    // Claim an interval only when fetch actually starts; cancelled waits must not accumulate future reservations.
    while (nextRequestAt > performance.now()) await abortableDelay(nextRequestAt - performance.now(), options.signal);
    options.signal?.throwIfAborted();
    try {
      return fetchImpl(url, options);
    } finally {
      // Monotonic timing and recording after synchronous dispatch keep clock changes or fetch setup from shortening the interval.
      nextRequestAt = performance.now() + interval;
    }
  }

  async function get(url, { language = defaultLanguage, headers = {}, signal } = {}) {
    const normalizedLanguage = normalizeHoYoLabLanguage(language);
    if (signal?.aborted) throw abortError(url, requestTimeoutMs, true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let release;
    try {
      release = await acquire(controller.signal);
      for (let attempt = 0; ; attempt += 1) {
        const response = await pacedFetch(url, {
          method: "GET",
          headers: languageHeaders(normalizedLanguage, headers),
          signal: controller.signal
        });
        // Parse the complete response before checking the API return code so callers receive useful error details.
        const bodyText = await readBoundedResponse(response, responseLimit, controller.signal);
        let payload;
        try {
          payload = JSON.parse(bodyText);
        } catch (error) {
          if (response.ok) throw new HoYoLabApiError("HoYoLAB returned a non-JSON response", {
            status: response.status,
            url,
            cause: error, code: "INVALID_RESPONSE"
          });
        }
        if (!response.ok) {
          const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
          const retryHeader = response.headers?.get?.("retry-after");
          const seconds = retryHeader == null ? NaN : Number(retryHeader);
          const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
            : retryHeader ? Math.max(0, Date.parse(retryHeader) - Date.now()) : undefined;
          const backoff = Number.isFinite(retryAfterMs) ? retryAfterMs : 250 * 2 ** attempt;
          if (retryable && attempt < retryLimit && backoff <= maxRetryDelayMs) {
            await abortableDelay(backoff, controller.signal);
            continue;
          }
          const code = response.status === 429 ? "RATE_LIMITED" : response.status === 404 ? "NOT_FOUND"
            : [401, 403].includes(response.status) ? "ACCESS_DENIED" : "HTTP_ERROR";
          throw new HoYoLabApiError(`HoYoLAB returned HTTP ${response.status}`, {
            status: response.status,
            url,
            retcode: payload?.retcode, code, retryable,
            retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
          });
        }
        if (payload && typeof payload.retcode === "number" && payload.retcode !== 0) {
          throw new HoYoLabApiError(`HoYoLAB returned retcode ${payload.retcode}`, {
            status: response.status,
            url,
            retcode: payload.retcode, code: "API_REJECTED"
          });
        }
        if (payload && Object.hasOwn(payload, "retcode") && typeof payload.retcode !== "number") {
          throw new HoYoLabApiError("HoYoLAB returned an invalid API return-code type", { url, code: "INVALID_RESPONSE" });
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new HoYoLabApiError("HoYoLAB returned an invalid response object", { url, code: "INVALID_RESPONSE" });
        }
        return { payload, data: unwrapApiResponse(payload), url, status: response.status, language: normalizedLanguage || undefined, retrievedAt: new Date().toISOString() };
      }
    } catch (error) {
      if (controller.signal.aborted) throw abortError(url, requestTimeoutMs, signal?.aborted);
      if (error instanceof HoYoLabApiError) throw error;
      if (error?.message === "REQUEST_QUEUE_FULL") throw new HoYoLabApiError("Request queue is full; retry later", { url, code: "BUSY", retryable: true });
      if (error?.message === "RESPONSE_TOO_LARGE") throw new HoYoLabApiError("HoYoLAB response exceeded the byte limit", { url, code: "RESPONSE_TOO_LARGE" });
      throw new HoYoLabApiError("HoYoLAB network request failed", { url, cause: error, code: "NETWORK_ERROR", retryable: true });
    } finally {
      release?.();
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function searchPosts({
    keyword,
    gameId = defaultGameId,
    page = 1,
    pageSize = 15,
    orderType = 0,
    authorType = 0,
    isAllGame = false,
    scene = "SCENE_GENERAL",
    language = defaultLanguage,
    signal
  } = {}) {
    const term = String(keyword ?? "").trim();
    if (!term) throw new HoYoLabApiError("keyword is required");
    const url = new URL(endpoints.searchPosts);
    setIfDefined(url, "author_type", safeEnumInteger(authorType, 0, SEARCH_AUTHOR_TYPE_VALUES));
    setIfDefined(url, "game_id", safeInteger(gameId, defaultGameId, { min: 0, max: 100000 }));
    setIfDefined(url, "is_all_game", Boolean(isAllGame));
    setIfDefined(url, "keyword", term);
    setIfDefined(url, "order_type", safeEnumInteger(orderType, 0, SEARCH_ORDER_TYPE_VALUES));
    setIfDefined(url, "page_num", safeInteger(page, 1, { min: 1, max: 10000 }));
    setIfDefined(url, "page_size", safeInteger(pageSize, 15, { min: 1, max: 50 }));
    setIfDefined(url, "scene", scene || "SCENE_GENERAL");
    return get(url.toString(), { language, signal });
  }

  // The Wiki search endpoint shares the community service but returns both posts and entry-page candidates.
  async function searchWiki({
    keyword,
    gameId = defaultGameId,
    page = 1,
    pageSize = 15,
    orderType = 0,
    authorType = 0,
    isAllGame = false,
    language = defaultLanguage,
    signal
  } = {}) {
    const term = String(keyword ?? "").trim();
    if (!term) throw new HoYoLabApiError("keyword is required");
    const url = new URL(endpoints.searchWiki);
    setIfDefined(url, "author_type", safeEnumInteger(authorType, 0, SEARCH_AUTHOR_TYPE_VALUES));
    setIfDefined(url, "game_id", safeInteger(gameId, defaultGameId, { min: 0, max: 100000 }));
    setIfDefined(url, "is_all_game", Boolean(isAllGame));
    setIfDefined(url, "keyword", term);
    setIfDefined(url, "order_type", safeEnumInteger(orderType, 0, SEARCH_ORDER_TYPE_VALUES));
    setIfDefined(url, "page_num", safeInteger(page, 1, { min: 1, max: 10000 }));
    setIfDefined(url, "page_size", safeInteger(pageSize, 15, { min: 1, max: 50 }));
    return get(url.toString(), { language, signal });
  }

  // Article reads include the flags required by the public full-post endpoint.
  async function getArticle({ postId, language = defaultLanguage, signal } = {}) {
    const id = stringId(postId, "postId");
    const url = new URL(endpoints.article);
    setIfDefined(url, "post_id", id);
    setIfDefined(url, "read", 1);
    setIfDefined(url, "scene", 1);
    return get(url.toString(), { language, signal });
  }

  // Reply pagination is kept independent from article retrieval because reply bodies have their own rich-text fields.
  async function getReplies({
    postId,
    listType = 1,
    size = 15,
    page = 1,
    lastId,
    language = defaultLanguage,
    signal
  } = {}) {
    const id = stringId(postId, "postId");
    const cursor = lastId === undefined ? "0" : normalizeReplyCursor(lastId);
    if (!cursor) throw new HoYoLabApiError("lastId must be a nonempty string cursor or a nonnegative safe integer, of at most 128 characters", { code: "INVALID_SELECTION" });
    if (Number(page) > 1 && cursor === "0") throw new HoYoLabApiError("Reply pages after the first require last_id from the preceding response; page numbers alone do not advance the API", { code: "INVALID_SELECTION" });
    const url = new URL(endpoints.replies);
    setIfDefined(url, "list_type", safeInteger(listType, 1, { min: 0, max: 10 }));
    setIfDefined(url, "post_id", id);
    setIfDefined(url, "size", safeInteger(size, 15, { min: 1, max: 50 }));
    // The endpoint advances with its returned cursor, not page/page_num or the last reply's ID.
    setIfDefined(url, "last_id", cursor);
    return get(url.toString(), { language, signal });
  }

  // Wiki reads identify the target game through both the URL path and the x-rpc-wiki_app header.
  async function getWiki({ wikiApp = "genshin", entryPageId, language = defaultLanguage, signal } = {}) {
    const app = String(wikiApp ?? "").trim();
    if (!/^[a-z0-9_-]+$/i.test(app)) throw new HoYoLabApiError("wikiApp must contain only letters, numbers, '_' or '-'");
    const id = stringId(entryPageId, "entryPageId");
    const url = new URL(`${endpoints.wiki}/${encodeURIComponent(app)}/wapi/entry_page`);
    setIfDefined(url, "entry_page_id", id);
    return get(url.toString(), {
      language,
      headers: { "x-rpc-wiki_app": app },
      signal
    });
  }

  return Object.freeze({ searchPosts, searchWiki, getArticle, getReplies, getWiki, defaultLanguage: normalizeHoYoLabLanguage(defaultLanguage) });
}
