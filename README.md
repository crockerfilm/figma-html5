# Figma → HTML5 Ad Converter

Turns an **animated SVG export from Figma** into a delivery-ready HTML5 display ad zip.

**→ [Open the tool](https://crockerfilm.github.io/figma-html5/)**

Drop an SVG in. It is checked against spec, fixed where a fix is deterministic, and
flagged where a human has to change something in Figma. If anything is flagged, the
download stays disabled — so what comes out is either to spec or not at all.

## Everything runs in your browser

No upload, no server, no analytics, no storage. The file never leaves your machine —
parsing, image recompression and zipping all happen locally. Safe for unreleased client
work. The preview runs in a sandboxed iframe on its own origin.

## Exporting from Figma

In the export panel:

| Setting | Value | Why |
|---|---|---|
| Tab | **Animated** | The Static tab produces no `@keyframes` and the tool will reject it |
| Format | SVG | |
| Ignore overlapping layers | **On** | Turning it off silently downgrades the export to static |
| Outline text | **On** | Otherwise the ad depends on fonts that may not load |
| Include "id" attribute | Off | The animated export already emits the ids its animation needs |

Build the animation so it **ends on your end card**. The tool stops the animation on its
last frame to meet spec, and Figma exports seamless loops whose last frame is the first.

## What it does automatically

- Wraps the artwork in an ad shell with `ad.size` meta and a dynamic IAB `clickTag`
  (no landing page is baked in — the ad server supplies it)
- Caps infinite loops so total animation fits the spec window, holding the last frame
- Realigns diamond/angular gradients, which Figma exports offset from the shape they
  fill, slicing the artwork
- Strips any scripts from the artwork
- Sizes each embedded image independently against measured bytes until the package fits,
  choosing JPEG or PNG from whether that image's own pixels actually use transparency
- Ships images as separate files at the package root rather than base64, avoiding a 33%
  size penalty and any question of whether a validator walks subfolders

## Inspect a built ad

The second tab audits a package that already exists — drop a finished **.zip** or an
**index.html** and it reports what is actually in it rather than rebuilding anything.
Use it to check work that came from someone else, or that was built by an older version
of this tool.

It reads the real bytes: total weight, how many times the animation plays and for how
long, image formats, whether assets sit in subfolders, external calls, clickTag and
`ad.size`. It also gives you a large preview with a timeline scrubber and a **jump to
end frame** button — the quickest way to confirm the ad finishes on your call to action
rather than back on frame one.

A loose `index.html` has no images beside it, so weight can't be judged; formats and
paths are still checked from what the markup references.

## What it refuses to guess

It blocks, and tells you what to change, when the export is static, when text isn't
outlined, when one play exceeds the time limit, when the artwork calls out to the
internet, or when the file simply can't be made small enough. In that last case it
names the specific image or tells you the vector artwork itself is the problem — it
will not quietly degrade images to chase a budget they can't fix.

## Changing the spec

Every threshold lives in the `SPEC` object at the top of `index.html`. Nothing else in
the file needs to change to retarget it at a different placement.

```js
const SPEC = {
  maxZipKB: 200,           // max initial load for an HTML ad tag
  maxAnimationSeconds: 15, // total animation time, including loops
  maxLoops: 3,             // and no more than this many plays
  formatOpaque: "image/jpeg",
  formatAlpha:  "image/png",
  ...
};
```

The shipped defaults follow the published
[Amazon Ads technical guidelines](https://advertising.amazon.com/resources/ad-policy/technical-guidelines):
200 KB maximum initial load, animation up to 3 loops within 15 seconds, and JPG/GIF/PNG
as the listed image formats. Swap them for whatever a brief specifies.

## Browser support

Needs `CompressionStream` for zip building — Chrome/Edge 80+, Safari 16.4+, Firefox 113+.
