import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import {
  crawlWebSiteInputSchema,
  webCrawlReportSchema,
} from "../domain/webCrawl.js";

/** Active website crawling contracts shared by CLI and MCP. */
export const WEB_CRAWL_TOOL_CONTRACTS = [
  {
    name: "crawl_web_site",
    ...toolContractMetadata("crawl_web_site"),
    description:
      "Actively crawl a website by fetching its HTTP(S) pages and, without executing any JavaScript, discover reachable pages, outbound links, HTML forms and their fields, JSON-LD schema declarations, and API endpoint candidates with HTTP methods derived from static fetch/axios/XHR call sites in inline and downloaded linked scripts, plus OpenAPI/Swagger JSON and sitemap.xml published by the site. Optionally derive structural shapes of JSON response bodies. Use it when no app, account or open browser session exists for the target. Ignores robots.txt by default; set respect_robots to true to honor its allow/disallow rules. Honors same-origin scope (including across redirects), path patterns, page, depth, script, timeout and byte budgets. Returns a reduced, redacted report as Evidence; full bodies and binary resources are never retained. JavaScript-rendered routes and runtime requests are not observed; endpoint candidates are static call-site inferences, not confirmed requests.",
    kind: "application",
    inputSchema: crawlWebSiteInputSchema,
    outputSchema: evidenceResultOf(webCrawlReportSchema),
    examples: [
      {
        title: "Crawl one site's reachable pages and discover endpoints",
        input: {
          start_url: "https://app.example.test/",
          max_pages: 32,
          max_depth: 4,
          same_origin: true,
          respect_robots: false,
          include_script_calls: true,
          probe_well_known: true,
          include_forms: true,
          include_response_shapes: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
