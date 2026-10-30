# Copy Motion

> **In development.** An internal tool that's still being tested; its checks can miss
> things. Check every banner yourself before delivering it, against the placement's own
> specs. Provided as is, without warranty.

A Figma plugin that copies animation across a banner suite, then exports each banner as
an HTML5 zip with its backup image, aiming at Google's display specs (DV360, Campaign
Manager 360, Ad Manager).

Part of the **[Figma Toolkit](https://hcrocker-sys.github.io/figma-toolkit/)**, with Static Recompose.

**→ [Download and install](https://hcrocker-sys.github.io/figma-toolkit/)**

The site also has two tools that run in the browser, with nothing uploaded:

| Page | What it's for |
|---|---|
| [Plugins](https://hcrocker-sys.github.io/figma-toolkit/) | Download, install and update steps for Copy Motion and Static Recompose, and what's new |
| [Check a delivery](https://hcrocker-sys.github.io/figma-toolkit/preview.html) | Drop a delivery (zips, folders, a zip of zips): every banner plays beside its backup, with weight, length, clickTag, ad.size, external loads and file types checked. Works for Figma and Google Web Designer banners |
| [GWD clickTag](https://hcrocker-sys.github.io/figma-toolkit/gwd.html) | Converts Google Web Designer banners to a standard IAB clickTag with no hardcoded URLs, and checks them |

## Install and update

Figma desktop app → **Plugins → Development → Import plugin from manifest…** → pick
`manifest.json` in the unzipped **Copy Motion** folder. To update, replace that folder's
files with the new ones; Figma picks them up the next time the plugin runs. The panel's
footer shows its version. Full details are in [figma-plugin/README.md](figma-plugin/README.md).

## What it touches

Only the page that's open, and only animation: layers are never moved, edited or deleted.
Every change is previewed first and saves a restore point on each layer plus a Figma
version. Locked layers and main components are left alone. Export works on a temporary
copy, so the banners themselves aren't changed. Its only network access is reading
`copy-motion.json` from the toolkit page, to say when a newer version is out.

## Designing banners for it

1. **End on your end card.** The animation stops on its last frame, and so does the
   backup image. A banner that ends blank, or back on its first frame, is flagged.
2. **Keep the animation short.** Everything must stop within 15 s. The default is 2 plays
   with an 8 s pause, which suits animations of about 3 s; a longer one needs *Plays once*
   (the banner says what fits).
3. **Use transparency only where needed.** An image with an alpha channel ships as PNG,
   roughly ten times the weight of a JPEG. Give a layer its background in Figma if it sits
   on a solid colour.
4. **Never place an image smaller than it's shown.** Images are packed at up to 2× the size
   they're drawn at; one stretched past its own pixels can only look soft.
5. **Flatten live blurs, and don't animate blur.** It's a common reason ads get pulled for
   CPU load.
6. **Name banner frames by their size** (`300x250`) so *Find every banner on this page*
   picks them up.

Motion that converts: fades and slides (checked against Figma's playback); scale,
rotation, diagonal and custom moves (converted, flagged so you compare the preview with
Figma); and hand-placed position, opacity, rotation and scale keyframes. Size, path-draw and per-letter text animation, and animated colour,
blur or corner radius, can't be converted: the banner says which layer, and it stays still.

## Development

| Path | What |
|---|---|
| `figma-plugin/code.js` | The plugin's Figma side: scanning, copying, restore points, export |
| `figma-plugin/src/ui.html` | The panel: plans, building, preview, download |
| `figma-plugin/src/converter.js` | The engine: checks, fixes and packages one banner. Limits live in its `SPEC` |
| `figma-plugin/ui.html` | Generated: `node figma-plugin/build.mjs` inlines the converter and stamps `VERSION` |
| `index.html`, `preview.html`, `gwd.html` | The site (GitHub Pages from `main`) |
| `copy-motion.json` | Copy Motion's version and notes: shown on the site, and read by the plugin's update notice |

**Releasing:** with everything committed, run

```bash
node scripts/release.mjs patch "What changed" "Anything else"
```

(`minor` or `major` instead of `patch`, or an exact `1.2.3`; `--dry-run` to try it). It
stamps the version, builds, zips `dist/Copy-Motion.zip`, adds the notes to the site,
commits, tags, pushes, and publishes the GitHub release the site's download button
points at.

Retargeting a different spec: change `SPEC` at the top of `figma-plugin/src/converter.js`
and rebuild.
