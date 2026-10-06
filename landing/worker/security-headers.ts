// Sent with every response. The Worker sets them on handler responses; `public/_headers` repeats
// them for the files the assets binding serves without running the Worker. Keep both in step:
// `tests/ui/public-pages.test.ts` compares them.
export const SECURITY_HEADERS: ReadonlyArray<readonly [name: string, value: string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()"],
  ["X-Frame-Options", "DENY"],
];
