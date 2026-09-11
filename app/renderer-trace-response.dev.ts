export function rendererTraceResponseHeader(response: Response) {
  const token = response.headers.get("x-pomegr-trace-revision");
  return token ? { "X-Pomegr-Trace-Revision": token } : {};
}
