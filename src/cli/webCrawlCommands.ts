import { z } from "incur";
import { createWebCrawlService } from "../composition/webCrawl.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Expose the active website crawler with the same input contract as MCP. */
export const registerWebCrawlCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.crawlWebSite, {
    description:
      "Crawl a website without a browser, app or account to discover pages, forms, script call sites, OpenAPI documents and API endpoint candidates",
    args: z.object({
      startUrl: z.string().describe("Absolute HTTP(S) URL to start from"),
    }),
    options: z.object({
      maxPages: z.coerce.number().int().positive().optional(),
      maxDepth: z.coerce.number().int().nonnegative().optional(),
      maxScripts: z.coerce.number().int().nonnegative().optional(),
      allowOrigin: z
        .array(z.string())
        .default([])
        .describe(
          "Extra origin to crawl; repeat as needed, implies --no-same-origin",
        ),
      pathPattern: z
        .array(z.string().min(1))
        .default([])
        .describe("Only fetch paths containing this text; repeat as needed"),
      respectRobots: z
        .boolean()
        .default(false)
        .describe("Honor robots.txt disallow rules (ignored by default)"),
      noWellKnown: z.boolean().default(false),
      userAgent: z.string().optional(),
      sensitiveValue: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Literal string values to redact from the report; repeat as needed",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.crawlWebSite, async () => {
          const service = createWebCrawlService();
          return finishAnalysisCommand(
            () =>
              service.crawl(
                {
                  start_url: args.startUrl,
                  same_origin: options.allowOrigin.length === 0,
                  allowed_origins: options.allowOrigin,
                  path_patterns: options.pathPattern,
                  respect_robots: options.respectRobots,
                  probe_well_known: !options.noWellKnown,
                  sensitive_values: options.sensitiveValue,
                  ...(options.maxPages === undefined
                    ? {}
                    : { max_pages: options.maxPages }),
                  ...(options.maxDepth === undefined
                    ? {}
                    : { max_depth: options.maxDepth }),
                  ...(options.maxScripts === undefined
                    ? {}
                    : { max_scripts: options.maxScripts }),
                  ...(options.userAgent === undefined
                    ? {}
                    : { user_agent: options.userAgent }),
                },
                { signal },
              ),
            service,
            "rea-web-crawl",
            "crawl_web_site",
          );
        }),
      ),
  });
};
