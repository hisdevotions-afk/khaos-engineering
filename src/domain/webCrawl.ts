import { z } from "zod";
import { jsonShapeSchema } from "./jsonShape.js";

/**
 * Active website crawling: discover pages, links, forms and API endpoint
 * candidates directly by fetching a target site. Complements the passive CDP
 * website tools when no app, account, or open browser session is available.
 */

/** Complete crawl evidence budgets; exceeding a budget returns no partial report. */
export const WEB_CRAWL_LIMITS = {
  inputBytes: 32 * 1024 * 1024,
  outputBytes: 96 * 1024 * 1024,
  fetchTimeoutMs: 30_000,
  maxPages: 256,
  maxDepth: 16,
  maxFetchedBytes: 4 * 1024 * 1024,
  maxScripts: 256,
} as const;

/** A normalized absolute HTTP(S) URL used as a crawl seed. */
export const crawlSeedUrlSchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause: unknown) {
      void cause;
      context.addIssue({
        code: "custom",
        message: "Invalid start URL",
      });
      return z.NEVER;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "Start URL must be an HTTP(S) URL without userinfo",
      });
      return z.NEVER;
    }
    return url.href;
  });

/** One crawled page, reduced to reverse-engineering-relevant signal only. */
const crawledPageSchema = z.strictObject({
  url: z.string(),
  origin: z.string(),
  depth: z.number().int().nonnegative(),
  status: z.number().int().nonnegative().nullable(),
  content_type: z.string().nullable(),
  title: z.string().nullable(),
  links: z.array(z.string()),
  forms: z.array(
    z.strictObject({
      action: z.string(),
      method: z.string(),
      fields: z.array(
        z.strictObject({
          name: z.string(),
          type: z.string().nullable(),
        }),
      ),
    }),
  ),
  scripts: z.array(z.string()),
  json_ld_schemas: z.array(z.string()),
  response_body_shape: jsonShapeSchema.nullable(),
});

/** A discovered API endpoint candidate with template normalization. */
const endpointCandidateSchema = z.strictObject({
  method: z.string(),
  url: z.string(),
  origin: z.string(),
  path_template: z.string(),
  templated_segments: z.array(
    z.strictObject({
      segment_index: z.number().int().nonnegative(),
      rule: z.enum(["numeric", "uuid", "hex", "iso-date"]),
      observed_values: z.array(z.string()),
    }),
  ),
  source: z.enum(["html-form", "script-call", "openapi"]),
});

const robotsRuleSchema = z.strictObject({
  user_agent: z.string(),
  allow: z.array(z.string()),
  disallow: z.array(z.string()),
});

const exclusionSchema = z.strictObject({
  url: z.string(),
  reason: z.enum([
    "out-of-scope-origin",
    "path-disallowed",
    "robots-disallowed",
    "depth-exceeded",
    "page-budget-exceeded",
    "fetch-failure",
    "unsupported-content",
    "too-large",
  ]),
});

/** Result of one crawl: page inventory, endpoint candidates and frontier state. */
export const webCrawlReportSchema = z.strictObject({
  start_url: z.string(),
  examined_pages: z.number().int().nonnegative(),
  total_discovered_links: z.number().int().nonnegative(),
  pages: z.array(crawledPageSchema),
  endpoint_candidates: z.array(endpointCandidateSchema),
  robots_rules: z.array(robotsRuleSchema),
  exclusions: z.array(exclusionSchema),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
});

export type WebCrawlReport = z.infer<typeof webCrawlReportSchema>;
export type CrawledPage = WebCrawlReport["pages"][number];
export type EndpointCandidate = WebCrawlReport["endpoint_candidates"][number];

/** Caller-visible crawl input schema. */
export const crawlWebSiteInputSchema = z.strictObject({
  start_url: crawlSeedUrlSchema,
  max_pages: z
    .number()
    .int()
    .positive()
    .max(WEB_CRAWL_LIMITS.maxPages)
    .default(WEB_CRAWL_LIMITS.maxPages)
    .describe("Maximum number of pages to fetch and inspect"),
  max_depth: z
    .number()
    .int()
    .nonnegative()
    .max(WEB_CRAWL_LIMITS.maxDepth)
    .default(WEB_CRAWL_LIMITS.maxDepth)
    .describe("Maximum link depth from the start URL"),
  same_origin: z
    .boolean()
    .default(true)
    .describe("Restrict crawling to the start URL's origin"),
  allowed_origins: z
    .array(crawlSeedUrlSchema)
    .default([])
    .describe(
      "Additional origins allowed only when same_origin is false; each must be an HTTP(S) URL",
    ),
  path_patterns: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Substring path patterns; when non-empty, only matching paths are fetched",
    ),
  respect_robots: z
    .boolean()
    .default(false)
    .describe(
      "Honor robots.txt disallow rules for a default user agent; disabled by default so authorized security testing is not limited by the target's crawler policy",
    ),
  user_agent: z
    .string()
    .max(256)
    .optional()
    .describe("User agent header to send; defaults to a REA identifier"),
  fetch_timeout_ms: z
    .number()
    .int()
    .positive()
    .max(WEB_CRAWL_LIMITS.fetchTimeoutMs)
    .default(WEB_CRAWL_LIMITS.fetchTimeoutMs)
    .describe("Per-request timeout in milliseconds"),
  max_fetched_bytes: z
    .number()
    .int()
    .positive()
    .max(WEB_CRAWL_LIMITS.maxFetchedBytes)
    .default(WEB_CRAWL_LIMITS.maxFetchedBytes)
    .describe("Maximum response body bytes retained per page"),
  include_links: z.boolean().default(true),
  include_forms: z.boolean().default(true),
  include_scripts: z.boolean().default(true),
  include_json_ld: z.boolean().default(true),
  include_response_shapes: z.boolean().default(true),
  include_script_calls: z
    .boolean()
    .default(true)
    .describe(
      "Derive endpoint candidates from fetch/XHR call sites in inline and linked scripts",
    ),
  max_scripts: z
    .number()
    .int()
    .nonnegative()
    .max(WEB_CRAWL_LIMITS.maxScripts)
    .default(64)
    .describe(
      "Maximum linked scripts to download for call-site analysis across the whole crawl",
    ),
  probe_well_known: z
    .boolean()
    .default(true)
    .describe(
      "Also fetch /openapi.json, /swagger.json, /v3/api-docs and /sitemap.xml per origin to seed endpoints and pages",
    ),
  sensitive_values: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Literal text excluded from retained page content and endpoint candidates",
    ),
});

export type CrawlWebSiteInput = z.infer<typeof crawlWebSiteInputSchema>;

/**
 * Infer a path-template rule for one path segment, mirroring the api-surface
 * grouping rules so crawled endpoints speak the same template vocabulary.
 */
export const inferPathSegmentRule = (
  value: string,
): "numeric" | "uuid" | "hex" | "iso-date" | null => {
  if (/^[0-9]+$/u.test(value)) return "numeric";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    return "uuid";
  if (/^[0-9a-f]{32,}$/iu.test(value)) return "hex";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    )
      return "iso-date";
  }
  return null;
};

/** Project a pathname into a template plus templated segment descriptors. */
export const templatePathSegments = (
  pathname: string,
): {
  template: string;
  segments: Array<{
    segment_index: number;
    rule: "numeric" | "uuid" | "hex" | "iso-date";
    observed_values: string[];
  }>;
} => {
  const segments: Array<{
    segment_index: number;
    rule: "numeric" | "uuid" | "hex" | "iso-date";
    observed_value: string;
  }> = [];
  let index = 0;
  let start = 1;
  const parts: string[] = [];
  let copied = 0;
  for (;;) {
    const slash = pathname.indexOf("/", start);
    const end = slash < 0 ? pathname.length : slash;
    const value = pathname.slice(start, end);
    const rule = inferPathSegmentRule(value);
    if (rule !== null) {
      parts.push(pathname.slice(copied, start), `{${rule}}`);
      segments.push({
        segment_index: index,
        rule,
        observed_value: value,
      });
      copied = end;
    }
    if (slash < 0) break;
    start = slash + 1;
    index += 1;
  }
  if (segments.length === 0) return { template: pathname, segments: [] };
  parts.push(pathname.slice(copied));
  return {
    template: parts.join(""),
    segments: segments.map((segment) => ({
      segment_index: segment.segment_index,
      rule: segment.rule,
      observed_values: [segment.observed_value],
    })),
  };
};
