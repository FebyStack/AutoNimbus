// Security invariant (spec §12): AutoNimbus is local-only. Never bind 0.0.0.0.
export const serverConfig = {
  host: "127.0.0.1",
  port: 4680,
} as const;
