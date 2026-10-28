/** One robots.txt group for a single user agent. */
export interface RobotsGroup {
  readonly agent: string;
  readonly allow: readonly string[];
  readonly disallow: readonly string[];
}

/** Parse robots.txt, giving every consecutive user-agent line the rules that follow. */
export const parseRobotsTxt = (text: string): RobotsGroup[] => {
  const groups: RobotsGroup[] = [];
  let agents: string[] = [];
  let allow: string[] = [];
  let disallow: string[] = [];
  let inRules = false;
  const flush = (): void => {
    for (const agent of agents) groups.push({ agent, allow, disallow });
    agents = [];
    allow = [];
    disallow = [];
    inRules = false;
  };
  for (const rawLine of text.split(/\r?\n/u)) {
    const hash = rawLine.indexOf("#");
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      if (inRules) flush();
      if (value.length > 0) agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      inRules = true;
      if (value.length > 0) (field === "allow" ? allow : disallow).push(value);
    }
  }
  flush();
  return groups;
};

const ruleMatches = (rule: string, target: string): boolean => {
  const anchored = rule.endsWith("$");
  const pattern = (anchored ? rule.slice(0, -1) : rule)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`, "u").test(target);
};

/**
 * RFC 9309 decision: the groups naming the crawler's token win over `*`, the
 * longest matching rule wins, and allow wins a length tie.
 */
export const robotsAllows = (
  groups: readonly RobotsGroup[],
  agentToken: string,
  pathAndQuery: string,
): boolean => {
  const token = agentToken.toLowerCase();
  const named = groups.filter((group) => group.agent === token);
  const applicable = named.length > 0 ? named : groups.filter((g) => g.agent === "*");
  let best = { length: -1, allowed: true };
  for (const group of applicable) {
    for (const [rules, allowed] of [
      [group.allow, true],
      [group.disallow, false],
    ] as const)
      for (const rule of rules)
        if (
          ruleMatches(rule, pathAndQuery) &&
          (rule.length > best.length ||
            (rule.length === best.length && allowed))
        )
          best = { length: rule.length, allowed };
  }
  return best.allowed;
};
