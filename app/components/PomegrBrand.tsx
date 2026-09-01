import Link from "next/link";

export type PomegrMarkVariant = "divided" | "outline";

export function PomegrMark({ variant = "divided", className = "" }: { variant?: PomegrMarkVariant; className?: string }) {
  return <span className={`pomegrMark pomegrMark-${variant}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}

export function PomegrBrand({ href = "/", label = "Pomegr home", markVariant = "divided" }: { href?: string; label?: string; markVariant?: PomegrMarkVariant }) {
  return (
    <Link className="brand" href={href} aria-label={label}>
      <PomegrMark variant={markVariant} className="brandMark" />
      <span className="brandWordmark">Pomegr</span>
    </Link>
  );
}
