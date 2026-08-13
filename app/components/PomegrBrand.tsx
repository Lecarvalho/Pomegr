import Link from "next/link";

export function PomegrBrand({ href = "/", label = "Pomegr home" }: { href?: string; label?: string }) {
  return (
    <Link className="brand" href={href} aria-label={label}>
      <svg className="brandWordmark" viewBox="80 660 1310 180" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round">
          <path d="M100 820V680H183C225 680 251 700 251 733C251 766 225 786 183 786H100" />
          <path d="M390 675C340 675 309 704 309 750C309 796 340 825 390 825C440 825 471 796 471 750C471 704 440 675 390 675Z" />
          <path d="M550 820V680L625 762L700 680V820" />
          <path d="M790 680V820M790 680H916M790 750H891M790 820H916" />
          <path d="M1153 706C1138 686 1116 675 1087 675C1037 675 1006 704 1006 750C1006 796 1037 825 1087 825C1115 825 1138 815 1154 797V752H1096" />
          <path d="M1242 820V680H1304C1343 680 1366 699 1366 732C1366 764 1343 783 1304 783H1242M1303 783L1369 820" />
        </g>
      </svg>
      <span className="brandText">POMEGR</span>
    </Link>
  );
}
