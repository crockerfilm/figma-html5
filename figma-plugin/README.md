# Copy Motion (Figma plugin)

Animate one banner with Figma Motion, then copy that animation to every layer on the
page that shows the same thing. Layers are matched by what they show, not by their name:

| Layer | Matched by |
|---|---|
| Text | Same copy (ignores line breaks and spacing; case-sensitive) |
| Image, or a component that shows one | Same picture (illustrations are often variants of one component, so the component alone can't tell them apart) |
| Other component instance | Same component, any variant |
| Anything else | Same layer name, flagged in the preview so you can check it |

Copying **replaces** the animation already on each target, so after client feedback you
fix the hero banner and run it again. Every run saves a restore point first, so it can be
undone (see Safety net). Hidden layers are listed
but left unticked. The selected hero is never changed, and a layer is skipped when its
parent already receives the same animation, so nested same-named frames don't double up.

Runs entirely inside Figma, with network access set to none.

## Install (once)

Move this **Copy Motion** folder somewhere it can stay (e.g. Documents/Figma Plugins). Then,
in the Figma desktop app: **Plugins → Development → Import plugin from manifest…** → pick
`manifest.json` in this folder. It then appears under Plugins → Development → Copy Motion.

## Update

Download the latest from https://crockerfilm.github.io/figma-html5/ and replace the files in
this folder with the new ones. No need to import again: Figma reads the folder each time
the plugin runs. The panel's footer shows the version.

## Use

1. Animate the hero banner with animation styles (styles move relative to the layer, so
   they suit every size; hand-placed position keyframes copy as exact pixels).
2. Select that banner and run the plugin.
3. Check the preview. Each animated layer lists what it matched and where. Untick anything
   that shouldn't move.
4. **Copy animation**.

## Same layout mode

For versions that share a layout but differ in copy, colour or imagery. Select the animated
banner(s); every other banner of the **same size** gets the animation in the same places.
Each layer is found by its address in the layer tree (`Contents › Frame 72 › Headline` #1),
and where a version swapped a layer for a differently named one (a new illustration), by
whatever sits in the same spot at about the same size. A weak positional match is reported
as "no match" rather than guessed.

To cover a whole suite: animate one size with **Same content**, which reaches every size of
that message, then select one animated banner per size and run **Same layout**.

## Whole suite mode

Select the one banner you animated. It reaches the rest of the page in three steps, all
planned and previewed before anything changes:

1. **Same content from the hero:** its message at every size.
2. **Same layout from the hero:** every other banner its size, whatever the message.
3. **Same content from each of those banners:** their messages at every size.

Every target takes its animation from a hero layer. The preview lists banners not reached
at all, and banners whose headline copy differs from the same message's banner at the
hero's size (e.g. "Acme is migrating…" vs "Acme migrated…"), which step 3 can't match.

## Export mode (HTML5)

Select the banners to export, or a Version frame or section that holds them; each frame
directly inside a board (a section, or a frame over 2000px) is one banner. Or tick **Find
every banner on this page**: every frame named by its size (`300x250`, `300 x 250`,
`300×250`) that is within 2px of that size is listed, whatever is selected — not frames
nested inside another banner or inside a component. The choice is remembered, and while
it's on, clicking around in Figma doesn't reset what you've built. Banners are grouped by
the frame they sit in; tick a group's heading to take or drop the whole group (a board of
mockups, say). **Build and
check** exports each banner from Figma, rebuilds its Motion animation as CSS, then runs the
converter's checks and packaging. Click a built banner to preview it with a scrubber and
*End frame*. **Download** gives one zip: a zip per banner that passed, named
`<version>_<first words of the headline>_<WxH>.zip`, with its **backup .jpg** beside it
(same name), plus `report.csv` (file, full path, headline, size, KB, length, notes).
Banners that don't meet spec are left out.

**Backup image:** each banner that passes gets one: its end frame as a JPEG under 50 KB, at
the best quality that fits. It's shown under the preview and goes beside the zip, not in it.

**Delivery folders** (optional, under the plays): lay the download out as a delivery. Tick
**Organise the download**, set a **name prefix** (e.g. `CLIENT24`) and give each
**version** — the frame the banners sit in, like *Version B* — a **code** (`1B`). A version
with no code is left out, and so is any banner you untick (a size that wasn't ordered). The
download is then `<prefix>_HTML5_<date>/<prefix>_<code>/<prefix>_<code>_<WxH>.zip` with its
`.jpg` beside it, one of each size, and each zip's page title set to its file name. The panel
says beforehand what it will make and what's left out; the report is offered separately so
the zip can go to the client as it is. The codes are saved in the Figma file, so anyone who
opens it gets the same setup.

**Images and weight:** photos are packed at up to 2× the size they're drawn at, so they
stay sharp on Retina screens, and step down only if a banner would go over 150 KB (Google's
limit, leaving 50 KB for the backup JPG); a photo that would drop below the size it's drawn
at is encoded a little harder instead (JPEG quality 72). **Images that never show** —
copy variants stacked under the visible photo, or a photo used only as a mask's outline —
are left out automatically: each is checked by drawing the banner through its animation
without it, and goes only if nothing on screen changes. The banner's checks say how many.

**Size fixes:** an export must be exactly its frame's size. On the export copy only (your
frame is never changed), the plugin clips anything past the frame's edge and drops the
frame's own drop shadow, and a frame named for a size but 1–2 px off is exported at the
named size — each noted on the banner. A bigger name/size gap blocks with an **Export at
W×H instead** button, since it may be deliberate.

**Edited after building?** A banner changed in Figma after it was built is marked
*Changed in Figma — build again* and isn't downloaded as it was; the button builds just
those again. Each banner's preview also has **Build again**.

**Preview all** opens every built banner side by side in a larger window, each playing
live: *Play all* restarts them together, one scrubber moves them all to the same moment,
*End frames* shows each one's last frame. Filter to Ready or Not to spec; 12 per page.
Click a banner for its full preview and spec checks.

**Plays** (once, 2, 3 or **Loops forever**) and **Pause between plays** sit above the list
set how it plays: the end frame holds for the pause, then the
animation replays, and the last play ends on the end frame. Animation must stop within 15 s
(the IAB guideline; Google rejects anything past 30 s), so **Loops forever** is blocked and
the default is 2 plays with an 8 s pause and a 1 s fade (exactly 15 s for a 3 s timeline). To restart cleanly, tick **Fade animated layers
out before each replay** and the export does it for you: after the pause, every animated layer fades out
over the time you set (0.5 s by default), then the animation replays. Static layers and any
animated layer holding a background-sized image don't fade; the last of a set number of
plays ends on the end frame without fading. One play must be 15 s or less, and all plays
together 15 s or less. Changing them after building marks the banners to build again.

Each banner in the list has **Show**, to find it in Figma. Two banners the same size at
exactly the same spot are flagged as a likely duplicate. Export works on a temporary copy;
if Figma is closed mid-build and a copy is left behind, it is never listed as a banner, and
the list says how many there are with a link to select them for deleting.

The export works on a temporary copy placed on its own at the top of the page — components
on the copy are detached and its animation cleared so it exports at rest — then deleted;
the banner itself is never changed. Motion is rebuilt from each preset's settings (Figma
reports no keyframes for saved styles): fade and straight slides are verified against a
real banner; rotation, scale, diagonal and custom moves are converted but flagged in the
report until someone compares them with Figma's playback.

Why the animation is rebuilt: Figma's plugin API can't export the animated SVG (tested —
the option is ignored), so the plugin writes CSS the way Figma's own animated export does:
per layer, one transform animation (move, then rotate and scale about the layer's centre)
and one opacity animation, one play holding the last frame. Bezier curves are exact;
springs are sampled. Size, path-draw and per-letter text presets can't be converted and are
reported as such.

The checks come from `src/converter.js`, the plugin's engine (limits in its `SPEC`).
`ui.html` is generated — edit `src/ui.html`, then run `node figma-plugin/build.mjs`.

## Safety net

- **Restore points:** every run that changes animation (copy, remove, or going back) saves
  each layer's animation onto that layer before touching it, and a Figma version too.
  *Browse* in the footer lists them newest first. **Go back to before this**
  works on any point, not only the latest: every layer that run, or anything after it,
  changed is put back to how it was just before it ran, after a review showing the count.
  Going back is itself a restore point, so it can be undone. **Show layers** selects what a
  run touched; **Delete** drops a point. The newest 25 are kept.
- Use restore points, not ⌘Z: a long run lands in Figma's undo history as many steps.
- Runs over 150 layers take a second click that states the count.
- **Stop** halts a run part-way; its restore point covers what it already did.
- The plugin only ever changes animation. It never deletes, moves or edits layers.
- It only works on the page that's open. Switching page stops a run, and its restore point
  stays with the page it changed.
- Locked layers, and layers that are part of a main component (changing one would change
  every instance in the file), are left alone and listed as skipped.
- A layer whose current animation the plugin couldn't put back (a built-in preset Figma
  won't let plugins re-apply) isn't changed, so going back is always possible.

**Remove other animation…** (removes animation from everything except your selection) opens a review first: every animated layer in your
selection that will be **kept** (with its animation and a Show link), and what will be
**removed** (the total, by layer name and by top-level frame). Nothing changes until you
confirm in that card. If the selection has no animation, the card warns that the whole page
will be cleared and needs a tick box before it will run. If the page changes between review
and confirm, nothing is removed and a fresh review is shown.

Matching by copy means one hero per message: banners with different headline copy need
their own hero.
