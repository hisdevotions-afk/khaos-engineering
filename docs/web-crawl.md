# Active website crawl

`crawl_web_site` (CLI: `crawl-web-site <url>`) maps a site you have no app or account for. It fetches HTTP(S) resources directly and never executes JavaScript. Use the passive browser tools when a page needs a real browser session.

## What it recovers

- Pages, links, forms with field names and types, JSON-LD types, and the JSON shape of JSON responses.
- Endpoint candidates with an HTTP method and a path template (`{numeric}`, `{uuid}`, `{hex}`, `{iso-date}`) from three sources: `html-form`, `script-call` and `openapi`.
- `script-call` candidates come from literal `fetch`, axios-style verbs and `XMLHttpRequest.open` call sites in inline scripts and in linked scripts the crawler downloads (`max_scripts`). The method is read from the verb, the `fetch` init `method`, or the `open` argument, and defaults to GET.
- `openapi` candidates come from `/openapi.json`, `/swagger.json`, `/v3/api-docs` and `/api-docs`. `/sitemap.xml` seeds the page frontier. Disable the probes with `probe_well_known: false` or `--no-well-known`.

## Scope and politeness

- Same origin by default. `allowed_origins` applies only when `same_origin` is false. Every redirect hop is checked against the same scope, so a redirect off the allowed origins is a `fetch-failure`.
- `robots.txt` is ignored by default, so crawls reach paths a site's crawler policy would otherwise hide. It is never fetched unless `respect_robots: true` (CLI: `--respect-robots`) is set; when enabled, `Allow`, `Disallow`, `*` and `$` apply with longest match winning.
- Page, depth, script, timeout and per-response byte budgets are bounded. Exhausted budgets are reported in `unknowns` and `exclusions`.
- `sensitive_values` are replaced with `[redacted]` throughout the report.

## Limits

Endpoint candidates are static inferences. Computed or template-string URLs, request bodies, auth headers and client-rendered routes are not recovered. Confirm candidates with `capture_browser_scenario` or a HAR run through `inspect_web_network_capture` when a session is available.
