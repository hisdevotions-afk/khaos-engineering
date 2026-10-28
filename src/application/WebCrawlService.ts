import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  crawlWebSiteInputSchema,
  webCrawlReportSchema,
  templatePathSegments,
  type CrawlWebSiteInput,
  type EndpointCandidate,
  type WebCrawlReport,
} from "../domain/webCrawl.js";
import { robotsAllows, type RobotsGroup } from "../domain/webCrawlRobots.js";
import {
  WELL_KNOWN_PROBE_PATHS,
  openApiEndpointCandidates,
  sitemapLocations,
} from "../domain/webCrawlWellKnown.js";
import {
  analyzeWebScriptEndpointCalls,
  endpointCandidateFromCall,
} from "../domain/webScriptEndpointCalls.js";
import type { CrawlFetchPolicy, WebCrawlPort } from "./WebCrawlPort.js";

const OPERATION = "crawl_web_site";
const DEFAULT_USER_AGENT = "rea-web-crawler/1 (+local reverse-engineering tool)";

/** Provider identity for the active website crawl. */
export const WEB_CRAWL_PROVIDER = {
  id: "rea-web-crawl",
  name: "REA active website crawler",
  version: "2",
} as const;

const LIMITATIONS = [
  "Only HTTP(S) responses are fetched and HTML pages are parsed; JavaScript is never executed, so client-rendered routes, XHR-triggered requests and dynamic DOM are not observed.",
  "Endpoint candidates derived from script text reflect static call sites with literal URLs, not confirmed runtime requests; computed or template-string URLs and request bodies are not recovered.",
  "Crawling one reachable page set does not establish completeness of the site's API surface.",
  "Fetched content is retained only as reduced, redacted summary; full bodies and binary resources are never stored.",
] as const;

type Exclusion = WebCrawlReport["exclusions"][number];
type ExclusionReason = Exclusion["reason"];

const agentToken = (userAgent: string): string =>
  (userAgent.split(/[/\s]/u)[0] ?? "*").toLowerCase();

const redactStrings = (value: JsonValue, secrets: readonly string[]): JsonValue => {
  if (typeof value === "string")
    return secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, secrets));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item, secrets)]),
    );
  return value;
};

/**
 * Bounded breadth-first website crawl producing a page inventory plus API
 * endpoint candidates derived from HTML forms, static script call sites in
 * inline and linked scripts, and published OpenAPI documents.
 */
export class WebCrawlService {
  constructor(readonly port: WebCrawlPort) {}

  close(): Promise<void> {
    return this.port.close?.() ?? Promise.resolve();
  }

  async crawl(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = crawlWebSiteInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const { sensitive_values: secrets, ...input } = parsed.data;
    const report = await this.run(parsed.data, options);
    if (!report.ok) return report;
    const redacted = redactStrings(report.value as JsonValue, secrets);
    const validated = webCrawlReportSchema.safeParse(redacted);
    if (!validated.success)
      return err(
        new AnalysisOutputError(OPERATION, "crawl_result_schema_mismatch", {
          cause: validated.error,
        }),
      );
    return ok(
      createEvidence(undefined, WEB_CRAWL_PROVIDER, {
        operation: OPERATION,
        predicateType: "rea.crawl",
        parameters: JSON.parse(JSON.stringify(input)) as Record<string, JsonValue>,
        result: validated.data,
        rawResult: validated.data,
        limitations: [...LIMITATIONS],
      }),
    );
  }

  private async run(
    input: CrawlWebSiteInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebCrawlReport, AnalysisError>> {
    const cancelled = () => options?.signal?.aborted === true;
    const startUrl = new URL(input.start_url);
    const allowedOrigins = new Set<string>([startUrl.origin]);
    if (!input.same_origin)
      for (const origin of input.allowed_origins)
        allowedOrigins.add(new URL(origin).origin);

    const userAgent = input.user_agent ?? DEFAULT_USER_AGENT;
    const token = agentToken(userAgent);
    const policy: CrawlFetchPolicy = {
      userAgent,
      timeoutMs: input.fetch_timeout_ms,
      maxBytes: input.max_fetched_bytes,
      admitRedirect: (url) => allowedOrigins.has(url.origin),
    };

    const pages: WebCrawlReport["pages"] = [];
    const unknowns: string[] = [];
    const robotsRules: WebCrawlReport["robots_rules"] = [];
    const exclusions = new Map<string, Exclusion>();
    const candidates = new Map<string, EndpointCandidate>();
    const exclude = (url: string, reason: ExclusionReason): void => {
      exclusions.set(`${reason} ${url}`, { url, reason });
    };
    const addCandidate = (candidate: EndpointCandidate | null): void => {
      if (candidate !== null)
        candidates.set(`${candidate.method} ${candidate.url}`, candidate);
    };

    const robots = new Map<string, readonly RobotsGroup[]>();
    if (input.respect_robots)
      for (const origin of allowedOrigins) {
        if (cancelled()) return err(new AnalysisCancelledError(OPERATION));
        const groups = await this.port.fetchRobotsTxt(origin, policy, options);
        if (!groups.ok) {
          if (groups.error instanceof AnalysisCancelledError) return groups;
          unknowns.push(`robots.txt unavailable for ${origin}; crawled without it`);
          continue;
        }
        robots.set(origin, groups.value);
        for (const group of groups.value)
          robotsRules.push({
            user_agent: group.agent,
            allow: [...group.allow],
            disallow: [...group.disallow],
          });
      }

    const inScope = (url: URL): ExclusionReason | null => {
      if (!allowedOrigins.has(url.origin)) return "out-of-scope-origin";
      const groups = robots.get(url.origin);
      if (
        groups !== undefined &&
        !robotsAllows(groups, token, url.pathname + url.search)
      )
        return "robots-disallowed";
      return null;
    };
    const pageAdmission = (url: URL): ExclusionReason | null =>
      inScope(url) ??
      (input.path_patterns.length > 0 &&
      !input.path_patterns.some((pattern) => url.pathname.includes(pattern))
        ? "path-disallowed"
        : null);

    const frontier: { url: string; depth: number }[] = [];
    const queued = new Set<string>();
    const enqueue = (url: URL, depth: number): void => {
      if (queued.has(url.href)) return;
      queued.add(url.href);
      frontier.push({ url: url.href, depth });
    };
    enqueue(startUrl, 0);

    if (input.probe_well_known)
      for (const origin of allowedOrigins)
        for (const path of WELL_KNOWN_PROBE_PATHS) {
          if (cancelled()) return err(new AnalysisCancelledError(OPERATION));
          const probe = new URL(path, origin);
          if (inScope(probe) !== null) continue;
          const fetched = await this.port.fetchText(probe.href, policy, options);
          if (!fetched.ok) {
            if (fetched.error instanceof AnalysisCancelledError) return fetched;
            continue;
          }
          if (path === "/sitemap.xml") {
            for (const location of sitemapLocations(fetched.value.text)) {
              const url = this.safeUrl(location);
              if (url === null) continue;
              const reason = pageAdmission(url);
              if (reason !== null) exclude(url.href, reason);
              else enqueue(url, 1);
            }
          } else {
            for (const candidate of openApiEndpointCandidates(
              fetched.value.text,
              new URL(fetched.value.url),
            ))
              addCandidate(candidate);
          }
        }

    const scriptsSeen = new Set<string>();
    let scriptsFetched = 0;
    let scriptBudgetHit = false;
    let examined = 0;
    let discovered = 0;

    while (frontier.length > 0 && examined < input.max_pages) {
      if (cancelled()) return err(new AnalysisCancelledError(OPERATION));
      const current = frontier.shift();
      if (current === undefined) break;
      const url = this.safeUrl(current.url);
      if (url === null) continue;
      const reason = pageAdmission(url);
      if (reason !== null) {
        exclude(url.href, reason);
        continue;
      }

      const fetched = await this.port.fetchPage(url.href, policy, options);
      if (!fetched.ok) {
        if (fetched.error instanceof AnalysisCancelledError) return fetched;
        exclude(url.href, "fetch-failure");
        continue;
      }
      const page = fetched.value;
      examined += 1;

      const links = page.links
        .map((link) => this.safeUrl(link))
        .filter((link): link is URL => link !== null);
      for (const link of links) {
        discovered += 1;
        const linkReason = pageAdmission(link);
        if (linkReason !== null) exclude(link.href, linkReason);
        else if (current.depth + 1 > input.max_depth)
          exclude(link.href, "depth-exceeded");
        else enqueue(link, current.depth + 1);
      }

      pages.push({
        url: page.url,
        origin: page.origin,
        depth: current.depth,
        status: page.status,
        content_type: page.contentType,
        title: page.title,
        links: input.include_links ? links.map((link) => link.href) : [],
        forms: input.include_forms
          ? page.forms.map((form) => ({
              action: form.action,
              method: form.method,
              fields: form.fields.map(({ name, type }) => ({ name, type })),
            }))
          : [],
        scripts: input.include_scripts ? [...page.scriptSources] : [],
        json_ld_schemas: input.include_json_ld ? [...page.jsonLdSchemas] : [],
        response_body_shape: input.include_response_shapes
          ? page.responseBodyShape
          : null,
      });

      for (const form of page.forms) addCandidate(this.endpointFromForm(form, url));

      if (!input.include_script_calls) continue;
      const sources: { text: string }[] = [...page.scripts];
      for (const source of page.scriptSources) {
        if (scriptsSeen.has(source)) continue;
        scriptsSeen.add(source);
        const scriptUrl = this.safeUrl(source);
        if (scriptUrl === null || inScope(scriptUrl) !== null) continue;
        if (scriptsFetched >= input.max_scripts) {
          scriptBudgetHit = true;
          continue;
        }
        scriptsFetched += 1;
        const script = await this.port.fetchText(scriptUrl.href, policy, options);
        if (script.ok) sources.push(script.value);
        else if (script.error instanceof AnalysisCancelledError) return script;
        else exclude(scriptUrl.href, "fetch-failure");
      }
      for (const source of sources)
        for (const call of analyzeWebScriptEndpointCalls(source.text))
          addCandidate(endpointCandidateFromCall(call, url));
    }

    for (const item of frontier) exclude(item.url, "page-budget-exceeded");
    if (frontier.length > 0)
      unknowns.push(
        "Page budget reached before the frontier was exhausted; more pages may exist.",
      );
    if (scriptBudgetHit)
      unknowns.push(
        "Script budget reached; some linked scripts were not downloaded, so their call sites are missing.",
      );

    return ok({
      start_url: input.start_url,
      examined_pages: examined,
      total_discovered_links: discovered,
      pages,
      endpoint_candidates: [...candidates.values()],
      robots_rules: robotsRules,
      exclusions: [...exclusions.values()],
      limitations: [...LIMITATIONS],
      unknowns,
    });
  }

  private safeUrl(value: string): URL | null {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      url.hash = "";
      return url;
    } catch {
      return null;
    }
  }

  private endpointFromForm(
    form: { action: string; method: string },
    base: URL,
  ): EndpointCandidate | null {
    let resolved: URL | null;
    try {
      resolved = this.safeUrl(new URL(form.action, base).href);
    } catch {
      return null;
    }
    if (resolved === null) return null;
    const templated = templatePathSegments(resolved.pathname || "/");
    return {
      method: form.method.length > 0 ? form.method.toUpperCase() : "GET",
      url: resolved.href,
      origin: resolved.origin,
      path_template: templated.template,
      templated_segments: templated.segments,
      source: "html-form",
    };
  }
}
