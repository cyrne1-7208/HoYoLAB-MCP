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

const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;

// HoYoLAB uses locale headers to select multilingual article, reply, and Wiki responses.

export class HoYoLabApiError extends Error {
  constructor(message, { status, url, retcode, cause } = {}) {
    super(message, { cause });
    this.name = "HoYoLabApiError";
    this.status = status;
    this.url = url;
    this.retcode = retcode;
  }
}

function assertLanguage(language) {
  if (language === undefined || language === null || language === "") return;
  if (!LANGUAGE_PATTERN.test(language)) {
    throw new HoYoLabApiError(`Invalid language: ${language}`);
  }
}

function safeInteger(value, fallback, { min, max }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function stringId(value, name) {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) throw new HoYoLabApiError(`${name} must be a numeric ID`);
  return id;
}

function setIfDefined(url, key, value) {
  if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
}

function languageHeaders(language, extra = {}) {
  assertLanguage(language);
  const headers = { accept: "application/json", ...extra };
  if (language) {
    headers["x-rpc-language"] = language;
    headers["accept-language"] = language;
  }
  return headers;
}

// Normalize timeout failures to the same public error type as HTTP and API-level failures.
function abortError(url, timeoutMs) {
  return new HoYoLabApiError(`HoYoLAB request timed out after ${timeoutMs}ms`, { url });
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
  endpoints = HOYOLAB_ENDPOINTS
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  const requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;

  async function get(url, { language = defaultLanguage, headers = {}, signal } = {}) {
    assertLanguage(language);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: languageHeaders(language, headers),
        signal: controller.signal
      });
      // Parse the complete response before checking the API return code so callers receive useful error details.
      const bodyText = await response.text();
      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch (error) {
        throw new HoYoLabApiError("HoYoLAB returned a non-JSON response", {
          status: response.status,
          url,
          cause: error
        });
      }
      if (!response.ok) {
        throw new HoYoLabApiError(`HoYoLAB returned HTTP ${response.status}`, {
          status: response.status,
          url,
          retcode: payload?.retcode
        });
      }
      if (payload && typeof payload.retcode === "number" && payload.retcode !== 0) {
        throw new HoYoLabApiError(payload.message || `HoYoLAB returned retcode ${payload.retcode}`, {
          status: response.status,
          url,
          retcode: payload.retcode
        });
      }
      return { payload, data: unwrapApiResponse(payload), url, status: response.status };
    } catch (error) {
      if (error?.name === "AbortError") throw abortError(url, requestTimeoutMs);
      if (error instanceof HoYoLabApiError) throw error;
      throw new HoYoLabApiError(`HoYoLAB request failed: ${error instanceof Error ? error.message : String(error)}`, { url, cause: error });
    } finally {
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
    setIfDefined(url, "author_type", safeInteger(authorType, 0, { min: 0, max: 10 }));
    setIfDefined(url, "game_id", safeInteger(gameId, defaultGameId, { min: 0, max: 100000 }));
    setIfDefined(url, "is_all_game", Boolean(isAllGame));
    setIfDefined(url, "keyword", term);
    setIfDefined(url, "order_type", safeInteger(orderType, 0, { min: 0, max: 10 }));
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
    setIfDefined(url, "author_type", safeInteger(authorType, 0, { min: 0, max: 10 }));
    setIfDefined(url, "game_id", safeInteger(gameId, defaultGameId, { min: 0, max: 100000 }));
    setIfDefined(url, "is_all_game", Boolean(isAllGame));
    setIfDefined(url, "keyword", term);
    setIfDefined(url, "order_type", safeInteger(orderType, 0, { min: 0, max: 10 }));
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
    language = defaultLanguage,
    signal
  } = {}) {
    const id = stringId(postId, "postId");
    const url = new URL(endpoints.replies);
    setIfDefined(url, "list_type", safeInteger(listType, 1, { min: 0, max: 10 }));
    setIfDefined(url, "post_id", id);
    setIfDefined(url, "size", safeInteger(size, 15, { min: 1, max: 50 }));
    setIfDefined(url, "page", safeInteger(page, 1, { min: 1, max: 10000 }));
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

  return Object.freeze({ searchPosts, searchWiki, getArticle, getReplies, getWiki });
}
