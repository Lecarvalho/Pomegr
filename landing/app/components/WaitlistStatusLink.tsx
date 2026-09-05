import Link from "next/link";

export function WaitlistStatusLink({ className }: { className?: string }) {
  return (
    <Link className={className} href="/#waitlist">
      Join the mobile waitlist
    </Link>
  );
}
