import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { sanitizeEndpointCandidate } from "./browserObservation.js";
import {
  calleeName,
  endpointArgument,
  stringValue,
} from "./javascript/javascriptStaticAnalysisHelpers.js";
import { traverseJavaScriptAst } from "./javascript/javascriptSemanticTraversal.js";
import { templatePathSegments, type EndpointCandidate } from "./webCrawl.js";

/** One parsed script-to-endpoint call-site association. */
export interface ScriptEndpointCall {
  readonly url: string;
  readonly method: string;
  readonly mechanism: string;
  readonly location: { readonly line: number; readonly column: number } | null;
}

const VERB_CALLEES = ["get", "post", "put", "patch", "delete", "head"];

type CallArguments = Parameters<typeof endpointArgument>[1];

const fetchInitMethod = (init: CallArguments[number] | undefined): string => {
  if (!t.isObjectExpression(init)) return "GET";
  for (const property of init.properties) {
    if (!t.isObjectProperty(property)) continue;
    const key = t.isIdentifier(property.key)
      ? property.key.name
      : stringValue(property.key);
    if (key === "method") return stringValue(property.value)?.toUpperCase() ?? "GET";
  }
  return "GET";
};

/** HTTP method implied by a recognized call; GET when it cannot be read statically. */
const callMethod = (name: string, args: CallArguments): string => {
  if (name.endsWith(".open"))
    return stringValue(args[0])?.toUpperCase() ?? "GET";
  const last = name.slice(name.lastIndexOf(".") + 1);
  if (VERB_CALLEES.includes(last)) return last.toUpperCase();
  return fetchInitMethod(args[1]);
};

/**
 * Extract static fetch/axios/XHR/WebSocket endpoint call sites from one script
 * body without executing it. Reuses the same proven callee/endpoint recognition
 * as analyze_web_bundle, but returns raw URLs rather than full findings.
 */
export const analyzeWebScriptEndpointCalls = (
  sourceText: string,
): ScriptEndpointCall[] => {
  let file: ReturnType<typeof parse>;
  try {
    file = parse(sourceText, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return [];
  }
  const calls: ScriptEndpointCall[] = [];
  traverseJavaScriptAst(file, {
    enter: (node) => {
      if (
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node) &&
        !t.isNewExpression(node)
      )
        return;
      const name = calleeName(node.callee);
      const endpoint = endpointArgument(name, node.arguments, node.callee);
      if (endpoint === undefined) return;
      const sanitized = sanitizeEndpointCandidate(endpoint);
      if (sanitized.length === 0) return;
      calls.push({
        url: sanitized,
        method: callMethod(name, node.arguments),
        mechanism: `call:${name}`,
        location: node.loc?.start
          ? { line: node.loc.start.line, column: node.loc.start.column }
          : null,
      });
    },
  });
  return calls;
};

/** Resolve a script call against its page; null for non-HTTP(S) targets such as WebSockets. */
export const endpointCandidateFromCall = (
  call: ScriptEndpointCall,
  base: URL,
): EndpointCandidate | null => {
  let resolved: URL;
  try {
    resolved = new URL(call.url, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
    return null;
  resolved.hash = "";
  const templated = templatePathSegments(resolved.pathname || "/");
  return {
    method: call.method,
    url: resolved.href,
    origin: resolved.origin,
    path_template: templated.template,
    templated_segments: templated.segments,
    source: "script-call",
  };
};
