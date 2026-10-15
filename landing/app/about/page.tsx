import { permanentRedirect } from "next/navigation";

// About was folded into the home page; the path stays so existing links land on Home.
export default function AboutPage() {
  permanentRedirect("/");
}
