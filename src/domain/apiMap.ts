import { z } from "zod";

import { localPathStringSchema } from "./localPath.js";
import { jsonValueSchema } from "./jsonValue.js";
import { mediaTypeEssence, isJsonMediaType } from "./mediaTypeEssence.js";
import { parseRecordedTransportUrl } from "./recordedTransportUrl.js";
import { templatePathSegments } from "./webCrawl.js";
import type {
  WebNetworkCapture,
  WebNetworkCaptureRecord,
} from "./webNetworkCapture.js";

/** Capture formats with HTTP request lines; qlog exposes transport facts only. */
export const API_MAP_FORMATS = ["har", "mitmproxy", "saz"] as const;

export const apiMapInputSchema = z.strictObject({
  capture_path: localPathStringSchema.describe(
    "Absolute local HAR, native mitmproxy or Fiddler SAZ capture path.",
  ),
  format: z.enum(API_MAP_FORMATS),
  sensitive_values: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Literal text excluded by the capture decoder before the API map is built; repeat as needed",
    ),
  detail: z
    .enum(["map", "openapi", "client", "complete"])
    .default("map")
    .describe(
      "map returns the grouped surface, openapi/client add generated artifacts, complete returns everything",
    ),
  include_bodies: z
    .boolean()
    .default(true)
    .describe(
      "Infer request and response body field names and types from JSON and form bodies",
    ),
});

export type ApiMapInput = z.output<typeof apiMapInputSchema>;

const bodyValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "null",
  "object",
  "array",
  "unknown",
]);

export const apiMapBodyFieldSchema = z.strictObject({
  path: z.string().min(1),
  types: z.array(bodyValueTypeSchema).min(1),
});

export const apiMapGroupSchema = z.strictObject({
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  templated_segments: z.array(
    z.strictObject({
      segment_index: z.number().int().nonnegative(),
      rule: z.enum(["numeric", "uuid", "hex", "iso-date"]),
      observed_values: z.array(z.string()),
    }),
  ),
  query_parameters: z.array(z.string()),
  request_content_types: z.array(z.string()),
  response_content_types: z.array(z.string()),
  statuses: z.array(z.number().int()),
  request_body_fields: z.array(apiMapBodyFieldSchema),
  response_body_fields: z.array(apiMapBodyFieldSchema),
  graphql_operations: z.array(z.string()),
  record_ordinals: z.array(z.number().int().nonnegative()),
  sample_count: z.number().int().positive(),
  flags: z.array(
    z.enum([
      "single-sample",
      "mixed-statuses",
      "mixed-content-types",
      "has-request-body",
      "has-response-body",
      "graphql",
    ]),
  ),
});

export const apiMapReportSchema = z.strictObject({
  capture: z.strictObject({
    path: z.string(),
    sha256: z.string().nullable(),
    format: z.enum(["har", "mitmproxy", "saz", "qlog"]),
    total_records: z.number().int().nonnegative(),
    examined_records: z.number().int().nonnegative(),
    excluded_records: z.number().int().nonnegative(),
  }),
  summary: z.strictObject({
    groups: z.number().int().nonnegative(),
    templated_groups: z.number().int().nonnegative(),
    origins: z.array(z.string()),
    methods: z.array(z.string()),
    query_parameters: z.array(z.string()),
    request_body_fields: z.array(z.string()),
    response_body_fields: z.array(z.string()),
    graphql_operations: z.array(z.string()),
  }),
  groups: z.array(apiMapGroupSchema),
  openapi: jsonValueSchema.optional(),
  typescript_client: z.string().optional(),
  limitations: z.array(z.string()),
});

export type ApiMapReport = z.infer<typeof apiMapReportSchema>;
export type ApiMapGroup = z.infer<typeof apiMapGroupSchema>;
export type ApiMapBodyField = z.infer<typeof apiMapBodyFieldSchema>;

const OBSERVED_VALUE_LIMIT = 20;
const BODY_FIELD_LIMIT = 200;
const BODY_DEPTH_LIMIT = 4;
const BODY_ARRAY_SAMPLE_LIMIT = 5;

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringValue = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** HAR form/multipart parameters carry names without a raw body text. */
const formParameterNames = (params: unknown): string | null => {
  if (!Array.isArray(params)) return null;
  const names: string[] = [];
  for (const param of params) {
    const name = stringValue(objectValue(param)?.name);
    if (name !== null && name.length > 0) names.push(`${name}=`);
  }
  return names.length === 0 ? null : names.join("&");
};

const numberValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const headerValue = (headers: unknown, name: string): string | null => {
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (Array.isArray(header) && header.length >= 2) {
      if (
        typeof header[0] === "string" &&
        header[0].toLowerCase() === wanted &&
        typeof header[1] === "string"
      )
        return header[1];
      continue;
    }
    const item = objectValue(header);
    if (
      item !== null &&
      typeof item.name === "string" &&
      item.name.toLowerCase() === wanted &&
      typeof item.value === "string"
    )
      return item.value;
  }
  return null;
};

interface RequestFacts {
  readonly url: string;
  readonly method: string;
  readonly requestContentType: string | null;
  readonly requestBody: string | null;
  readonly responseStatus: number | null;
  readonly responseContentType: string | null;
  readonly responseBody: string | null;
}

const harFacts = (reported: Record<string, unknown>): RequestFacts | null => {
  const request = objectValue(reported.request);
  const response = objectValue(reported.response);
  if (request === null) return null;
  const url = stringValue(request.url);
  const method = stringValue(request.method);
  if (url === null || method === null) return null;
  const postData = objectValue(request.postData);
  const content = objectValue(response?.content);
  return {
    url,
    method,
    requestContentType:
      stringValue(postData?.mimeType) ??
      headerValue(request.headers, "content-type"),
    requestBody:
      stringValue(postData?.text) ?? formParameterNames(postData?.params),
    responseStatus: numberValue(response?.status),
    responseContentType:
      stringValue(content?.mimeType) ??
      headerValue(response?.headers, "content-type"),
    responseBody: stringValue(content?.text),
  };
};

const mitmproxyFacts = (
  reported: Record<string, unknown>,
): RequestFacts | null => {
  const request = objectValue(reported.request);
  const response = objectValue(reported.response);
  if (request === null) return null;
  const method = stringValue(request.method);
  const path = stringValue(request.path);
  if (method === null || path === null) return null;
  const scheme = stringValue(request.scheme) ?? "https";
  const authority = stringValue(request.authority);
  const host = stringValue(request.host);
  const port = numberValue(request.port);
  const fallbackAuthority =
    host === null ? null : `${host}${port === null ? "" : `:${port}`}`;
  const observedAuthority = authority ?? fallbackAuthority;
  if (observedAuthority === null) return null;
  const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)
    ? path
    : `${scheme}://${observedAuthority}${path.startsWith("/") ? path : `/${path}`}`;
  return {
    url,
    method,
    requestContentType: headerValue(request.headers, "content-type"),
    requestBody: stringValue(request.content),
    responseStatus: numberValue(response?.status_code),
    responseContentType: headerValue(response?.headers, "content-type"),
    responseBody: stringValue(response?.content),
  };
};

const sazFacts = (reported: Record<string, unknown>): RequestFacts | null => {
  const request = objectValue(reported.request);
  const response = objectValue(reported.response);
  if (request === null) return null;
  const url = stringValue(request.url);
  const method = stringValue(request.method);
  if (url === null || method === null) return null;
  const reportedStatus = stringValue(response?.status);
  const status =
    reportedStatus !== null && /^[0-9]{3}$/u.test(reportedStatus)
      ? Number(reportedStatus)
      : numberValue(response?.status);
  return {
    url,
    method,
    requestContentType: headerValue(request.headers, "content-type"),
    requestBody: stringValue(request.body),
    responseStatus: status,
    responseContentType: headerValue(response?.headers, "content-type"),
    responseBody: stringValue(response?.body),
  };
};

const requestFacts = (
  record: WebNetworkCaptureRecord,
  format: WebNetworkCapture["format"],
): RequestFacts | null => {
  const reported = objectValue(record.reported);
  if (reported === null) return null;
  if (format === "har") return harFacts(reported);
  if (format === "mitmproxy") return mitmproxyFacts(reported);
  if (format === "saz") return sazFacts(reported);
  return null;
};

type BodyValueType = z.infer<typeof bodyValueTypeSchema>;

const valueType = (value: unknown): BodyValueType => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "unknown";
};

const collectJsonBodyFields = (body: string): ApiMapBodyField[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const fields = new Map<string, Set<BodyValueType>>();
  const add = (path: string, type: BodyValueType): void => {
    if (path === "") return;
    const types = fields.get(path) ?? new Set<BodyValueType>();
    types.add(type);
    fields.set(path, types);
  };
  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (depth > BODY_DEPTH_LIMIT || fields.size >= BODY_FIELD_LIMIT) return;
    if (Array.isArray(value)) {
      add(prefix, "array");
      for (const item of value.slice(0, BODY_ARRAY_SAMPLE_LIMIT))
        walk(item, `${prefix}[]`, depth + 1);
      return;
    }
    const object = objectValue(value);
    if (object !== null) {
      add(prefix, "object");
      for (const [key, item] of Object.entries(object)) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        add(path, valueType(item));
        walk(item, path, depth + 1);
      }
      return;
    }
    add(prefix, valueType(value));
  };
  walk(parsed, "", 0);
  return [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, types]) => ({
      path,
      types: [...types].sort() as BodyValueType[],
    }));
};

const looksLikeJson = (body: string): boolean => {
  const trimmed = body.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
};

const bodyFields = (
  body: string | null,
  contentType: string | null,
  includeBodies: boolean,
): ApiMapBodyField[] => {
  if (!includeBodies || body === null || body.length === 0) return [];
  const essence = mediaTypeEssence(contentType ?? "");
  if (isJsonMediaType(essence) || (essence === null && looksLikeJson(body)))
    return collectJsonBodyFields(body);
  if (essence === "application/x-www-form-urlencoded") {
    try {
      return [...new Set(new URLSearchParams(body).keys())]
        .sort()
        .map((path) => ({ path, types: ["string" as const] }));
    } catch {
      return [];
    }
  }
  return [];
};

const graphqlOperations = (body: string | null): string[] => {
  if (body === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const envelope = objectValue(parsed);
  if (envelope === null) return [];
  const operations = new Set<string>();
  const operationName = stringValue(envelope.operationName);
  if (operationName !== null && operationName.length > 0)
    operations.add(operationName);
  const query = stringValue(envelope.query);
  if (query !== null) {
    for (const match of query.matchAll(
      /\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/gu,
    )) {
      const name = match[1];
      if (name !== undefined) operations.add(name);
    }
  }
  return [...operations].sort();
};

const queryParameterNames = (url: string): string[] => {
  const parsed = URL.parse(url);
  if (parsed === null) return [];
  return [...new Set(parsed.searchParams.keys())].sort();
};

const mergeBodyFields = (
  target: Map<string, Set<BodyValueType>>,
  source: readonly ApiMapBodyField[],
): void => {
  for (const field of source) {
    const types = target.get(field.path) ?? new Set<BodyValueType>();
    for (const type of field.types) types.add(type);
    target.set(field.path, types);
  }
};

const bodyFieldList = (
  fields: Map<string, Set<BodyValueType>>,
): ApiMapBodyField[] =>
  [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, types]) => ({
      path,
      types: [...types].sort() as BodyValueType[],
    }));

interface GroupState {
  readonly method: string;
  readonly origin: string;
  readonly pathTemplate: string;
  readonly segments: Map<
    number,
    {
      readonly rule: ApiMapGroup["templated_segments"][number]["rule"];
      readonly values: Set<string>;
    }
  >;
  readonly queryParameters: Set<string>;
  readonly requestContentTypes: Set<string>;
  readonly responseContentTypes: Set<string>;
  readonly statuses: Set<number>;
  readonly requestBodyFields: Map<string, Set<BodyValueType>>;
  readonly responseBodyFields: Map<string, Set<BodyValueType>>;
  readonly graphqlOperations: Set<string>;
  readonly ordinals: number[];
}

const groupKey = (method: string, origin: string, template: string): string =>
  `${method}\u0000${origin}\u0000${template}`;

const createGroup = (
  method: string,
  origin: string,
  pathTemplate: string,
  segments: ApiMapGroup["templated_segments"],
): GroupState => ({
  method,
  origin,
  pathTemplate,
  segments: new Map(
    segments.map((segment) => [
      segment.segment_index,
      { rule: segment.rule, values: new Set(segment.observed_values) },
    ]),
  ),
  queryParameters: new Set(),
  requestContentTypes: new Set(),
  responseContentTypes: new Set(),
  statuses: new Set(),
  requestBodyFields: new Map(),
  responseBodyFields: new Map(),
  graphqlOperations: new Set(),
  ordinals: [],
});

const projectGroup = (group: GroupState): ApiMapGroup => {
  const flags: ApiMapGroup["flags"] = [];
  if (group.ordinals.length === 1) flags.push("single-sample");
  if (group.statuses.size > 1) flags.push("mixed-statuses");
  if (
    new Set([...group.requestContentTypes, ...group.responseContentTypes])
      .size > 1
  )
    flags.push("mixed-content-types");
  if (group.requestBodyFields.size > 0) flags.push("has-request-body");
  if (group.responseBodyFields.size > 0) flags.push("has-response-body");
  if (group.graphqlOperations.size > 0) flags.push("graphql");
  return {
    method: group.method,
    origin: group.origin,
    path_template: group.pathTemplate,
    templated_segments: [...group.segments.entries()]
      .sort(([left], [right]) => left - right)
      .map(([segmentIndex, segment]) => ({
        segment_index: segmentIndex,
        rule: segment.rule,
        observed_values: [...segment.values]
          .sort()
          .slice(0, OBSERVED_VALUE_LIMIT),
      })),
    query_parameters: [...group.queryParameters].sort(),
    request_content_types: [...group.requestContentTypes].sort(),
    response_content_types: [...group.responseContentTypes].sort(),
    statuses: [...group.statuses].sort((left, right) => left - right),
    request_body_fields: bodyFieldList(group.requestBodyFields),
    response_body_fields: bodyFieldList(group.responseBodyFields),
    graphql_operations: [...group.graphqlOperations].sort(),
    record_ordinals: [...group.ordinals],
    sample_count: group.ordinals.length,
    flags,
  };
};

const LIMITATIONS = [
  "The API map is projected from retained producer records; grouping does not establish handler identity, URL-space schemas or causality.",
  "Query parameter and body field names are reported without their values. Credential fields excluded by the capture decoder remain excluded.",
  "Templated segments are inferred from recorded literals. Version prefixes, short opaque IDs and digit-bearing route names stay literal.",
  "Body field inference reads JSON and form-encoded bodies up to a bounded depth; binary, compressed and non-text bodies are not decoded.",
  "Observed path values are sampled up to 20 distinct literals per templated segment.",
  "qlog captures expose transport facts only and carry no HTTP request lines, so they cannot produce an API map.",
] as const;

/** Build a bounded API map from one already decoded capture. */
export const buildApiMap = (
  capture: WebNetworkCapture,
  options: { readonly includeBodies: boolean } = { includeBodies: true },
): ApiMapReport => {
  const groups = new Map<string, GroupState>();
  let examined = 0;

  for (const record of capture.records) {
    const facts = requestFacts(record, capture.format);
    if (facts === null) continue;
    const parsed = parseRecordedTransportUrl(facts.url);
    if (parsed.origin === null || parsed.path === null) continue;
    const route = templatePathSegments(parsed.path);
    const key = groupKey(facts.method, parsed.origin, route.template);
    const group =
      groups.get(key) ??
      createGroup(facts.method, parsed.origin, route.template, route.segments);
    groups.set(key, group);
    for (const segment of route.segments) {
      const existing = group.segments.get(segment.segment_index);
      if (existing === undefined) continue;
      for (const value of segment.observed_values) existing.values.add(value);
    }
    for (const name of queryParameterNames(facts.url))
      group.queryParameters.add(name);
    const requestEssence = mediaTypeEssence(facts.requestContentType ?? "");
    if (requestEssence !== null) group.requestContentTypes.add(requestEssence);
    const responseEssence = mediaTypeEssence(facts.responseContentType ?? "");
    if (responseEssence !== null)
      group.responseContentTypes.add(responseEssence);
    if (facts.responseStatus !== null && facts.responseStatus > 0)
      group.statuses.add(facts.responseStatus);
    mergeBodyFields(
      group.requestBodyFields,
      bodyFields(
        facts.requestBody,
        facts.requestContentType,
        options.includeBodies,
      ),
    );
    mergeBodyFields(
      group.responseBodyFields,
      bodyFields(
        facts.responseBody,
        facts.responseContentType,
        options.includeBodies,
      ),
    );
    for (const operation of graphqlOperations(facts.requestBody))
      group.graphqlOperations.add(operation);
    group.ordinals.push(record.ordinal);
    examined += 1;
  }

  const projected = [...groups.values()]
    .sort(
      (left, right) =>
        left.origin.localeCompare(right.origin) ||
        left.pathTemplate.localeCompare(right.pathTemplate) ||
        left.method.localeCompare(right.method),
    )
    .map(projectGroup);

  const origins = [...new Set(projected.map((group) => group.origin))].sort();
  const methods = [...new Set(projected.map((group) => group.method))].sort();
  const queryParameters = [
    ...new Set(projected.flatMap((group) => group.query_parameters)),
  ].sort();
  const requestBodyFields = [
    ...new Set(
      projected.flatMap((group) =>
        group.request_body_fields.map((field) => field.path),
      ),
    ),
  ].sort();
  const responseBodyFields = [
    ...new Set(
      projected.flatMap((group) =>
        group.response_body_fields.map((field) => field.path),
      ),
    ),
  ].sort();
  const graphql = [
    ...new Set(projected.flatMap((group) => group.graphql_operations)),
  ].sort();

  return {
    capture: {
      path: capture.artifact.path,
      sha256: capture.artifact.sha256,
      format: capture.format,
      total_records: capture.total_records,
      examined_records: examined,
      excluded_records: capture.total_records - examined,
    },
    summary: {
      groups: projected.length,
      templated_groups: projected.filter(
        (group) => group.templated_segments.length > 0,
      ).length,
      origins,
      methods,
      query_parameters: queryParameters,
      request_body_fields: requestBodyFields,
      response_body_fields: responseBodyFields,
      graphql_operations: graphql,
    },
    groups: projected,
    limitations: [...LIMITATIONS],
  };
};
