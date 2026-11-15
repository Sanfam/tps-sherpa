# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Prospective members:** dads who game, arriving from a shared link or a search and deciding whether the Papa Squad is their kind of place. These are Viewers: they see public content only.
- **Members:** dads already in the Discord guild, signed in through Discord (Users), browsing the Index to find the Channels, Forums, Posts and clubs that fit their interests.
- **Club Leads and Staff:** write club and event pages in the EmDash CMS. They are not designers, so whatever they author has to look right on its own.

The site has to serve both audiences equally.

## Product Purpose

The Papa Squad hub site is the public front door and the searchable Index for a Discord community of more than 1,250 Entities (94 Channels, 11 Forums, about 1,200 Posts and Threads). It helps a dad find his corner of a large server, and helps someone outside decide to join. Papa Sherpa, the bot, matches Members' interests against the same Catalog.

## Positioning

A community of dads who game. Members are parents first and play when time allows, and the server reaches well past games, into parenting, self-care, food, DIY, books and regional meetups. Its guild description: "Gathering all gamer dads to exchange, socialize and play games (when time allows!)"

## Operating Context

- Discord is home. The site points people back into Discord Channels, and Discord's role and permission model decides what each person can see (Access).
- Content comes from the Catalog, which the bot builds, and from CMS pages Club Leads write.
- The theme must also carry beyond the site: event and club graphics posted in Discord, social link-preview (Open Graph) cards, and CMS-authored club pages.

## Capabilities and Constraints

- Astro 7 with EmDash 1.4 CMS, Discord sign-in through Better Auth. The landing page is static; member pages are server-rendered behind middleware.
- Access is a wall: member-gated content never appears to Viewers.
- Terminology is fixed in `CONTEXT.md` (Entity, Catalog, Index, Access, Affinity, Member, Viewer).

## Brand Commitments

- **Name:** "The Papa Squad" (the guild name carries a 🎮 prefix in Discord).
- **Mascot/icon:** a bearded dad in orange headphones, drawn in a bold esports-mascot style with thick dark outlines, on a warm grey ground (`public/brand/icon.png`). It must be kept.
- **Poster art (tone reference, not binding):** the server banner and invite splash, a painterly scene of a dad and child in headphones at a laptop, over orange and rust shards on near-black (`public/brand/banner.png`, `public/brand/splash.png`). The owner calls it a good reference that isn't perfect.
- **Voice:** a kindly gamer dad. Warm, patient, a little corny, glad to help. A friend at the next desk at a LAN party, not customer service. Help first, then flavour; one dad joke is plenty. (`content/config/persona.json`)
- **Bot name constraint:** "Sherpa" is only a name. Never use mountain-guide, Nepal or Himalaya imagery.
- **Known role colours** (members recognise them): Staff `#4cadd0`, Ambassador `#1f8b4c`, Event Managers `#aa3b3b`, plus platform roles: PC `#9b59b6`, PS5 `#3498db`, Xbox `#2ecc71`, Switch `#e91e63`.

## Evidence on Hand

- Guild icon, banner and splash (`public/brand/`).
- Real Catalog data: Topics (`content/config/topics.json`), Regions (`content/config/regions.json`), and Entity names and summaries from the bot.
- There are no testimonials, member counts beyond the measured Entity counts, or press. Don't make any up.

## Product Principles

1. **Discord is home; the site is the map.** Every page should get a person to the right place in the server faster.
2. **Dads first, gamers second.** The space is as much about family and life as about games, and it should never feel like an edgy esports clan or a kids' brand.
3. **Warm, never slick.** It's the voice of a friend, not a marketing department.
4. **Access is never blurred.** What's private stays invisible to Viewers, including in previews and shared cards.
5. **Non-designers ship pages.** The system has to make CMS-authored content look intentional by default.
