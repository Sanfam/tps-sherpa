---
name: The Papa Squad
description: A members' club for gamer dads, by day and after hours. The crest is the mascot, and every Topic wears a badge from one family.
colors:
  paper: "#f4efe8"
  navy: "#13232e"
  orange: "#b24a22"
  orange-deep: "#9a3e1b"
  sky: "#4cadd0"
  sand: "#e6b383"
  ground: "#dad2c6"
  ground-raised: "#e6e0d6"
  surface: "#f4efe8"
  ink: "#13232e"
  ink-soft: "#3f4c56"
  line: "rgb(19 35 46 / 0.16)"
  band: "#13232e"
  band-soft: "#dad2c6"
  accent-text: "#9a3e1b"
  ground-dark: "#142029"
  ground-raised-dark: "#1c2a35"
  surface-dark: "#1c2a35"
  ink-dark: "#eee7dc"
  ink-soft-dark: "#b9b3a8"
  line-dark: "rgb(238 231 220 / 0.16)"
  band-dark: "#0b141a"
  band-soft-dark: "#b9b3a8"
  accent-text-dark: "#ec8a5e"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Arial Rounded MT Bold, sans-serif"
    fontSize: "clamp(3rem, 9vw, 6rem)"
    fontWeight: 800
    lineHeight: 0.92
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Bricolage Grotesque, Arial Rounded MT Bold, sans-serif"
    fontSize: "clamp(2rem, 4vw, 2.75rem)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Bricolage Grotesque, Arial Rounded MT Bold, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  lede:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1.25
rounded:
  card: "14px"
  pill: "999px"
spacing:
  gutter: "clamp(1rem, 4vw, 3rem)"
  section: "clamp(3rem, 8vw, 6rem)"
  section-wide: "clamp(5rem, 12vw, 9rem)"
  measure: "68ch"
  container: "72rem"
components:
  button-primary:
    backgroundColor: "{colors.orange}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0.7em 1.4em"
    height: "3rem"
  button-primary-hover:
    backgroundColor: "{colors.orange-deep}"
    textColor: "{colors.paper}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0.7em 1.4em"
    height: "3rem"
  button-quiet-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
  badge-sky:
    backgroundColor: "{colors.sky}"
    textColor: "{colors.navy}"
    width: "5.5rem"
  badge-sand:
    backgroundColor: "{colors.sand}"
    textColor: "{colors.navy}"
    width: "5.5rem"
  badge-ink:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.paper}"
    width: "5.5rem"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "0.6em 0.8em"
    height: "3rem"
  close-band:
    backgroundColor: "{colors.band}"
    textColor: "{colors.paper}"
    padding: "clamp(3.5rem, 9vw, 6rem) 0"
---

# Design System: The Papa Squad

## Overview

**Creative North Star: "The Clubhouse"**

The Papa Squad looks like a members' club. By day the ground is the warm grey of the crest's original background and navy ink carries the type; after hours (the visitor's `prefers-color-scheme: dark`) the lights go down: navy becomes the ground and cream becomes the ink. The crest is a cut-out, so it sits straight on either ground. Orange is held back for the one thing a visitor should do. Even after hours the world refuses the neon gaming-community page: no glows, no black, no electric accents.

The signature is the badge family. Every Topic and every club wears the same shield: a thick navy outline, a paper sticker edge, a stitched inner line, and one glyph. Pages are generous and calm, with big rounded-grotesque headings, legible body text, and a single full-bleed navy band to close a page.

The same theme covers everything the club publishes: the site, CMS club pages (`.prose`), 1080×1080 event graphics, and the 1200×630 link preview. The class names in `src/styles/theme.css` are the contract those surfaces depend on.

**Key Characteristics:**
- Two modes from one set of tokens: warm grey ground by day, deep navy after hours. Rasters are always day.
- Brand constants (paper, navy, orange, sky, sand) never change with the mode; badges and the orange action look identical in both.
- Orange only for the one action.
- One shield badge shape in three fills (sky, sand, navy).
- Bricolage Grotesque 800 headings, tightly tracked. Atkinson Hyperlegible Next body.
- Soft lift shadows. No hard offset shadows, no glows.

## Colors

A warm palette in two layers: brand constants that never change, and mode colours that swap by day and after hours. Dark follows the system setting (`:root:not([data-theme])` inside `prefers-color-scheme: dark`) unless `data-theme` on `<html>` sets a mode: `"light"` or `"dark"` forces it, from the header theme switch (remembered in `localStorage`) or a page that pins itself, as the graphics templates pin light. Forced dark (`:root[data-theme="dark"]`) repeats the dark token list; keep the two blocks identical.

### Primary
- **Clubhouse Orange** (#b24a22, both modes): the fill of the single primary button on a view, with a navy border. It also appears as thin signals: link underlines, text selection, list markers and the pull-quote mark in prose. Never a badge fill, never body text, never a large surface.
- **Deep Orange** (#9a3e1b, both modes): the hover fill of the primary button.
- **Accent Text** (day #9a3e1b, night #ec8a5e): orange used as text or line on the ground: link hover and the focus ring. 4.6:1 on Crest Ground, 6.6:1 on the night ground.

### Secondary
- **Headset Sky** (#4cadd0): a badge fill, with navy glyph and stitching. It is also Staff's role colour in Discord.
- **Beard Sand** (#e6b383): a badge fill, with navy glyph and stitching.

### Neutral
Brand constants:
- **Paper** (#f4efe8): text on orange and on the band, the badge sticker edge, photo frames.
- **Club Navy** (#13232e): badge outlines, glyphs and the third badge fill, and the primary button border, in both modes.

Mode colours (day / night):
- **Ground** (#dad2c6 / #142029): every page. By day it is the crest's original background. Also the browser `theme-color` for each scheme.
- **Raised Ground** (#e6e0d6 / #1c2a35): inline code in prose.
- **Surface** (#f4efe8 / #1c2a35): cards and form fields.
- **Ink** (#13232e / #eee7dc): headings, body text, button and field outlines. 10.7:1 by day, 13.5:1 at night.
- **Soft Ink** (#3f4c56 / #b9b3a8): supporting text, section intros, the footer. 5.9:1 by day; 7.9:1 on the night ground, 7.0:1 on the night surface.
- **Line** (ink at 16%): hairline dividers, table rules, the footer rule, the dashed prose `<hr>`.
- **Band** (#13232e / #0b141a) and **Band Soft** (#dad2c6 / #b9b3a8): the full-bleed closing band and its lede. Paper on the night band is 16.3:1, Band Soft 8.9:1.

### Named Rules
**The One Way Forward Rule.** One orange button per view, for the thing you most want people to do. On the public landing that is "Join us on Discord", rendered only when `PUBLIC_DISCORD_INVITE` is set at build. It may repeat in the page's closing band, as the same action. With no invite, sign-in is a quiet outlined button and the page has no orange fill.

**The Orange Is Not A Badge Rule.** Badges are filled sky, sand or navy, cycled by index so neighbours differ. Never orange.

**The Constant Brand Rule.** Badges, the orange action and anything drawn in Paper or Navy use the brand constants, never the mode colours, so they look the same by day and after hours. Only ground, surface, ink, line and band swap.

**The Cut-Out Crest Rule.** The crest is a transparent cut-out and sits directly on the ground in either mode. It is never boxed, never placed on a coloured shape, recoloured, cropped into a frame, or overlaid with text. In small lockups (header wordmark, event footer) it is clipped to a circle.

**The Daylight Graphics Rule.** The event graphic and link preview set `data-theme="light"`, so a raster never depends on who rendered it.

## Typography

**Display Font:** Bricolage Grotesque 600/800 (fallback Arial Rounded MT Bold, sans-serif)
**Body Font:** Atkinson Hyperlegible Next 400/700 (fallback system-ui, sans-serif)

Both are self-hosted through Astro's `fonts` config as `--font-display` and `--font-body`.

**Character:** A chunky, friendly grotesque with a little swagger for headings, set against a typeface designed for low-vision legibility. The pairing reads as confident and approachable rather than "gamer".

### Hierarchy
- **Display** (800, clamp(3rem, 9vw, 6rem), 0.92, -0.035em): the page title (h1) on the landing and the brand kit. One per page.
- **Headline** (800, clamp(2rem, 4vw, 2.75rem), 1.05, -0.025em): section headings and prose h2.
- **Title** (600, 1.625rem, 1.05): prose h3.
- **Lede** (400, 1.25rem, 1.6): the line under a display heading, section copy beside imagery, closing-band copy. Capped at 30 to 46ch.
- **Body** (400, 1.0625rem, 1.6): everything you read. Prose caps at 68ch.
- **Label** (700, 0.9375rem, 1.25): badge captions (0.8125rem on narrow screens), nav links and buttons use body weight 700.

All headings use `text-wrap: balance`; paragraphs use `text-wrap: pretty`. The pull quote in prose is the display face at 600, 1.25rem.

### Named Rules
**The Tight Display Rule.** Display-face headings are always 800 (600 only for h3 and quotes) and always negatively tracked (-0.025em, -0.035em at display size, -0.04em on rasters). Headings are sentence case. No uppercase labels above headings.

## Layout

A single centred container: `min(100% - 2 × gutter, 72rem)`, gutter clamp(1rem, 4vw, 3rem). Sections breathe vertically on fluid steps (clamp(3rem, 8vw, 6rem), widening to clamp(5rem, 12vw, 9rem) between major sections). Page-level content is asymmetric two-column grids (1.15fr/0.85fr for the hero, 0.9fr/1.1fr for image-plus-copy) that collapse to one column below 52rem; on mobile the crest moves above the heading at 15rem.

The badge wall is a centred, wrapping flex row of 8.5rem cells (gap 2rem × 1.25rem), becoming three per row below 40rem.

A page may end on a full-bleed navy band. When it does, the footer sits directly beneath it with no strip of ground between.

Rasters are fixed frames, always on the day ground: the event graphic is 1080×1080 with 96px padding (badge lockup top, title, when/where, crest lockup pinned to the bottom); the link preview is 1200×630 with the crest bleeding off the left edge beside the title.

## Elevation & Depth

Mostly flat, with one soft lift for things that sit on the page like objects: photos, the primary button, sample cards and the link-preview image. Badges get their own small drop shadow so they read as stickers. Depth never comes from hard offset shadows or glows.

### Shadow Vocabulary
- **Lift**, a mode colour (day `box-shadow: 0 1px 1px rgb(19 35 46 / 0.08), 0 6px 18px -6px rgb(19 35 46 / 0.28)`; night `0 1px 1px rgb(0 0 0 / 0.3), 0 8px 22px -8px rgb(0 0 0 / 0.65)`): primary button, framed photos, cards.
- **Sticker** (`filter: drop-shadow(0 3px 4px rgb(19 35 46 / 0.22))`, both modes): every badge.

### Named Rules
**The Object On A Table Rule.** Only physical-feeling objects (a photo, a sticker, a card, the one button) cast a shadow, and always the soft Lift. Text, sections and quiet buttons are flat.

## Shapes

Round and friendly. Buttons are full pills (999px) with a 2px ink outline (navy on the primary). Cards and framed images use 14px corners. Photos are framed with a thick paper border (4px in prose, 6px for a feature image). The badge is a heraldic shield with a 5px navy stroke, a 14px paper sticker edge behind it, and a dashed stitch line inset at 84%. Swatch chips and small crest lockups are circles. Form fields use 10px corners with a 2px ink border.

## Components

### Buttons
Tactile, outlined, pill-shaped.
- **Shape:** full pill (999px), 2px ink border, min height 3rem, padding 0.7em 1.4em, body font 700. Leading icon at 1.3em.
- **Primary:** orange fill, navy border, paper text, Lift shadow, identical in both modes. Hover: deep orange and a 2px rise. Active: settles 1px down.
- **Quiet:** transparent, ink text. Hover: fills ink with ground-coloured text. On the band its border and text become paper and it inverts to paper with navy text on hover.
- **Focus:** 3px Accent Text outline, 3px offset, on every focusable element.
- **Motion:** transforms on `cubic-bezier(0.16, 1, 0.3, 1)` over 0.25s; all motion collapses under `prefers-reduced-motion`.

### Theme switch
A `role="switch"` button in the header, labelled "Dark mode" for assistive tech and showing no text. A 52×28px pill track with a 2px ink border and a round thumb that slides from the left (light, sun) to the right (dark, moon with two stars) over 0.25s. The track is Surface by day and Band at night; the thumb is Ink, and the active icon takes Ground against it while the inactive one stays Ink on the track. No orange: that stays on the one primary action. It is hidden until its script runs, so a visitor without JavaScript sees no dead control.

### Badge (signature)
One shield, one outline, three fills, drawn only in brand constants so it is the same in both modes. Fill cycles sky, sand, navy by index; outline is navy; glyph and stitching are navy on sky and sand, paper on navy. Glyphs are Phosphor Icons bold, vendored in `src/brand/glyphs.ts`, one per Topic slug. A linked badge lifts 4px and tilts -3deg on hover. A `bare` badge drops its caption for graphics. A new club gets a new glyph, never a new shape.

### Navigation
Header: crest wordmark (44px circle crest, display 800) left; right side is either a bold "Member sign in" link or, behind the gate, a text nav. Nav links are 700 and unadorned; hover and current page get the 2px orange underline. Footer: hairline rule, soft ink at 0.9375rem.

### Inputs / Fields
Surface fill, 2px ink border, 10px corners, min height 3rem, labels in bold above, soft-ink placeholder. Focus uses the global Accent Text ring.

### Prose (CMS club pages)
Wrap any authored body in `.prose` and it takes the system: 68ch measure, display-face h2/h3, orange list markers, a display-face pull quote with an orange opening mark, framed images with Lift, dashed hairline rules, tabular-number tables with hairline rows.

### Closing Band
Full-bleed Band, centred headline in paper, a lede in Band Soft, and the page's one action repeated. Ends the page. After hours the band is a step darker than the ground.

## Do's and Don'ts

### Do:
- **Do** colour pages with the mode tokens (ground, surface, ink, line, band) so they work in both modes; render rasters with `data-theme="light"`.
- **Do** use exactly one orange button per view, for the main action; repeat it only as the same action in the closing band.
- **Do** give every Topic and club a badge from the one shield family, filled sky, sand or navy, drawn in brand constants.
- **Do** keep text ink or soft ink on the ground and surface, and paper on the band or orange.
- **Do** wrap CMS content in `.prose` rather than styling it by hand.
- **Do** frame photos with a paper border, 14px corners and the Lift shadow.

### Don't:
- **Don't** use orange for badges, body text, backgrounds or a second competing button.
- **Don't** box, recolour, crop or put text over the crest, or set it on a coloured shape; it sits on the ground.
- **Don't** use the gaming aesthetic, in either mode: neon, glows, pure black backgrounds. After hours is navy.
- **Don't** draw a new badge shape or a badge without the navy outline, sticker edge and stitch.
- **Don't** use hard offset shadows or glows; depth is the soft Lift only.
- **Don't** put small uppercase labels or kickers above headings.
- **Don't** set any text on orange except Paper. Paper on Orange is 4.7:1 and on Deep Orange 6.0:1 in both modes, AA at every size. Don't lighten the orange: anything brighter than #b24a22 drops Paper below 4.5:1.
