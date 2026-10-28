const MEDIA_TYPE_ESSENCE =
  /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;

/** Lowercase type/subtype essence, without parameters, or null when malformed. */
export const mediaTypeEssence = (reported: string): string | null => {
  const separator = reported.indexOf(";");
  let start = 0;
  let end = separator < 0 ? reported.length : separator;
  // HTTP OWS is SP/HTAB. Scan from both ends so malformed internal runs of
  // whitespace cannot cause repeated trailing-regex searches.
  while (start < end && (reported[start] === " " || reported[start] === "\t"))
    start += 1;
  while (
    end > start &&
    (reported[end - 1] === " " || reported[end - 1] === "\t")
  )
    end -= 1;
  const essence = reported.slice(start, end);
  return MEDIA_TYPE_ESSENCE.test(essence) ? essence.toLowerCase() : null;
};

/** True when a media type essence carries JSON (application/json or +json). */
export const isJsonMediaType = (essence: string | null): boolean =>
  essence === "application/json" || essence?.endsWith("+json") === true;
