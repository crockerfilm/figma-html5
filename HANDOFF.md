# HANDOFF — Figma → HTML5 Ad Converter

Written for a fresh assistant with no memory of how this was built. Everything here was
established by testing against real creatives, not assumed. Where something is uncertain,
it says so — please preserve those hedges rather than hardening them into claims.

---

## 1. What this is

A single self-contained web page that turns an **animated SVG exported from Figma** into a
**delivery-ready HTML5 display-ad zip**, and refuses to produce one when the file cannot
meet spec.

- **Live:** https://crockerfilm.github.io/figma-html5/
- **Repo:** `crockerfilm/figma-html5` (public, GitHub Pages from `main`, root)
- **Source:** `~/Documents/Dev/active/figma-html5/index.html` — one file, ~1,300 lines
- **Owner:** Hayden Crocker (`crockerfilm` on GitHub), creative ops at New Engen
- **End client for the spec:** Amazon. Creatives passing through it are various brands.

There is no build step, no package.json, no dependencies, and no server. Open the HTML
file and it works. It is deliberately one file so it can be dropped into the Crocker
Toolbox hub later, which copies tools in and re-skins them via CSS variables (the palette
tokens `--bg: #0d0f14` / `--accent: #5b8cff` already match that hub).

### Privacy property that matters

**Nothing leaves the browser.** No `fetch`, no XHR, no external scripts, no CDN, no
analytics, no storage. Parsing, image re-encoding and zip building are all local (File
API, Canvas, `CompressionStream`). This is what makes it safe to host publicly while
designers drop unreleased client creative into it. **Do not add a network call without
raising it explicitly** — it would silently break that guarantee.

The preview iframe runs `sandbox="allow-scripts"` **without** `allow-same-origin`, so a
dropped file lands on its own origin and cannot touch the page or anything else on
`crockerfilm.github.io` (which also hosts other tools).

---

## 2. The problem it solves

Designers hand over Figma animated-SVG exports of ~8–15 MB. An Amazon display ad has to
fit ~200 KB, stop animating, carry a clickTag, and use listed image formats. Doing that by
hand per creative is slow and error-prone, and Figma's exporter has several silent bugs
that produce broken artwork which looks fine until someone zooms in.

So the tool does two jobs: **convert**, and **refuse to lie about whether the result is
deliverable.**

---

## 3. Architecture

### Two tabs

| Tab | Purpose |
|---|---|
| **Convert** | SVG in → checked, auto-fixed, packaged → zip out |
| **Inspect a built ad** | Audits a package that already exists (`.zip` or loose `index.html`), whoever built it. Includes a large preview with a timeline scrubber and *Jump to end frame*. |

The Inspect tab exists because a teammate shipped files from a stale cached build and
someone had to audit them by hand. It reads the delivered artifact rather than rebuilding.

### The `SPEC` object

Every threshold lives in one object at the top of `index.html`. **Nothing else in the file
needs editing to retarget it at a different placement.** Keep it that way.

```js
const SPEC = {
  maxZipKB: 200,               // max initial load for an HTML ad tag
  maxAnimationSeconds: 15,     // total animation time, including loops
  maxLoops: 3,                 // and no more than this many plays
  holdOnLastFrame: true,
  requireOutlinedText: true,
  allowExternalRefs: false,
  jpegQuality: 0.8,
  formatOpaque: "image/jpeg",
  formatAlpha: "image/png",
  ladder: [1, 0.8, 0.65, 0.5, 0.4, 0.32, 0.25, 0.2, 0.15, 0.1]
};
```

### Rules engine, not a script

Hayden asked for this explicitly: *"a complicated if this then that setup check
(deterministic)"* that works for **any** Figma animation. `RULES` is an ordered array;
each rule returns one of:

- `pass` — already fine
- `fixed` — a deterministic repair was applied, explained in plain language
- `warn` — worth a human look, not blocking
- `block` — cannot be fixed automatically; states **the exact change to make in Figma**

**A blocker disables the download button.** The output is either to spec or it doesn't
exist. That is the core contract — don't soften it.

Rules in execution order: `dimensions`, `animation`, `duration`, `self-contained`,
`foreign-object`, `outlined-text`, `scripts`, `diamond-gradient`, `media`,
`filter-bounds`, `render-cost`, `loop`, then `weight`, `sharpness` and `format` are
appended by the pipeline after packaging.

`dimensions` and `animation` short-circuit — if either blocks, nothing else runs and no
expensive work happens.

### Pipeline order (this order matters)

1. Parse with `DOMParser` as `image/svg+xml` (strict XML; Figma always emits well-formed).
2. Run structural rules. Some mutate the DOM (script stripping, gradient repair, filter
   normalisation, loop capping).
3. `minifyGeometry` — round `d`/`points` coordinates. **Precision is derived from
   `viewBoxScale`**, not fixed, so a small viewBox blown up to a large canvas isn't
   distorted. CSS is deliberately left alone: keyframe matrices carry scale factors like
   `0.00499251` that do not survive rounding.
4. Decode each **distinct** image once (deduplicated by data-URI), detect alpha from
   actual pixels, resolve how large it is drawn.
5. Measure the markup cost **before touching images**.
6. Allocate the image budget, encode, package, zip.
7. Append `weight` / `sharpness` / `format` results.

---

## 4. Hard-won Figma knowledge

This section is the real value of the handoff. All of it was found empirically.

### Export settings the designer must use

| Setting | Value | Why |
|---|---|---|
| Tab | **Animated** | The Static tab produces no `@keyframes` and no layer ids. The tool rejects it. |
| Format | SVG | |
| **Ignore overlapping layers** | **ON** | Turning it OFF silently downgrades the export to static. It is not optional. |
| **Outline text** | **ON** | Otherwise the ad depends on fonts loading. |
| Include "id" attribute | Off | The animated export already emits the ids its CSS needs. |
| Colour profile | sRGB | |

Quick check before doing anything: `grep -c '@keyframes' file.svg`

### Figma exporter bugs the tool repairs

**a) Diamond/angular gradients land in the wrong coordinate space.**
SVG has no diamond gradient, so Figma fakes it: four rectangles mirrored about `x=0` and
`y=0`, filled with a linear gradient, behind a clip path, tagged
`data-figma-skip-parse="true"`. In animated exports Figma rebases the *clip path* into the
animated layer's local space but leaves the *gradient matrix* in absolute canvas
coordinates. The fill then paints offset from the shape and slices chunks out of the type.

Verified exactly: a clip path starting `M177.14 247.727` became `M7.14004 -0.272567` under
`transform="translate(170 248)"` (177.14 − 170 = 7.14) while the gradient matrix stayed at
`526.329 342.936`. The repair walks up from each `data-figma-skip-parse` block, accumulates
the ancestor transforms, and left-multiplies the gradient group by the inverse.

**b) The same construction leaves a faint diagonal cross.**
The four mirrored rects abut exactly along the mirror axes and ship with
`shape-rendering="crispEdges"`, so the un-antialiased shared edges read as hairlines, which
the parent matrix rotates into a cross over the artwork. Fix: grow each rect back across
the mirror axes so the quadrants overlap, and drop `shape-rendering`. Safe because the
gradient is `gradientUnits="userSpaceOnUse"` — changing rect bounds extends the painted
area without moving any colour. Overlap is 1.5 device px scaled by the matrix.

**c) Invalid filter regions.** Figma writes `x="inf" y="inf" width="-inf" height="-inf"`
when it can't compute a filter's bounds (9 instances in one real file). Browsers ignore
these and fall back to the default region so it still renders, but it throws console errors
and gives a validator something to object to. Normalised to `-10%` / `120%`.

**d) Seamless loops end on frame one.** Figma builds loops that return to the start. The
spec requires the animation to stop, and it freezes on the last frame — which for a
seamless loop is the *first* frame, with no call to action. The tool cannot fix this; it
warns, and the Inspect tab's *Jump to end frame* is how you check.

### Designer guidance, ranked by impact

Full version in `README.md`. The three that matter most:

1. **End on the end card**, for the reason above.
2. **Only use transparency where genuinely needed.** Alpha forces PNG, which costs roughly
   **10× the same picture as JPEG**. Give a layer its background in Figma if it has one.
   Crop cutouts to their content. Measured: two real images were 68% empty space.
3. **Flatten live blurs, and never animate a blur amount.** Animating `stdDeviation`
   recomputes the entire filter every frame — the most expensive thing a display ad can do.

Also: many transparent cutouts on one canvas usually can't fit. Six product cutouts drawn
at ~400px need ~250 KB as PNG. If they share a background, composite the cluster into one
flattened opaque image — one JPEG beats six starved PNGs comfortably.

---

## 5. Bugs already found and fixed — do not reintroduce

Each of these shipped at some point and was caught by testing. They are the failure modes
this codebase is prone to.

| Bug | Why it mattered |
|---|---|
| **Animations in inline `style=` attributes were invisible** to duration/loop logic | Tool reported *"already finite, 0 blockers"* while shipping an ad that looped forever. A false green light on the exact rule Amazon enforces. Always scan inline styles alongside `<style>` blocks. |
| **Loop cap bounded seconds only, not play count** | A 2s animation emitted **7 plays** against a 3-play limit. Must be `min(maxLoops, floor(maxSeconds / cycle))`. |
| **Shell ids collided with artwork layer names** | A layer named `ad-clickthrough` made `getElementById` return the artwork, so **the ad silently stopped being clickable**. Ids are now chosen to avoid whatever the file already uses, and the click layer's styles are `!important` so a stylesheet inside the artwork can't hide it. |
| **Global reduction ladder crushed images when *markup* was the bottleneck** | Images went to 294×486 mush while `index.html` alone was 277 KB. Always measure markup first; if markup alone exceeds budget, block and leave images at full size. |
| **Images sized against the canvas, not how large they're drawn** | Simultaneously wasteful and starving: one image encoded 600×600 while only ever drawn at 200×127, while six cutouts drawn at ~400px were squeezed to 71×120. Fixing this took one real creative from 143.8 KB to **65.8 KB with no quality change**. |
| **Silent quality degradation** | The tool hit budget by wrecking images and still reported 0 blockers. The `sharpness` rule now names each image and its stretch factor. Fitting the budget by wrecking an image is not fitting it. |
| **Fixed 2-decimal coordinate rounding** | Fine at viewBox 1:1, visibly distorting when a small viewBox is scaled up. Now derived from `viewBoxScale`. |
| **Duplicate identical images shipped once per placement** | A logo placed 5× cost 5×. Deduplicated by data-URI. |
| **Preview silently rendered with no artwork** | Once images became separate files, `srcdoc` had no base URL to resolve them and the sandboxed frame can't read `blob:` URLs from the parent origin. Preview inlines the real output bytes as data URIs. |
| **Format/folder checks only looked at bundled files** | A loose `index.html` passed clean despite referencing `assets/img1.webp`. Now checks what the markup *references* as well as what shipped. |
| **WebP** | Was emitted for alpha images. Amazon's listed formats are JPG/GIF/PNG — WebP is not listed. Removed. |
| **`assets/` subfolder** | Flattened to the package root; nothing guarantees a validator walks subfolders, and the known-approved reference ad was flat. |

---

## 6. Where the spec numbers come from, and what's still uncertain

Sourced from Amazon's published
[technical guidelines](https://advertising.amazon.com/resources/ad-policy/technical-guidelines):
**200 KB max initial load**, **animation up to 3 loops within 15 seconds**, image formats
listed as **JPG, GIF, PNG**, and all ads must support https.

Cross-checked against a real approved creative, `AWS14_VersionD_300x250.zip`, which passed
Amazon's own spec checker: 68.5 KB zipped, 261 KB unzipped, 12s animation, every animation
`1` iteration + `forwards`, zero `infinite`, JPEG raster, flat package. **That file passes
this tool's Inspect tab with zero blocks and zero warnings** — the best evidence the rules
aren't over-strict. Keep it around as a regression fixture.

### The one open caveat — please preserve it

The 200 KB figure is documented for **tags served from an approved third-party ad server**.
If zips are delivered to Amazon directly, a different limit may apply, and the guidelines
also mention polite-loading additional assets. Nobody has confirmed which applies to this
team's delivery path. **This is the single most likely way the tool hands someone a
confident wrong answer.** It has been flagged to Hayden repeatedly and remains unresolved.
Don't quietly drop the caveat, and don't harden the number into a certainty.

Secondary: the creatives are 1080×1080 / 1080×1920 / 1200×1200, which are not IAB-standard
display sizes. Whether the placement accepts them hasn't been verified here.

---

## 7. How to test — this is not optional

**Hayden's standing critique, raised twice: do not optimise for one example.** A rules
engine that works on the file in front of you but assumes its characteristics is useless to
designers handing over anything else. Both times, the fix was a generated matrix.

Validate with **synthetic SVGs generated in-page** covering:

- Animation durations 1/2/4/5/7/10/14s → expected plays 3/3/3/3/2/1/1
- Canvas sizes 300×250 and 1080×1080
- 0, 1, 2, 5, 8 images
- Opaque (→JPEG) vs alpha (→PNG)
- Markup-bound vs image-bound blocking
- Malformed inputs: static export, live `<text>`, 22s animation, external `https://` image,
  missing width/height/viewBox

Then confirm against **real creatives from different brands** — four were used, spanning
1080×1080, 1080×1920 and 1200×1200, 0.75 MB to 14 MB, 1–8 images, CSS and SMIL animation.
The matrix caught the 3-loop violation; the real files caught the display-size bug.

**Always verify visually, not just numerically.** Several bugs produced correct-looking
numbers and wrong pixels. The reliable method: rebuild the SVG with the real output bytes
inlined, freeze the animation at a timestamp by appending
`*{animation-play-state:paused!important;animation-delay:-Ns!important}` to its `<style>`,
rasterise to a canvas, and display as a plain `<img>`. Screenshotting a CSS-transformed
iframe in a preview pane is unreliable and produced several false alarms.

Testing hooks exposed on `window`: `__run`, `__handleFile`, `__built`, `__inspect`,
`__audit`, `__readZip`.

---

## 8. Deploying

```bash
cd ~/Documents/Dev/active/figma-html5
git add index.html README.md && git commit -m "…" && git push origin main
# Pages rebuild takes ~30–60s
gh api repos/crockerfilm/figma-html5/pages/builds/latest --jq '.status'
```

**Bump `const BUILD` on every deploy.** It renders top-right. A stale cached copy silently
enforcing old limits already caused one incident where a teammate shipped out-of-spec files
— the build stamp is how they check. GitHub Pages caches hard; tell people to hard-refresh
(Cmd+Shift+R).

`.gitignore` blocks `*.svg`, `*.zip`, `*.png`, `*.jpg`, `*.webp` so **client artwork can
never land in this public repo.** Keep it. Test fixtures stay in a separate scratch folder
(`~/Documents/Dev/active/figma-html5-test/`, not a repo). Also keep client names out of the
source — a comment naming Amazon was genericised before the repo went public.

⚠️ **`~` itself is a git repository with no commits.** Never run `git add` from the home
directory or a path that resolves into it.

---

## 9. Open items

1. **Confirm the real size limit for this team's delivery path** (§6). Highest value, needs
   a human to ask whoever traffics the creative.
2. A teammate was asked to hard-refresh and re-run four files built by an older build — one
   had 7 loops, two carried WebP. Unconfirmed whether that happened.
3. Not evaluated: whether Figma Make could replace the SVG export path. Current read is no
   for delivery — it generates React, and the framework alone is ~140 KB against a 200 KB
   total budget — but it might suit authoring the motion. Secondhand, worth verifying.
4. The tool has no concept of a static backup image, which some placements require.

---

## 10. Working style that fits this user

- **Short reader-facing text.** Lead with the outcome, skip recaps.
- Verify rather than assert. Statements like "this matches spec" get taken at face value
  and shipped, so be explicit about what was actually checked versus assumed.
- Flag risk plainly, including risk in your own work. The caveats in §6 are load-bearing.
- When a decision is genuinely theirs (public repo naming, visibility), ask; otherwise act.
