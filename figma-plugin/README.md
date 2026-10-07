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

Figma desktop app → **Plugins → Development → Import plugin from manifest…** → pick
`manifest.json` in this folder. It then appears under Plugins → Development → Copy Motion.

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
web tool's own checks and packaging. Click a built banner to preview it with a scrubber and
*End frame*. **Download** gives one zip: a zip per banner that passed, named
`<version>_<first words of the headline>_<WxH>.zip`, plus `report.csv` (file, full path,
headline, size, KB, length, notes). Banners that don't meet spec are left out, as on the
web tool.

**Size fixes:** an export must be exactly its frame's size. On the export copy only (your
frame is never changed), the plugin clips anything past the frame's edge and drops the
frame's own drop shadow, and a frame named for a size but 1–2 px off is exported at the
named size — each noted on the banner. A bigger name/size gap blocks with an **Export at
W×H instead** button, since it may be deliberate.

**Preview all** opens every built banner side by side in a larger window, each playing
live: *Play all* restarts them together, one scrubber moves them all to the same moment,
*End frames* shows each one's last frame. Filter to Ready or Not to spec; 12 per page.
Click a banner for its full preview and spec checks.

**Plays** (once, 2, 3 or **Loops forever**) and **Pause between plays** sit above the list
and are the same option as on the web tool: the end frame holds for the pause, then the
animation replays. With a number of plays the last play ends on the end frame; with Loops
forever it never stops (as the client's approved banner does), so fade everything out at the
end of the timeline for a clean restart. One play must be 15 s or less; there's no limit on
plays or total time. Changing them after building marks the banners to build again.

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

The checks come from `../index.html` (between `@converter:start` and `@converter:end`).
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

**Remove other animation…** (removes animation from everything except your selection) opens a review first: every animated layer in your
selection that will be **kept** (with its animation and a Show link), and what will be
**removed** (the total, by layer name and by top-level frame). Nothing changes until you
confirm in that card. If the selection has no animation, the card warns that the whole page
will be cleared and needs a tick box before it will run. If the page changes between review
and confirm, nothing is removed and a fresh review is shown.

Matching by copy means one hero per message: banners with different headline copy need
their own hero.
