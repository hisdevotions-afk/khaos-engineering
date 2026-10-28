import { WebCrawlService } from "../application/WebCrawlService.js";
import { NodeFetchCrawlAdapter } from "../browser/crawl/NodeFetchCrawlAdapter.js";

/** Compose the active website crawler without starting any process or fetch on construction. */
export const createWebCrawlService = (): WebCrawlService =>
  new WebCrawlService(new NodeFetchCrawlAdapter());
