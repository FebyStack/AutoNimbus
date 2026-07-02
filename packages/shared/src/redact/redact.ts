const MASK = "•••redacted•••";

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|api|key|token|secret|ghp|xox[bap])[-_][a-z0-9_-]{12,}\b/gi,
];

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|authorization|credential)/i;

function redactString(value: string, knownSecrets: string[]): string {
  let out = value;
  for (const secret of knownSecrets) {
    if (secret) out = out.split(secret).join(MASK);
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  return out;
}

export function redactSecrets<T>(value: T, knownSecrets: string[] = []): T {
  function walk(node: unknown, keyHint?: string): unknown {
    if (typeof node === "string") {
      if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) return MASK;
      return redactString(node, knownSecrets);
    }
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [
          k,
          walk(v, k),
        ]),
      );
    }
    return node;
  }
  return walk(value) as T;
}
