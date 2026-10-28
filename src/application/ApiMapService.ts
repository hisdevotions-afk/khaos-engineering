import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  apiMapInputSchema,
  apiMapReportSchema,
  buildApiMap,
  type ApiMapReport,
} from "../domain/apiMap.js";
import {
  toOpenApiDocument,
  toTypeScriptClient,
} from "../domain/apiMapGenerate.js";
import { webNetworkCaptureSchema } from "../domain/webNetworkCapture.js";
import type { WebNetworkCaptureService } from "./WebNetworkCaptureService.js";

const OPERATION = "map_api";

/** Provider identity for the derived API map. */
export const API_MAP_PROVIDER = {
  id: "rea-api-map",
  name: "REA API map",
  version: "1",
} as const;

const LIMITATIONS = [
  "The API map is derived from retained producer records and does not prove runtime attribution or handler identity.",
  "OpenAPI paths and TypeScript operations are inferred from observed requests; review them before relying on them.",
] as const;

const projectDetail = (
  report: ApiMapReport,
  detail: "map" | "openapi" | "client" | "complete",
): ApiMapReport => ({
  ...report,
  ...(detail === "openapi" || detail === "complete"
    ? { openapi: toOpenApiDocument(report) }
    : {}),
  ...(detail === "client" || detail === "complete"
    ? { typescript_client: toTypeScriptClient(report) }
    : {}),
});

/** Build an enriched API map, OpenAPI document and TypeScript client from one capture. */
export class ApiMapService {
  constructor(readonly captures: WebNetworkCaptureService) {}

  close(): Promise<void> {
    return this.captures.close();
  }

  async map(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = apiMapInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const input = parsed.data;
    const inspected = await this.captures.inspect(
      {
        capture_path: input.capture_path,
        format: input.format,
        sensitive_values: input.sensitive_values,
      },
      options,
    );
    if (!inspected.ok) return inspected;
    const capture = webNetworkCaptureSchema.safeParse(
      inspected.value.normalized_result,
    );
    if (!capture.success)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Capture Evidence does not match the historical capture schema.",
          { cause: capture.error },
        ),
      );
    const report = projectDetail(
      buildApiMap(capture.data, { includeBodies: input.include_bodies }),
      input.detail,
    );
    const validated = apiMapReportSchema.safeParse(report);
    if (!validated.success)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "API map projection produced malformed evidence.",
          { cause: validated.error },
        ),
      );
    const subject = inspected.value.subject;
    const target =
      subject === null
        ? undefined
        : {
            path: subject.local_path,
            sha256: subject.digest.sha256,
            format: "file" as const,
          };
    const parameters = jsonObjectSchema.parse({
      capture_path: input.sensitive_values.some((literal) =>
        input.capture_path.includes(literal),
      )
        ? ""
        : input.capture_path,
      ...(input.sensitive_values.some((literal) =>
        input.format.includes(literal),
      )
        ? {}
        : { format: input.format }),
      detail: input.detail,
      include_bodies: input.include_bodies,
      sensitive_value_count: input.sensitive_values.length,
    });
    return ok(
      createEvidence(target, API_MAP_PROVIDER, {
        operation: OPERATION,
        predicateType: "rea.api-map",
        parameters,
        result: jsonValueSchema.parse(validated.data),
        confidence: "inferred",
        authority: "historical-reference",
        limitations: [...validated.data.limitations, ...LIMITATIONS],
        locations:
          subject === null
            ? []
            : [{ kind: "artifact-path", path: subject.local_path }],
      }),
    );
  }
}
