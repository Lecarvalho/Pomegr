/** Shared stack-refill symbol; an open arrowhead distinguishes inferred refills. */
export function CacheRefillIcon({ inferred = false, className = "", size = 24 }: { inferred?: boolean; className?: string; size?: number }) {
  return <svg aria-hidden="true" className={`cacheRefillIcon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2.5v4.5M4 14h16M6.5 18h11M9 22h6" />
    <path d="m8.5 7 3.5 3.5L15.5 7Z" fill={inferred ? "none" : "currentColor"} />
  </svg>;
}
