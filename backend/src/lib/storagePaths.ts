function normalizePrefix(prefix: string | null | undefined): string {
  return (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
}

function normalizeKey(key: string): string {
  return key.replace(/^\/+/, "");
}

export function r2PhysicalKey(
  logicalKey: string,
  prefix = process.env.R2_KEY_PREFIX,
): string {
  const normalizedKey = normalizeKey(logicalKey);
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedPrefix) return normalizedKey;
  if (
    normalizedKey === normalizedPrefix ||
    normalizedKey.startsWith(`${normalizedPrefix}/`)
  ) {
    return normalizedKey;
  }
  return `${normalizedPrefix}/${normalizedKey}`;
}

export function stripR2Prefix(
  physicalKey: string,
  prefix = process.env.R2_KEY_PREFIX,
): string {
  const normalizedKey = normalizeKey(physicalKey);
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedPrefix) return normalizedKey;
  if (normalizedKey === normalizedPrefix) return "";
  if (normalizedKey.startsWith(`${normalizedPrefix}/`)) {
    return normalizedKey.slice(normalizedPrefix.length + 1);
  }
  return normalizedKey;
}
