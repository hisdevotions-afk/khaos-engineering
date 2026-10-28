import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import type { JsonShape } from "../domain/jsonShape.js";
import type { RobotsGroup } from "../domain/webCrawlRobots.js";

/** One fetched resource reduced to crawling-relevant facts. */
export interface FetchedWebPage {
  readonly url: string;
  readonly origin: string;
  readonly status: number | null;
  readonly contentType: string | null;
  readonly title: string | null;
  /** Parsed outbound links, in document order, deduplicated and normalized. */
  readonly links: readonly string[];
  /** Forms with resolved action, method and field names/types. */
  readonly forms: readonly FetchedWebForm[];
  /** Absolute or relative script source references found in the document. */
  readonly scriptSources: readonly string[];
  /** Retrieved inline and linked script text, each with its source URL. */
  readonly scripts: readonly FetchedWebScript[];
  /** JSON-LD schema type names declared in the document. */
  readonly jsonLdSchemas: readonly string[];
  /** Structural shape of a JSON response body when applicable. */
  readonly responseBodyShape: JsonShape | null;
}

export interface FetchedWebForm {
  readonly action: string;
  readonly method: string;
  readonly fields: readonly {
    readonly name: string;
    readonly type: string | null;
  }[];
}

export interface FetchedWebScript {
  readonly sourceUrl: string;
  readonly text: string;
}

/** One fetched text resource such as a script or API description. */
export interface FetchedWebText {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly text: string;
}

/** Per-crawl transport limits and scope; the port enforces them on every hop. */
export interface CrawlFetchPolicy {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Decides whether a redirect target is still inside the crawl scope. */
  readonly admitRedirect: (url: URL) => boolean;
}

/**
 * Replaceable HTTP transport used by the crawl service. Implementations fetch
 * ordinary HTTP(S) resources and decode them into crawl-relevant facts without
 * executing any JavaScript.
 */
export interface WebCrawlPort {
  fetchPage(
    url: string,
    policy: CrawlFetchPolicy,
    options?: ExecutionOptions,
  ): Promise<Result<FetchedWebPage, AnalysisError>>;
  fetchText(
    url: string,
    policy: CrawlFetchPolicy,
    options?: ExecutionOptions,
  ): Promise<Result<FetchedWebText, AnalysisError>>;
  fetchRobotsTxt(
    origin: string,
    policy: CrawlFetchPolicy,
    options?: ExecutionOptions,
  ): Promise<Result<readonly RobotsGroup[], AnalysisError>>;
  close?(): Promise<void>;
}
