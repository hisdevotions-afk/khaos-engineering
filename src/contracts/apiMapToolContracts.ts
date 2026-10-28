import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { apiMapInputSchema, apiMapReportSchema } from "../domain/apiMap.js";

/** One-shot capture-to-API-map contracts shared by CLI and MCP. */
export const API_MAP_TOOL_CONTRACTS = [
  {
    name: "map_api",
    ...toolContractMetadata("map_api"),
    description:
      "Build an enriched API map, OpenAPI 3.1 document and TypeScript client from one retained local HAR, native mitmproxy or Fiddler SAZ capture, without contacting recorded URLs. Groups requests by method, origin and inferred path template; reports query parameter names, request and response body field names and types, content types, observed statuses, GraphQL operation names and source record ordinals. Credential values are excluded by the capture decoder and only names and shapes are projected. Use detail map for the grouped surface, openapi or client for one generated artifact, or complete for everything. qlog is unsupported because it exposes transport facts without HTTP request lines. Use inspect_web_network_capture first when you need exact record bodies or headers.",
    kind: "application",
    inputSchema: apiMapInputSchema,
    outputSchema: evidenceResultOf(apiMapReportSchema),
    examples: [
      {
        title: "Map a HAR capture to endpoints and generate a client",
        input: {
          capture_path: "/captures/session.har",
          format: "har",
          detail: "complete",
          include_bodies: true,
        },
      },
      {
        title: "Map a native mitmproxy capture without body inference",
        input: {
          capture_path: "/captures/session.mitm",
          format: "mitmproxy",
          detail: "map",
          include_bodies: false,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
