import Link from "next/link";

export function WaitlistStatusLink({ className }: { className?: string }) {
  return (
    <Link className={className} href="/#waitlist">
      Join the waitlist
      <ArrowIcon />
    </Link>
  );
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
}
