import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeFetchCrawlAdapter } from "../browser/crawl/NodeFetchCrawlAdapter.js";
import { parseRobotsTxt, robotsAllows } from "../domain/webCrawlRobots.js";
import { WebCrawlService } from "./WebCrawlService.js";

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );

describe("robots.txt decisions", () => {
  const groups = parseRobotsTxt(
    "User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.json$\n",
  );
  it("applies longest match, allow ties and wildcards", () => {
    expect(robotsAllows(groups, "rea", "/private/x")).toBe(false);
    expect(robotsAllows(groups, "rea", "/private/open/x")).toBe(true);
    expect(robotsAllows(groups, "rea", "/a/b.json")).toBe(false);
    expect(robotsAllows(groups, "rea", "/a/b.json?x=1")).toBe(true);
    expect(robotsAllows(groups, "rea", "/index")).toBe(true);
  });
});

describe("WebCrawlService", () => {
  let site: Server;
  let other: Server;
  let siteUrl: string;
  let otherUrl: string;

  beforeAll(async () => {
    other = createServer((_req, res) =>
      res.end("<html><title>other</title></html>"),
    );
    otherUrl = await listen(other);
    site = createServer((req, res) => {
      const html = (body: string) => {
        res.setHeader("content-type", "text/html");
        res.end(
          `<html><head><title>t</title></head><body>${body}</body></html>`,
        );
      };
      switch (req.url) {
        case "/robots.txt":
          res.end("User-agent: *\nDisallow: /secret\n");
          break;
        case "/":
          html(
            `<a href="/about">a</a><a href="/secret">s</a><a href="/jump">j</a>
             <form action="/login" method="post"><input name="user"><input type="password" name="pw"></form>
             <script src="/app.js"></script>`,
          );
          break;
        case "/about":
          html("<p>about</p>");
          break;
        case "/secret":
          html("<p>secret</p>");
          break;
        case "/jump":
          res.writeHead(302, { location: `${otherUrl}/` });
          res.end();
          break;
        case "/app.js":
          res.setHeader("content-type", "text/javascript");
          res.end(
            `fetch("/api/users/42"); fetch("/api/orders", { method: "POST" }); axios.delete("/api/items/7");`,
          );
          break;
        case "/openapi.json":
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              openapi: "3.0.0",
              paths: { "/v1/things/{id}": { get: {}, put: {} } },
            }),
          );
          break;
        case "/sitemap.xml":
          res.end(
            `<urlset><url><loc>${siteUrl}/from-sitemap</loc></url></urlset>`,
          );
          break;
        case "/from-sitemap":
          html("<p>mapped</p>");
          break;
        default:
          res.statusCode = 404;
          res.end();
      }
    });
    siteUrl = await listen(site);
  });

  afterAll(() => {
    site.close();
    other.close();
  });

  it("maps pages and endpoints from HTML, linked scripts and published specs", async () => {
    const service = new WebCrawlService(new NodeFetchCrawlAdapter());
    const result = await service.crawl({
      start_url: `${siteUrl}/`,
      respect_robots: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.value.normalized_result as unknown as {
      pages: { url: string }[];
      endpoint_candidates: {
        method: string;
        path_template: string;
        source: string;
      }[];
      exclusions: { url: string; reason: string }[];
      robots_rules: unknown[];
    };

    const urls = report.pages.map((page) => page.url);
    expect(urls).toContain(`${siteUrl}/about`);
    expect(urls).toContain(`${siteUrl}/from-sitemap`);
    expect(urls).not.toContain(`${siteUrl}/secret`);
    expect(urls.some((url) => url.startsWith(otherUrl))).toBe(false);
    expect(report.exclusions).toContainEqual({
      url: `${siteUrl}/secret`,
      reason: "robots-disallowed",
    });
    expect(report.exclusions).toContainEqual({
      url: `${siteUrl}/jump`,
      reason: "fetch-failure",
    });

    const endpoints = report.endpoint_candidates.map(
      (e) => `${e.method} ${e.path_template} ${e.source}`,
    );
    expect(endpoints).toContain("POST /login html-form");
    expect(endpoints).toContain("GET /api/users/{numeric} script-call");
    expect(endpoints).toContain("POST /api/orders script-call");
    expect(endpoints).toContain("DELETE /api/items/{numeric} script-call");
    expect(endpoints).toContain("GET /v1/things/{id} openapi");
    expect(endpoints).toContain("PUT /v1/things/{id} openapi");
    expect(report.robots_rules).not.toHaveLength(0);
  });

  it("ignores robots.txt by default and reaches disallowed paths", async () => {
    const service = new WebCrawlService(new NodeFetchCrawlAdapter());
    const result = await service.crawl({ start_url: `${siteUrl}/` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.value.normalized_result as unknown as {
      pages: { url: string }[];
      exclusions: { url: string; reason: string }[];
      robots_rules: unknown[];
    };

    expect(report.pages.map((page) => page.url)).toContain(`${siteUrl}/secret`);
    expect(report.exclusions).not.toContainEqual({
      url: `${siteUrl}/secret`,
      reason: "robots-disallowed",
    });
    expect(report.robots_rules).toHaveLength(0);
  });

  it("redacts sensitive values from the report", async () => {
    const service = new WebCrawlService(new NodeFetchCrawlAdapter());
    const result = await service.crawl({
      start_url: `${siteUrl}/`,
      sensitive_values: ["about"],
    });
    expect(
      result.ok && JSON.stringify(result.value.normalized_result),
    ).not.toContain("/about");
  });
});
