import type { JsonValue } from "./jsonValue.js";
import type { ApiMapBodyField, ApiMapGroup, ApiMapReport } from "./apiMap.js";

const RULE_SCHEMA: Readonly<Record<string, Record<string, unknown>>> = {
  numeric: { type: "string", pattern: "^[0-9]+$" },
  uuid: { type: "string", format: "uuid" },
  hex: { type: "string", pattern: "^[0-9a-fA-F]{32,}$" },
  "iso-date": { type: "string", format: "date" },
};

const schemaForTypes = (
  types: readonly ApiMapBodyField["types"][number][],
): Record<string, unknown> => {
  const distinct = [...new Set(types)];
  if (distinct.length === 1) {
    const [type] = distinct;
    if (type === undefined) return {};
    if (type === "unknown") return {};
    if (type === "null") return { type: "null" };
    return { type };
  }
  return { anyOf: distinct.map((type) => schemaForTypes([type])) };
};

const bodySchema = (fields: readonly ApiMapBodyField[]): JsonValue => {
  const topLevel = fields.filter(
    (field) => !field.path.includes(".") && !field.path.includes("["),
  );
  return {
    type: "object",
    properties: Object.fromEntries(
      topLevel.map((field) => [field.path, schemaForTypes(field.types)]),
    ),
    additionalProperties: true,
    "x-rea-observed-fields": fields.map((field) => ({
      path: field.path,
      types: [...field.types],
    })),
  } as JsonValue;
};

interface PathProjection {
  readonly path: string;
  readonly parameters: readonly Record<string, unknown>[];
}

const projectPath = (group: ApiMapGroup): PathProjection => {
  const parts = group.path_template.split("/");
  const parameters: Record<string, unknown>[] = [];
  for (const [ordinal, segment] of group.templated_segments.entries()) {
    const index = segment.segment_index + 1;
    if (index >= parts.length) continue;
    const name = `${segment.rule.replace(/[^A-Za-z0-9_]/gu, "_")}_${ordinal}`;
    parts[index] = `{${name}}`;
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: RULE_SCHEMA[segment.rule] ?? { type: "string" },
      "x-rea-inferred": true,
      "x-rea-observed-values": segment.observed_values.slice(0, 10),
    });
  }
  return { path: parts.join("/"), parameters };
};

const operationId = (group: ApiMapGroup, used: Set<string>): string => {
  const parts = [group.method.toLowerCase()];
  for (const segment of group.path_template.split("/")) {
    if (segment.length === 0) continue;
    const placeholder = /^\{(.+)\}$/u.exec(segment);
    const text = placeholder?.[1] ?? segment;
    parts.push(text.replace(/[^A-Za-z0-9]+/gu, "_"));
  }
  const base = parts
    .filter((part) => part.length > 0)
    .join("_")
    .replace(/^_+|_+$/gu, "");
  let candidate = /^[A-Za-z_]/u.test(base) ? base : `op_${base}`;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
};

/** Project one API map into an OpenAPI 3.1 document. */
export const toOpenApiDocument = (report: ApiMapReport): JsonValue => {
  const used = new Set<string>();
  const paths: Record<string, Record<string, unknown>> = {};
  for (const group of report.groups) {
    const { path, parameters } = projectPath(group);
    const queryParameters = group.query_parameters.map((name) => ({
      name,
      in: "query",
      required: false,
      schema: { type: "string" },
      "x-rea-observed": true,
    }));
    const requestContent = Object.fromEntries(
      group.request_body_fields.length > 0
        ? group.request_content_types.map((contentType) => [
            contentType,
            { schema: bodySchema(group.request_body_fields) },
          ])
        : [],
    );
    const responseContent = Object.fromEntries(
      group.response_body_fields.length > 0
        ? group.response_content_types.map((contentType) => [
            contentType,
            { schema: bodySchema(group.response_body_fields) },
          ])
        : [],
    );
    const statuses = group.statuses.length > 0 ? group.statuses : [0];
    const responses = Object.fromEntries(
      statuses.map((status) => [
        status === 0 ? "default" : String(status),
        {
          description:
            status === 0
              ? "Observed request without a recorded response status"
              : `Observed HTTP ${status}`,
          ...(Object.keys(responseContent).length > 0
            ? { content: responseContent }
            : {}),
        },
      ]),
    );
    paths[path] = {
      ...(paths[path] ?? {}),
      [group.method.toLowerCase()]: {
        operationId: operationId(group, used),
        tags: [group.origin],
        parameters: [...parameters, ...queryParameters],
        ...(Object.keys(requestContent).length > 0
          ? { requestBody: { required: false, content: requestContent } }
          : {}),
        responses,
        "x-rea-origin": group.origin,
        "x-rea-path-template": group.path_template,
        "x-rea-record-ordinals": group.record_ordinals,
        "x-rea-sample-count": group.sample_count,
        "x-rea-flags": group.flags,
        "x-rea-graphql-operations": group.graphql_operations,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "REA API map",
      version: "1.0.0",
      description:
        "Generated from retained producer records. Endpoint grouping is inferred; schemas report observed field names without values.",
    },
    servers: report.summary.origins.map((origin) => ({ url: origin })),
    paths,
    "x-rea-capture": {
      path: report.capture.path,
      sha256: report.capture.sha256,
      format: report.capture.format,
      total_records: report.capture.total_records,
      examined_records: report.capture.examined_records,
      excluded_records: report.capture.excluded_records,
    },
  } as JsonValue;
};

const camelCase = (value: string): string =>
  value.replace(/_+([A-Za-z0-9])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );

/** Generate a self-contained TypeScript client for one API map. */
export const toTypeScriptClient = (report: ApiMapReport): string => {
  const used = new Set<string>();
  const operations = report.groups.map((group) => {
    const { path } = projectPath(group);
    return {
      id: operationId(group, used),
      method: group.method.toUpperCase(),
      path,
      path_parameters: group.templated_segments.map((segment, ordinal) => ({
        name: `${segment.rule.replace(/[^A-Za-z0-9_]/gu, "_")}_${ordinal}`,
        rule: segment.rule,
        segment_index: segment.segment_index,
      })),
      query_parameters: group.query_parameters,
      request_content_types: group.request_content_types,
      response_content_types: group.response_content_types,
      statuses: group.statuses,
      record_ordinals: group.record_ordinals,
    };
  });
  const wrappers = operations
    .map(
      (operation) =>
        `    ${camelCase(operation.id)}: (requestOptions?: ApiRequestOptions) => request(${JSON.stringify(operation.id)}, requestOptions),`,
    )
    .join("\n");
  const interfaceMethods = operations
    .map(
      (operation) =>
        `  readonly ${camelCase(operation.id)}: (options?: ApiRequestOptions) => Promise<Response>;`,
    )
    .join("\n");
  return `/* Generated by khaos/rea map-api from ${report.capture.path}. */
/* Endpoint grouping is inferred from retained records; review before use. */

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiPathParameter {
  readonly name: string;
  readonly rule: string;
  readonly segment_index: number;
}

export interface ApiOperation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly path_parameters: readonly ApiPathParameter[];
  readonly query_parameters: readonly string[];
  readonly request_content_types: readonly string[];
  readonly response_content_types: readonly string[];
  readonly statuses: readonly number[];
  readonly record_ordinals: readonly number[];
}

export const operations = ${JSON.stringify(operations, null, 2)} as const satisfies readonly ApiOperation[];

export type OperationId = (typeof operations)[number]["id"];

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export interface ApiRequestOptions {
  readonly path?: Record<string, string | number>;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
  readonly init?: RequestInit;
}

export interface ApiClient {
  readonly operations: typeof operations;
  request(
    operation: OperationId | ApiOperation,
    options?: ApiRequestOptions,
  ): Promise<Response>;
${interfaceMethods}
}

const operationById = new Map<string, ApiOperation>(
  operations.map((operation) => [operation.id, operation]),
);

const encodePathValue = (value: string | number): string =>
  encodeURIComponent(String(value));

const buildPath = (
  operation: ApiOperation,
  params: Record<string, string | number> | undefined,
): string => {
  let path = operation.path;
  for (const parameter of operation.path_parameters) {
    const value = params?.[parameter.name];
    if (value === undefined)
      throw new Error(\`Missing path parameter: \${parameter.name}\`);
    path = path.replaceAll(\`{\${parameter.name}}\`, encodePathValue(value));
  }
  return path;
};

const buildQuery = (query: Record<string, QueryValue> | undefined): string => {
  if (query === undefined) return "";
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.append(name, String(value));
  }
  const encoded = search.toString();
  return encoded === "" ? "" : \`?\${encoded}\`;
};

const isBodyInit = (value: unknown): value is BodyInit => {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null) return false;
  if (value instanceof URLSearchParams || value instanceof ArrayBuffer)
    return true;
  if (ArrayBuffer.isView(value)) return true;
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
    return true;
  return false;
};

export const createApiClient = (options: ApiClientOptions = {}): ApiClient => {
  const baseUrl = (options.baseUrl ?? "").replace(/\\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const request = async (
    operationOrId: OperationId | ApiOperation,
    requestOptions: ApiRequestOptions = {},
  ): Promise<Response> => {
    const operation =
      typeof operationOrId === "string"
        ? operationById.get(operationOrId)
        : operationOrId;
    if (operation === undefined)
      throw new Error(\`Unknown operation: \${String(operationOrId)}\`);
    const url = \`\${baseUrl}\${buildPath(operation, requestOptions.path)}\${buildQuery(requestOptions.query)}\`;
    const init = requestOptions.init ?? {};
    const headers = new Headers(options.headers);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    let body = init.body;
    if (requestOptions.body !== undefined) {
      if (isBodyInit(requestOptions.body)) body = requestOptions.body;
      else {
        if (!headers.has("content-type"))
          headers.set("content-type", "application/json");
        body = JSON.stringify(requestOptions.body);
      }
    }
    return fetchImpl(url, { ...init, method: operation.method, headers, body });
  };
  return {
    operations,
    request,
${wrappers}
  };
};
`;
};
