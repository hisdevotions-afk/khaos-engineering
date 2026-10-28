import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "incur";
import writeFileAtomic from "write-file-atomic";

import { ApiMapService } from "../application/ApiMapService.js";
import { createWebNetworkCaptureService } from "../composition/webNetworkCaptures.js";
import { API_MAP_FORMATS, type ApiMapReport } from "../domain/apiMap.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Expose the one-shot capture-to-API-map workflow with CLI-only file output. */
export const registerApiMapCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = new ApiMapService(
    createWebNetworkCaptureService(environment),
  );
  cli.command(CLI_COMMANDS.mapApi, {
    description:
      "Build an enriched API map, OpenAPI 3.1 document and TypeScript client from a retained HAR, native mitmproxy or Fiddler SAZ capture",
    args: z.object({
      capturePath: z.string().describe("Absolute local capture path"),
      format: z.enum(API_MAP_FORMATS).describe("Producer capture format"),
    }),
    options: z.object({
      detail: z
        .enum(["map", "openapi", "client", "complete"])
        .default("complete")
        .describe(
          "map returns the grouped surface, openapi/client add generated artifacts, complete returns everything",
        ),
      includeBodies: z
        .boolean()
        .default(true)
        .describe("Infer request and response body field names and types"),
      sensitiveValue: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Literal string values explicitly marked sensitive; repeat as needed",
        ),
      outDir: z
        .string()
        .optional()
        .describe(
          "Absolute directory to write api-map.json, openapi.json and client.ts instead of printing them",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.mapApi, async () => {
          const outDir =
            options.outDir === undefined ? undefined : resolve(options.outDir);
          const detail = outDir === undefined ? options.detail : "complete";
          const result = await finishAnalysisCommand(
            () =>
              service.map(
                {
                  capture_path: args.capturePath,
                  format: args.format,
                  sensitive_values: options.sensitiveValue,
                  detail,
                  include_bodies: options.includeBodies,
                },
                { signal },
              ),
            service,
            "rea-api-map",
            "map_api",
            "API map resources",
          );
          if (!("normalized_result" in result)) return result;
          const report = result.normalized_result as unknown as ApiMapReport;
          if (outDir === undefined) return report;
          await mkdir(outDir, { recursive: true });
          const files = ["api-map.json", "openapi.json", "client.ts"] as const;
          const mapDocument = {
            capture: report.capture,
            summary: report.summary,
            groups: report.groups,
            limitations: report.limitations,
          };
          await writeFileAtomic(
            resolve(outDir, "api-map.json"),
            `${JSON.stringify(mapDocument, null, 2)}\n`,
          );
          await writeFileAtomic(
            resolve(outDir, "openapi.json"),
            `${JSON.stringify(report.openapi ?? {}, null, 2)}\n`,
          );
          await writeFileAtomic(
            resolve(outDir, "client.ts"),
            report.typescript_client ?? "",
          );
          return {
            output_dir: outDir,
            files,
            summary: report.summary,
            limitations: report.limitations,
          };
        }),
      ),
  });
};
