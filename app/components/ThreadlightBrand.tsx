import Link from "next/link";

export function ThreadlightBrand({ href = "/", label = "Threadlight home" }: { href?: string; label?: string }) {
  return (
    <Link className="brand" href={href} aria-label={label}>
      <span className="brandMark"><i /><i /><i /></span>
      <span>Threadlight</span>
    </Link>
  );
}
