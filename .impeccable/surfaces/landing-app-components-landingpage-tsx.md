---
version: 1
slug: "landing-app-components-landingpage-tsx"
primary_target: "landing/app/components/LandingPage.tsx"
related_targets: ["landing/app/components/LandingPage.module.css","landing/app/globals.css","landing/app/components/SiteHeader.tsx","landing/app/components/SiteFooter.tsx","landing/app/components/SiteChrome.module.css","landing/app/components/PomegrBrand.tsx"]
---

# Public landing home

Mode: Persuade. Audience: developers who run coding agents on their own machine, and the companies the owner will approach as partners; the page must read as a credible, professional tool. Action: Download for Windows (primary), view the source, join the mobile waitlist. Proof: diagrams of how Pomegr works, drawn from invented sample data and labeled illustrative, plus verifiable facts (license, platform, loopback monitor); no testimonials, logos, metrics, or claims the repository does not establish.

Constraints: `landing/` is isolated and copies token values; no runtime dependency; links, the download route, the platform line, the waitlist (`id="waitlist"`, `WaitlistActions`) and the painted mark keep their behavior. About, Download and Docs keep their paper stylesheets until part 2 (T-116); the shared header and footer are self-contained charcoal bands so they sit on either world.

References the owner chose: Factory, Langfuse, Linear, Warp, kept dark. Rejected on the way: a paper scrapbook (old site), the app shell as page (read as AI-generic), and a fake-UI mock hero.

## Direction contract

THESIS: Pomegr as a technical specification sheet: framed figures that explain the mechanism, not screenshots or feature cards; it refuses the centered SaaS hero, the logo wall, and fake product mocks.
OWN-WORLD: Near-black #0e1012 canvas with film grain, a dot grid fading behind the hero, a dithered photograph of a pomegranate cracking open in Pomegr reds (a hidden thread, never captioned), a dithered bite of pomegranate as the last frame; hairline #262b31 rules, figure frames with corner ticks, Geist Mono uppercase captions in brackets, Inter 600 tight display with a muted second clause, Pomegr red as the one accent.
STORY: The visitor sees tasks moving through a live field, learns the three jobs (observe, plan, ask), reads one figure per job, checks the spec table of what never leaves the machine, then downloads or joins the waitlist.
FIRST VIEWPORT: Header band (mark, links, outlined Download). Left: a 76px two-clause headline (Your agents don’t sleep. Now you can.), one sentence, mono platform line. Right: the dithered pomegranate halves crack apart above Download for Windows and View source. Below: fig. 1, a 48-column field of task squares cycling Backlog to Done.
FORM: Spec sheet with texture, owner-steered after the shell-as-page structure (seed e348791f) was rejected; direction seed 6615dea8 rolled but superseded by the owner's pinned references.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
