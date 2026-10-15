# Landing design

> Scope: the public website in `landing/`: the home page, and the header and footer that every page
> shares.
> Authority: visual and interaction contract for the landing. [DESIGN.md](../../../DESIGN.md) owns
> the application tokens and the Pomegr red brand mark; this page owns what the landing does with
> them.
> Related code and checks: `landing/app/components/` (`LandingPage`, `SiteHeader`, `SiteFooter`,
> `PomegrBrand`, `TaskField`, `PomegranateSplit`, `DotGlow`, `ScrollReveal`), the images in
> `landing/public/landing/home/`, `landing/app/globals.css`,
> `landing/tests/ui/public-pages.test.ts`, and `landing/tests/ui/site-header.test.tsx`.

The landing reads as the same product as the app, at the scale a public page needs to persuade.
Its form is a technical specification sheet: figures that explain how Pomegr works, framed and
captioned, on a near-black textured canvas. About, Download, and Docs still use the earlier paper
style until they move to this one.

## Why it differs from the app shell

- The app is a calm evidence workspace. The landing has to win attention and trust in seconds.
- The landing uses the same fonts, the same Pomegr red, flat panels, and one-pixel rules.
- The landing adds display type, texture, figure frames, and motion. The app shell has none of them.
- The landing never shows a screenshot or a value from a real session. Its figures use invented sample data and say so.
- No landing decision moves into the application shell. DESIGN.md keeps that rule.

## Tokens

The landing is an isolated package, so it copies these values instead of importing `app/styles/tokens.css`.

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#0e1012` | Page, header, and footer ground |
| Panel | `#15181b` | Figure fill |
| Raised | `#1d2125` | Hover fill, diagram cards |
| Ink | `#edf0f3` | Primary text |
| Muted | `#8d959f` | Supporting text, the second clause of a statement, captions |
| Line | `#262b31` | Hairline rules and the sheet guides |
| Line strong | `#39404a` | Figure frames and secondary action borders |
| Done | `#3a414a` | Finished tasks in fig. 1 and the hero dot grid |
| Red | `#a63c32` | The one primary action fill, the same as the app's brand fill |
| Red hover | `#b9483d` | Primary action hover |
| Signal | `#e5675b` | The one accent in figures: running, next, now, new |
| Signal wash | `#2a1d1b` | Fill of a highlighted diagram card |
| Focus | `#91b8ee` | Focus ring, the app's dark focus color |

- Red and Signal are the only colors. Green, amber, and lavender stay in the app.
- The radius is 4px on buttons and fields. Figures, cards, and frames are square.

## Type

- Inter carries all language. Geist Mono carries captions, labels, and figure text.
- Mono captions are 11px, uppercase, tracked 0.06em, in Muted.
- A figure caption is set in brackets: `[ fig. 2 — one session, four agents ]`.

| Step | Font | Size | Weight | Line height | Tracking |
| --- | --- | --- | --- | --- | --- |
| Hero title | Inter | 44–84px fluid | 600 | 0.98 | -0.04em |
| Statement | Inter | 28–44px fluid | 500 | 1.12 | -0.03em |
| Lede | Inter | 17px, 16px on phone | 400 | 1.55 | 0 |
| Job title | Inter | 17px | 600 | 1.3 | -0.01em |
| Body | Inter | 15px | 400 | 1.55 | 0 |
| Note | Inter | 14px | 400 | 1.55 | 0 |
| Caption | Geist Mono | 11px | 400 | 1.4 | 0.06em |

- The hero title and each statement have two clauses. The first is Ink and the second is Muted.

## Texture

- Film grain covers the home page as a fixed SVG noise overlay at 22% opacity, blended as overlay.
- A 22px dot grid sits behind the hero and fades out from the upper right through a radial mask.
- Under a fine pointer, each dot the cursor crosses turns Signal red and fades out over 1.1 seconds, still inside the same fade (`DotGlow`). Only crossed dots light, never a radius around the cursor.
- A pomegranate broken in two halves sits behind the hero on the right (`pomegranate-halves.png`).
- A person biting into a pomegranate (`pomegranate-bite.png`) sits right below the last figure, with no caption. Its sides and bottom dissolve into the dither, and its top fades in gradually over the upper 42% right under the figure, so it reads as emerging from it.
- Both images are generated photographs converted to a 4×4 Bayer dither in three reds (`#5c201b`, Red, Signal) on a transparent ground. Each file carries its generation prompt and conversion steps in a PNG text chunk.
- The images render with pixelated scaling, so each dither pixel stays a visible square.
- The pomegranate is the brand's hidden thread. Nothing on the page names or explains it.
- Two hairline guides frame the page column on desktop, like the edges of a sheet.

## Chrome

The header and footer are self-contained bands, so they read the same on the paper pages.

- The header is 60px high, sticky, solid Canvas, and has a Line bottom rule.
- The brand is the painted mark at 26px and the stroked wordmark at 86px in Ink.
- Header links are Inter 13px/500 in Muted. Hover and the current page are Ink.
- Download for Windows is an outlined 36px action at the end of the header.
- The footer is a 96px band with a Line top rule: the brand, then the project links in Inter 12px/500.
- The content column is at most 1200px wide, with at least 32px of side gutter, 16px on phone.

### Phone (720px and narrower)

- The header keeps the brand, Docs, and Download for Windows on one line. The other links move to the footer.
- Download for Windows grows to 44px high at 12px type.
- The wordmark shrinks to 70px, and hides at 350px and narrower.
- The footer stacks the brand over the links.

## Home page

Reading order: hero, fig. 1, the three jobs, one chapter each for sessions, tasks, and Aril, the closing image right below the last figure, then the local note.

- The hero has the two-clause title, one sentence, the platform line, and the actions: Download for Windows (primary, Red) and View source (secondary).
- The platform line is mono: a Signal dot for Windows x64 and a hollow dot for the planned iOS and Android apps.
- Fig. 1 is a field of 288 squares, one per task. The queue moves them through Backlog, Ready, In progress, Review, and Done every 1.4 seconds, from invented sample data.
- The last squares of the backlog start empty and fill one by one after the hero pomegranate cracks open.
- On a phone the field shows 72 squares, the part where the queue is.
- The three jobs (Observe, Plan, Ask) sit in a row of three divided by hairlines.
- Each chapter is a two-clause statement over one figure. The figure has a caption head, a diagram, and three notes.
- Fig. 2 is a session timeline: four agents, their context, and a Now line.
- Fig. 3 is the queue: the next card in Ready starts a session, which moves to Review when the agent reports done.
- Fig. 4 is an Aril proposal: nothing changes until the owner applies it.
- Each diagram has a phone version that stacks vertically, because the desktop diagram would be too small to read.
- A small, quiet note follows the chapters: "Runs on your machine." in 15px/600 beside one muted 14px paragraph on the read-only loopback monitor, and what is never shown or sent.
- The home page has no waitlist. The waitlist API stays deployed with no page that uses it.

## Figures

- A figure is a Line strong frame on Panel, with 9px registration ticks at its four corners.
- Its head holds the caption on the left and `Illustrative · sample data` on the right, in a very quiet `#3f464f`.
- Diagram text is Geist Mono 11px Muted, with names in Inter 13px Ink.
- A diagram draws Signal only on the element that is live: the running task, the next card, the Now line, or the new card.
- Every diagram has an accessible name that describes it and says it is sample data.

## Motion

- Motion is one grammar: an element enters once, when it scrolls into view, with an exponential ease-out.
- `ScrollReveal` sets the starting states only after it runs, so the page is complete without script.
- A statement rises 14px and sharpens from a 4px blur.
- A figure rises 20px. Its bars then grow from the left, its lines draw, its cards fade in, and its notes follow in a short stagger.
- After the entrance, the Now line and the next card pulse slowly.
- On load, the two halves of the hero pomegranate fade in closed, then crack apart.
- On a phone the hero pomegranate sits behind the title at 35% opacity.
- The closing image slides down 24px from under the figure and sharpens from an 8px blur as it scrolls into view.
- Reduced motion turns off every entrance, pulse, the crack, and the task field animation.
