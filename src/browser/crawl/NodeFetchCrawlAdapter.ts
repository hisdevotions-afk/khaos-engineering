import {
  defaultTreeAdapter,
  parse,
  type DefaultTreeAdapterTypes,
} from "parse5";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type {
  CrawlFetchPolicy,
  FetchedWebForm,
  FetchedWebPage,
  FetchedWebScript,
  FetchedWebText,
  WebCrawlPort,
} from "../../application/WebCrawlPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { inferJsonShape } from "../../domain/jsonShape.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseRobotsTxt, type RobotsGroup } from "../../domain/webCrawlRobots.js";

const OPERATION = "crawl_web_site";
const PROVIDER = "rea-web-crawl";

const MAX_REDIRECTS = 5;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const isJsonContentType = (contentType: string): boolean =>
  /(?:^|[/;]\s*)json(?:$|[/;])/iu.test(contentType);

const failure = (
  reason: string,
  extra: Record<string, string | number> = {},
  cause?: unknown,
): ProviderAdapterError =>
  new ProviderAdapterError(PROVIDER, OPERATION, {
    diagnostics: { reason, ...extra },
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Node fetch transport for the active website crawl. Fetches ordinary HTTP(S)
 * resources and decodes HTML into crawl-relevant facts without executing any
 * JavaScript. Every redirect hop is re-admitted by the caller's policy so a
 * redirect cannot leave the crawl scope.
 */
export class NodeFetchCrawlAdapter implements WebCrawlPort {
  readonly #fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = fetch) {
    this.#fetchFn = fetchFn;
  }

  async fetchPage(
    url: string,
    policy: CrawlFetchPolicy,
    options?: ExecutionOptions,
  ): Promise<Result<FetchedWebPage, AnalysisError>> {
    const fetched = await this.request(url, policy, options);
    if (!fetched.ok) return fetched;
    const { value } = fetched;
    if (value.contentType !== null && isHtmlContentType(value.contentType))
      return ok(
        this.parseHtml(url, value.url, value.status, value.contentType, value.text),
      );
    return ok({
      url: value.url,
      origin: this.originOf(value.url),
      status: value.status,
      contentType: value.contentType,
      title: null,
      links: [],
      forms: [],
      scriptSources: [],
      scripts: [],
      jsonLdSchemas: [],
      responseBodyShape:
        value.contentType !== null && isJsonContentType(value.contentType)
          ? inferJsonShape(value.text)
          : null,
    });
  }

  fetchText(
    url: string,
    policy: CrawlFetchPolicy,
    options?: ExecutionOptions,
  ): Promise<Result<FetchedWebText, AnalysisError>> {
    return this.request(url, policy, options);
  }

  async fetchRobotsTxt(
    origin: string,
    policy: CrawlFetchPolicy,
    options?: ExecutionOptions,
  ): Promise<Result<readonly RobotsGroup[], AnalysisError>> {
    const fetched = await this.request(`${origin}/robots.txt`, policy, options);
    if (fetched.ok) return ok(parseRobotsTxt(fetched.value.text));
    if (fetched.error instanceof AnalysisCancelledError) return fetched;
    // A missing robots.txt means everything is allowed; transport failures stay unknown.
    const status = fetched.error.diagnostics?.["status"];
    return typeof status === "number" && status >= 400 && status < 500
      ? ok([])
      : fetched;
  }

  async close(): Promise<void> {
    // No retained transports to release.
  }

  private async request(
    startUrl: string,
    policy: CrawlFetchPolicy,
    options?: ExecutionOptions,
  ): Promise<Result<FetchedWebText, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      let current = startUrl;
      for (let hop = 0; ; hop += 1) {
        const response = await this.#fetchFn(current, {
          headers: { "user-agent": policy.userAgent },
          signal: controller.signal,
          redirect: "manual",
        });
        const location = response.headers.get("location");
        if (REDIRECT_STATUSES.has(response.status) && location !== null) {
          await response.body?.cancel();
          if (hop >= MAX_REDIRECTS) return err(failure("too_many_redirects"));
          const next = new URL(location, current);
          if (
            (next.protocol !== "http:" && next.protocol !== "https:") ||
            !policy.admitRedirect(next)
          )
            return err(failure("redirect_out_of_scope"));
          current = next.href;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          return err(failure("http_error_status", { status: response.status }));
        }
        const body = await this.readBoundedBody(response.body, policy.maxBytes);
        if (body === null) return err(failure("body_too_large"));
        return ok({
          url: current,
          status: response.status,
          contentType: response.headers.get("content-type"),
          text: body.toString("utf8"),
        });
      }
    } catch (cause: unknown) {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      return err(
        failure(controller.signal.aborted ? "timeout" : "network_error", {}, cause),
      );
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async readBoundedBody(
    body: ReadableStream<Uint8Array> | null,
    maxBytes: number,
  ): Promise<Buffer | null> {
    if (body === null) return Buffer.alloc(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  private originOf(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  }

  private parseHtml(
    sourceUrl: string,
    finalUrl: string,
    status: number,
    contentType: string,
    text: string,
  ): FetchedWebPage {
    const base = finalUrl || sourceUrl;
    const doc = parse(text, { sourceCodeLocationInfo: true });
    const baseHref = this.findBaseHref(doc);
    const resolveUrl = (value: string): string => {
      try {
        const resolved = new URL(value, baseHref ?? base);
        if (resolved.username !== "" || resolved.password !== "") {
          resolved.username = "";
          resolved.password = "";
        }
        resolved.hash = "";
        return resolved.href;
      } catch {
        return value;
      }
    };

    const links: string[] = [];
    const forms: FetchedWebForm[] = [];
    const scriptSources: string[] = [];
    const scripts: FetchedWebScript[] = [];
    const jsonLdSchemas: string[] = [];
    let title: string | null = null;

    const pending: DefaultTreeAdapterTypes.Node[] = [doc];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) continue;
      if (
        defaultTreeAdapter.isElementNode(node) &&
        node.namespaceURI === HTML_NS
      ) {
        const tag = node.tagName;
        if (tag === "a") {
          const href = this.attr(node, "href");
          if (href !== undefined && !href.startsWith("#")) {
            const resolved = resolveUrl(href);
            if (!links.includes(resolved)) links.push(resolved);
          }
        } else if (tag === "area") {
          const href = this.attr(node, "href");
          if (href !== undefined && !href.startsWith("#")) {
            const resolved = resolveUrl(href);
            if (!links.includes(resolved)) links.push(resolved);
          }
        } else if (tag === "form") {
          forms.push(this.parseForm(node, baseHref ?? base));
        } else if (tag === "script") {
          const src = this.attr(node, "src");
          const type = this.attr(node, "type");
          if (type !== null && type !== undefined && type !== "" && !type.includes("javascript")) {
            // Non-JS scripts are skipped.
          } else if (src !== undefined && src !== "") {
            const resolved = resolveUrl(src);
            if (!scriptSources.includes(resolved)) scriptSources.push(resolved);
          } else {
            const inline = this.scriptText(node, text);
            if (inline !== null) scripts.push({ sourceUrl: base, text: inline });
          }
        } else if (tag === "title" && title === null) {
          const child = node.childNodes[0];
          if (child && defaultTreeAdapter.isTextNode(child)) title = child.value.trim();
        }
        // JSON-LD blocks carry their own structured @graph/schema declarations.
        const typeAttr = this.attr(node, "type");
        if (
          typeAttr !== null &&
          typeAttr !== undefined &&
          /application\/(?:ld\+)?json/u.test(typeAttr)
        ) {
          const inline = this.elementText(node, text);
          if (inline !== null) {
            const schema = this.jsonLdSchemaNames(inline);
            for (const name of schema) if (!jsonLdSchemas.includes(name)) jsonLdSchemas.push(name);
          }
        }
      } else if (defaultTreeAdapter.isTextNode(node) && title === null) {
        // Title text handled above via <title> element.
      }
      if ("childNodes" in node) {
        for (const child of node.childNodes.toReversed()) pending.push(child);
      }
    }

    return {
      url: finalUrl || sourceUrl,
      origin: this.originOf(base),
      status,
      contentType,
      title,
      links,
      forms,
      scriptSources,
      scripts,
      jsonLdSchemas,
      responseBodyShape: null,
    };
  }

  private findBaseHref(
    doc: DefaultTreeAdapterTypes.Document,
  ): string | null {
    const pending: DefaultTreeAdapterTypes.Node[] = [doc];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) continue;
      if (
        defaultTreeAdapter.isElementNode(node) &&
        node.tagName === "base" &&
        node.namespaceURI === HTML_NS
      )
        return this.attr(node, "href") || null;
      if ("childNodes" in node)
        for (const child of node.childNodes.toReversed()) pending.push(child);
    }
    return null;
  }

  private parseForm(
    node: DefaultTreeAdapterTypes.Element,
    base: string,
  ): FetchedWebForm {
    const action = this.attr(node, "action") ?? "";
    const method = (this.attr(node, "method") ?? "get").toUpperCase();
    const resolvedAction = (() => {
      try {
        const url = new URL(action, base);
        url.hash = "";
        return url.href;
      } catch {
        return action;
      }
    })();
    const fields: { name: string; type: string | null }[] = [];
    const pending: DefaultTreeAdapterTypes.Node[] = [...node.childNodes.toReversed()];
    while (pending.length > 0) {
      const child = pending.pop();
      if (child === undefined) continue;
      if (defaultTreeAdapter.isElementNode(child)) {
        const tag = child.tagName;
        if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button") {
          const name = this.attr(child, "name") ?? "";
          if (name !== "") {
            const type = tag === "input" ? this.attr(child, "type") ?? "text" : tag;
            if (!fields.some((field) => field.name === name))
              fields.push({ name, type });
          }
        }
        if ("childNodes" in child)
          for (const c of child.childNodes.toReversed()) pending.push(c);
      }
    }
    return { action: resolvedAction, method, fields };
  }

  private attr(
    node: DefaultTreeAdapterTypes.Element,
    name: string,
  ): string | undefined {
    return node.attrs.find((attr) => attr.name === name)?.value;
  }

  private scriptText(
    node: DefaultTreeAdapterTypes.Element,
    source: string,
  ): string | null {
    const location = node.sourceCodeLocation;
    if (location === undefined || location === null) return null;
    const start = location.startOffset;
    const end = location.endOffset;
    if (start === undefined || end === undefined || end <= start) return null;
    let content = source.slice(start, end);
    const close = content.lastIndexOf("</script");
    if (close > 0) content = content.slice(0, close);
    return content;
  }

  private elementText(
    node: DefaultTreeAdapterTypes.Element,
    source: string,
  ): string | null {
    const location = node.sourceCodeLocation;
    if (location === undefined || location === null) return null;
    const start = location.startTag?.endOffset;
    const end = location.endTag?.startOffset;
    if (start === undefined || end === undefined || end <= start) return null;
    return source.slice(start, end).trim();
  }

  private jsonLdSchemaNames(text: string): string[] {
    const names: string[] = [];
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return names;
    }
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collect(item);
      } else if (typeof value === "object" && value !== null) {
        const obj = value as Record<string, unknown>;
        if (typeof obj["@type"] === "string")
          names.push(obj["@type"] as string);
        if (Array.isArray(obj["@graph"])) collect(obj["@graph"]);
      }
    };
    collect(data);
    return names;
  }
}

const isHtmlContentType = (contentType: string): boolean =>
  /text\/html|application\/xhtml\+xml/u.test(contentType);