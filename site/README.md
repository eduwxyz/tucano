# Tucano's site

Live at **[tucano.sh](https://tucano.sh)**. One page to edit: `index.html` (CSS and JS inline) and `assets/`. `build.mjs` publishes it twice, in Portuguese at `/` and in English at `/en/`, into `dist/`.

- **Preview:** open `index.html` in a browser (there the PT | EN switch changes the language in place), or run `node build.mjs` and serve `dist/` to see both addresses. `index.html?shot` shows everything at once (for screenshots).
- **Languages:** Portuguese and English, with the PT | EN switch at the top. Every text is written in both, side by side (`<span lang="pt-BR">` and `<span lang="en">`), and the CSS shows the one matching `<html lang>`; what the scripts draw goes through `T(pt, en)`. On the site the address decides: `/` is Portuguese, `/en/` English, and PT | EN goes to the other page and remembers the choice, which later visits follow. With no saved choice, a visitor whose browser speaks the other language gets a link to it at the bottom (no automatic redirect, so search engines see each page as it is).
- **Search:** each page has its own title, description, canonical address and `hreflang` links to the other, plus structured data (the app, the organization and the FAQ, read from the page itself) that `build.mjs` adds. `dist/` also gets `sitemap.xml` and `robots.txt`.
- **Other pages:** the comparisons `alternativa-grok-bot.html` (with Grok Bot, MausBot, OpenBot and Rerun) and `alternativa-openclaw.html` (with OpenClaw, Hermes Agent and NanoClaw), styled by `assets/compare.css`, are written the same way, with the English title and descriptions in `data-en` and English links in `data-en-href`; `build.mjs` publishes each at `/alternativa-…/` and `/en/…-alternative/`. A new page goes in its `PAGES` list. The comparison's facts carry their sources and date at the bottom: update both together.
- **Look:** the shapes of the app icon (the round body, the eye, the two-orange beak) in cream, black and orange. The toucan in the hero, the one in the footer and the agents follow the pointer with their eyes.
- **App screens:** drawn in HTML, not screenshots. The #checkout channel in the "Live" section plays by itself and waits for the visitor to approve.
- **Fonts:** Bricolage Grotesque (headings) and Inter (text), from Google Fonts.
- **Logos:** `assets/logos/` come from [Simple Icons](https://simpleicons.org) (CC0).
- **Publishing:** served by Cloudflare as static files on `tucano.sh` (`wrangler.jsonc`, which runs `build.mjs` and publishes `dist/`; `_headers` adds the security headers):

  ```bash
  cd site && npx wrangler deploy
  ```
- **Other domains:** `www.tucano.sh`, `tucano.chat`, `usetucano.com` and `tucano.bot` (and their `www`) send a 301 to `tucano.sh`, keeping the path, through the Worker in `redirect/`:

  ```bash
  cd site/redirect && npx wrangler deploy
  ```
