import { describe, expect, it } from "vitest";

import { buildApiMap, type ApiMapReport } from "./apiMap.js";
import { toOpenApiDocument, toTypeScriptClient } from "./apiMapGenerate.js";
import type { WebNetworkCapture } from "./webNetworkCapture.js";

const decoder = {
  id: "test-decoder",
  name: "Test decoder",
  version: "1",
} as const;

const capture = (
  format: WebNetworkCapture["format"],
  records: WebNetworkCapture["records"],
): WebNetworkCapture =>
  ({
    format,
    decoder,
    container: {
      reported: null,
      numeric_literals: [],
      redactions: [],
      records_pointer: null,
    },
    total_records: records.length,
    records,
    artifact: { path: "/fixtures/capture", sha256: "a".repeat(64), bytes: 1 },
    runtime_attribution: "unknown",
    limitations: [],
  }) as WebNetworkCapture;

const record = (
  ordinal: number,
  reported: unknown,
): WebNetworkCapture["records"][number] => ({
  ordinal,
  location: { kind: "json-pointer", pointer: `/records/${ordinal}` },
  reported: reported as WebNetworkCapture["records"][number]["reported"],
  binary_fields: [],
  numeric_literals: [],
  redactions: [],
  limitations: [],
});

describe("buildApiMap", () => {
  it("groups HAR requests and infers query, body and response fields", () => {
    const report = buildApiMap(
      capture("har", [
        record(0, {
          request: {
            method: "GET",
            url: "https://api.example.test/users/42?include=roles",
            headers: [],
          },
          response: {
            status: 200,
            content: {
              mimeType: "application/json; charset=utf-8",
              text: JSON.stringify({ id: 42, active: true, roles: ["admin"] }),
            },
          },
        }),
        record(1, {
          request: {
            method: "POST",
            url: "https://api.example.test/users",
            headers: [{ name: "content-type", value: "application/json" }],
            postData: {
              mimeType: "application/json",
              text: JSON.stringify({
                email: "a@example.test",
                profile: { displayName: "A" },
              }),
            },
          },
          response: {
            status: 201,
            content: { mimeType: "application/json", text: '{"ok":true}' },
          },
        }),
      ]),
    );

    expect(report.capture.examined_records).toBe(2);
    expect(report.summary.origins).toEqual(["https://api.example.test"]);
    expect(report.summary.query_parameters).toEqual(["include"]);
    const getGroup = report.groups.find(
      (group) => group.path_template === "/users/{numeric}",
    );
    expect(getGroup?.method).toBe("GET");
    expect(getGroup?.templated_segments[0]?.observed_values).toEqual(["42"]);
    expect(getGroup?.statuses).toEqual([200]);
    expect(getGroup?.response_body_fields).toContainEqual({
      path: "roles[]",
      types: ["string"],
    });
    const postGroup = report.groups.find(
      (group) => group.path_template === "/users" && group.method === "POST",
    );
    expect(postGroup?.request_body_fields).toContainEqual({
      path: "profile.displayName",
      types: ["string"],
    });
    expect(postGroup?.flags).toContain("has-request-body");
  });

  it("extracts native mitmproxy request lines", () => {
    const report = buildApiMap(
      capture("mitmproxy", [
        record(0, {
          request: {
            method: "GET",
            scheme: "https",
            host: "api.example.test",
            port: 443,
            path: "/orders/8812",
            headers: [["accept", "application/json"]],
          },
          response: {
            status_code: 200,
            headers: [["content-type", "application/json"]],
            content: '{"total":10}',
          },
        }),
      ]),
    );
    expect(report.summary.origins).toEqual(["https://api.example.test"]);
    expect(report.groups[0]?.path_template).toBe("/orders/{numeric}");
    expect(report.groups[0]?.response_body_fields).toContainEqual({
      path: "total",
      types: ["number"],
    });
  });

  it("extracts SAZ request lines and GraphQL operations", () => {
    const report = buildApiMap(
      capture("saz", [
        record(0, {
          request: {
            method: "POST",
            url: "https://api.example.test/graphql",
            headers: [{ name: "content-type", value: "application/json" }],
            body: JSON.stringify({
              operationName: "GetUser",
              query: "query GetUser($id: ID!) { user(id: $id) { id } }",
              variables: { id: "42" },
            }),
          },
          response: {
            status: "200",
            headers: [{ name: "content-type", value: "application/json" }],
            body: '{"data":{"user":{"id":"42"}}}',
          },
        }),
      ]),
    );
    expect(report.groups[0]?.graphql_operations).toEqual(["GetUser"]);
    expect(report.groups[0]?.flags).toContain("graphql");
    expect(report.groups[0]?.statuses).toEqual([200]);
  });

  it("extracts HAR form parameter names when raw body text is absent", () => {
    const report = buildApiMap(
      capture("har", [
        record(0, {
          request: {
            method: "POST",
            url: "https://api.example.test/login",
            headers: [],
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              params: [
                { name: "username", value: "a" },
                { name: "password", value: "b" },
              ],
            },
          },
          response: { status: 302 },
        }),
      ]),
    );
    expect(report.groups[0]?.request_body_fields).toEqual([
      { path: "password", types: ["string"] },
      { path: "username", types: ["string"] },
    ]);
  });
});

describe("buildApiMap generated artifacts", () => {
  it("generates OpenAPI paths and a TypeScript client", () => {
    const report: ApiMapReport = buildApiMap(
      capture("har", [
        record(0, {
          request: { method: "GET", url: "https://api.example.test/users/42" },
          response: { status: 200, content: { mimeType: "application/json" } },
        }),
      ]),
    );
    const openapi = toOpenApiDocument(report) as {
      paths: Record<string, { get: { parameters: unknown[] } }>;
    };
    const path = openapi.paths["/users/{numeric_0}"];
    expect(path).toBeDefined();
    expect(path?.get.parameters).toContainEqual(
      expect.objectContaining({ name: "numeric_0", in: "path" }),
    );
    const client = toTypeScriptClient(report);
    expect(client).toContain("export const createApiClient");
    expect(client).toContain("getUsersNumeric");
    expect(client).toContain('"/users/{numeric_0}"');
  });
});
