"use client";

import { HomeUpdateCard } from "../home/HomeUpdateCard";
import { HomeUpdateIllustration } from "../home/HomeUpdateIllustration";
import { Sample, Section } from "./DesignSystemKit";

const HIGHLIGHTS = ["A highlight is one short sentence.", "Two or three are enough."];
const ignore = () => undefined;

export function HomeUpdateSection() {
  return <Section id="home-update" title="Home update" lede="Home's What's new card (HomeUpdateCard) is a teaser: a scaled thumbnail of the announcement illustration, a brand eyebrow, a title, one summary line, a secondary See what's new action, and an icon dismiss. The action opens a modal dialog with the illustration at full size, the description, short highlights, and the primary Got it, which closes the dialog and keeps the card. Only the card's icon dismiss dismisses the announcement.">
    <div className="designSystemStates">
      <Sample label="With illustration" note="The illustration is decorative static artwork authored 408px wide; the card scales the same node down. The dialog is a centered 560px panel on desktop and a bottom sheet at 760px and narrower. Dismiss is inert here.">
        <HomeUpdateCard title="Announcement title" summary="One short line for the Home card." description="A sentence or two naming the main benefit in the interface's own terms." highlights={HIGHLIGHTS} illustration={<HomeUpdateIllustration />} onDismiss={ignore} />
      </Sample>
      <Sample label="Text only" note="Without an illustration the card and the dialog drop the artwork and keep the same copy and actions.">
        <HomeUpdateCard title="Announcement title" summary="One short line for the Home card." description="A sentence or two naming the main benefit in the interface's own terms." highlights={HIGHLIGHTS} onDismiss={ignore} />
      </Sample>
    </div>
  </Section>;
}
