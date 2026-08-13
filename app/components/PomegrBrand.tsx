import Link from "next/link";

export function PomegrBrand({ href = "/", label = "Pomegr home" }: { href?: string; label?: string }) {
  return (
    <Link className="brand" href={href} aria-label={label}>
      <span>Pomegr</span>
    </Link>
  );
}
