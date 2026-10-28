import type { EndpointCandidate } from "./webCrawl.js";

/** Conventional per-origin documents that enumerate an API or the site's pages. */
export const WELL_KNOWN_PROBE_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/v3/api-docs",
  "/api-docs",
  "/sitemap.xml",
] as const;

const OPENAPI_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
] as const;
const MAX_SPEC_ENDPOINTS = 2000;
const MAX_SITEMAP_LOCATIONS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Enumerate method and path pairs declared by an OpenAPI 3 or Swagger 2 JSON document. */
export const openApiEndpointCandidates = (
  text: string,
  specUrl: URL,
): EndpointCandidate[] => {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (
    !isRecord(doc) ||
    !isRecord(doc["paths"]) ||
    (typeof doc["openapi"] !== "string" && typeof doc["swagger"] !== "string")
  )
    return [];
  let origin = specUrl.origin;
  let prefix = "";
  const servers = doc["servers"];
  const server = Array.isArray(servers) ? servers[0] : undefined;
  if (isRecord(server) && typeof server["url"] === "string") {
    try {
      const resolved = new URL(server["url"], specUrl);
      origin = resolved.origin;
      prefix = resolved.pathname.replace(/\/$/u, "");
    } catch {
      // A malformed server URL falls back to the document's own origin.
    }
  } else if (typeof doc["basePath"] === "string") {
    prefix = doc["basePath"].replace(/\/$/u, "");
  }
  const candidates: EndpointCandidate[] = [];
  for (const [path, item] of Object.entries(doc["paths"])) {
    if (!isRecord(item) || !path.startsWith("/")) continue;
    for (const method of OPENAPI_METHODS) {
      if (!(method in item)) continue;
      if (candidates.length >= MAX_SPEC_ENDPOINTS) return candidates;
      candidates.push({
        method: method.toUpperCase(),
        url: `${origin}${prefix}${path}`,
        origin,
        path_template: `${prefix}${path}`,
        templated_segments: [],
        source: "openapi",
      });
    }
  }
  return candidates;
};

/** Read page URLs from a urlset sitemap; nested sitemap indexes are not followed. */
export const sitemapLocations = (text: string): string[] => {
  const locations: string[] = [];
  for (const match of text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gu)) {
    const value = (match[1] ?? "").replaceAll("&amp;", "&");
    if (/\.xml(?:\.gz)?(?:\?|$)/u.test(value)) continue;
    locations.push(value);
    if (locations.length >= MAX_SITEMAP_LOCATIONS) break;
  }
  return locations;
};
