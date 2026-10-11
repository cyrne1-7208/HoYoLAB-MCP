import { HoYoLabApiError, normalizeHoYoLabLanguage } from "../hoyolab/api.mjs";
import { createDocument } from "./hoyolab-document.mjs";

// Cache state is explicit and bounded; revisions never depend on a client connection or implicit session.
export function createDocumentStore({ apiClient, freshnessMs = 30000, retentionMs = 300000, maxEntries = 32,
  maxBytes = 32 * 1024 * 1024, now = Date.now } = {}) {
  const cache = new Map();
  const latestGenerations = new Map();
  const pendingIdentities = new Map();
  let bytes = 0;
  let generation = 0;
  function prune() {
    for (const [key, value] of cache) {
      if (now() - value.storedAt >= retentionMs) { cache.delete(key); bytes -= value.bytes; }
    }
    while (cache.size > maxEntries || bytes > maxBytes) {
      const key = cache.keys().next().value;
      const entry = cache.get(key);
      cache.delete(key); bytes -= entry.bytes;
    }
    const identities = new Set([...cache.values()].map((entry) => entry.identity));
    // A completed refresh remains authoritative while an older request can still finish, even if its cache entry is evicted.
    for (const identity of latestGenerations.keys()) if (!identities.has(identity) && !pendingIdentities.has(identity)) latestGenerations.delete(identity);
  }
  return {
    async get({ kind, id, wikiApp, language, revision, refresh = false, signal }) {
      signal?.throwIfAborted();
      if (revision && refresh) throw new HoYoLabApiError("revision pins content; refresh requests the latest content. Specify only one", { code: "INVALID_SELECTION" });
      const requestedLanguage = normalizeHoYoLabLanguage(language || apiClient.defaultLanguage || "");
      const identity = JSON.stringify([kind, wikiApp || "", id, requestedLanguage]);
      prune();
      const candidates = [...cache.entries()].filter(([, entry]) => entry.identity === identity);
      const hit = revision ? candidates.find(([, entry]) => entry.document.revision === revision)
        : candidates.find(([, entry]) => entry.generation > 0 && entry.generation === latestGenerations.get(identity));
      if (hit && (revision || (!refresh && now() - hit[1].storedAt < freshnessMs))) {
        cache.delete(hit[0]); cache.set(hit[0], hit[1]);
        return { document: hit[1].document, cache_hit: true };
      }
      // Start order defines freshness; a slow old request must not replace a completed refresh.
      const requestGeneration = revision ? 0 : ++generation;
      pendingIdentities.set(identity, (pendingIdentities.get(identity) || 0) + 1);
      try {
        const response = kind === "article" ? await apiClient.getArticle({ postId: id, language: requestedLanguage || undefined, signal })
          : await apiClient.getWiki({ wikiApp, entryPageId: id, language: requestedLanguage || undefined, signal });
        signal?.throwIfAborted();
        const document = createDocument(response.payload, { kind, id, wikiApp, language: response.language || requestedLanguage,
          sourceUrl: response.url, retrievedAt: response.retrievedAt || new Date(now()).toISOString() });
        if (revision && revision !== document.revision) throw new HoYoLabApiError("Requested revision is unavailable or expired; obtain a fresh outline and use its revision", { code: "REVISION_UNAVAILABLE" });
        // Eviction or an oversized refresh must not turn a retained older version into the latest.
        if (!revision) latestGenerations.set(identity, Math.max(requestGeneration, latestGenerations.get(identity) || 0));
        const key = identity + document.revision;
        const size = Buffer.byteLength(JSON.stringify(document));
        const previous = cache.get(key);
        if (previous && previous.generation > requestGeneration) return { document, cache_hit: false };
        if (previous) { cache.delete(key); bytes -= previous.bytes; }
        if (size <= maxBytes && maxEntries > 0) {
          cache.set(key, { identity, document, bytes: size, storedAt: now(), generation: requestGeneration }); bytes += size;
        }
        return { document, cache_hit: false };
      } finally {
        const pending = pendingIdentities.get(identity) - 1;
        if (pending) pendingIdentities.set(identity, pending);
        else pendingIdentities.delete(identity);
        prune();
      }
    },
    stats() { prune(); return { entries: cache.size, bytes }; }
  };
}
