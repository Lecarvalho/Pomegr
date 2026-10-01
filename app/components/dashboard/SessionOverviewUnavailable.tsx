/** Shared quiet readiness line for Overview panels whose evidence is loading or unavailable. */
export function Unavailable({ readiness, label }: { readiness: "loading" | "ready" | "unavailable"; label: string }) {
  return <p className="sessionOverviewEmpty" role={readiness === "loading" ? "status" : undefined}>{readiness === "loading" ? `Loading ${label}…` : `${label} unavailable.`}</p>;
}
