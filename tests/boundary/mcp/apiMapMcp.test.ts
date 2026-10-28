import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { WebNetworkCaptureService } from "../../../src/application/WebNetworkCaptureService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { apiMapReportSchema } from "../../../src/domain/apiMap.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import type { WebNetworkCapture } from "../../../src/domain/webNetworkCapture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const capture: WebNetworkCapture = {
  artifact: { path: "/capture.har", sha256: "a".repeat(64), bytes: 10 },
  format: "har" as const,
  decoder: { id: "test-capture-port", name: "test port", version: "1" },
  container: {
    reported: null,
    numeric_literals: [],
    redactions: [],
    records_pointer: "/log/entries",
  },
  total_records: 1,
  records: [
    {
      ordinal: 0,
      location: { kind: "json-pointer", pointer: "/log/entries/0" },
      reported: {
        request: {
          method: "GET",
          url: "https://api.example.test/users/42?include=roles",
          headers: [],
        },
        response: {
          status: 200,
          content: { mimeType: "application/json", text: '{"id":42}' },
        },
      },
      binary_fields: [],
      numeric_literals: [],
      redactions: [],
      limitations: [],
    },
  ],
  runtime_attribution: "unknown",
  limitations: ["synthetic application port, no real decoder claim"],
};

it("publishes valid SDK schemas and derives an API map with generated artifacts", async () => {
  const service = new WebNetworkCaptureService({
    inspect: () => Promise.resolve(ok(capture)),
  });
  const session = createTestBinarySession(() => {
    throw new Error("Binary provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { webNetworkCapture: service },
  );
  const client = new Client({ name: "api-map-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "map_api",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("API map must advertise both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const args = {
    capture_path: "/capture.har",
    format: "har",
    detail: "complete",
  };
  expect(ajv.validate(inputSchema, args)).toBe(true);
  const response = await client.callTool({
    name: "map_api",
    arguments: args,
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("map_api").outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed);
  const report = apiMapReportSchema.parse(parsed.normalized_result);
  expect(report.summary.origins).toEqual(["https://api.example.test"]);
  expect(report.summary.query_parameters).toEqual(["include"]);
  expect(report.groups[0]?.path_template).toBe("/users/{numeric}");
  expect(report.openapi).toBeDefined();
  expect(report.typescript_client).toContain("createApiClient");
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  const invalid = await client.callTool({
    name: "map_api",
    arguments: { ...args, capture_path: "relative.har" },
  });
  expect(invalid.isError).toBe(true);
  const invalidSensitive = await client.callTool({
    name: "map_api",
    arguments: {
      ...args,
      sensitive_values: ["secret"],
      mysecret: true,
    },
  });
  expect(invalidSensitive.isError).toBe(true);
  expect(parseMcpToolError(invalidSensitive)).toMatchObject({
    error: { code: "invalid_request", details: { issues: [{ path: [] }] } },
  });
  expect(JSON.stringify(invalidSensitive)).not.toContain("secret");
});
