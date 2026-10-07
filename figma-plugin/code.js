"use strict";

/* ============================================================================
 * Copy Motion
 * Copies Figma Motion animation from the layers you animated to every layer on
 * this page that shows the same thing — matched by what the layer IS, not by
 * what it's called, because every headline in a banner suite is "Headline".
 *
 *   text       → same copy (whitespace-insensitive, case-sensitive)
 *   instance   → same component (any variant of the same component set)
 *   image fill → same image file
 *   anything else → same layer name, flagged as such in the preview
 *
 * Copying replaces whatever animation the target already had, so re-running
 * after client feedback updates the suite instead of stacking a second copy.
 * ========================================================================== */

figma.showUI(__html__, { width: 440, height: 620, themeColors: true });
// Hidden layers inside components are never targets, and skipping them makes
// walking a large page far faster.
figma.skipInvisibleInstanceChildren = true;

const post = msg => figma.ui.postMessage(msg);
const norm = s => s.replace(/\s+/g, " ").trim();
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;
const secs = v => `${+(v || 0).toFixed(2)}s`;

// Every manual keyframe track on a node, flattened into the field descriptor
// that applyManualKeyframeTrack/removeManualKeyframeTrack expect.
function manualFields(n) {
  const t = n.manualKeyframeTracks || {};
  const out = [];
  for (const k of Object.keys(t)) {
    if (k === "fills" || k === "strokes") {
      for (const i of Object.keys(t[k] || {})) {
        const b = t[k][i];
        if (b && b.keyframes)
          out.push({ field: { type: "INDEXED_ITEM", collection: k, index: Number(i) }, binding: b, label: `${k} ${i}` });
      }
    } else if (k === "effects") {
      for (const i of Object.keys(t.effects || {})) {
        const e = t.effects[i] || {};
        for (const f of Object.keys(e)) {
          if (f === "properties" || !e[f] || !e[f].keyframes) continue;
          out.push({ field: { type: "INDEXED_ITEM", collection: "effects", index: Number(i), field: f }, binding: e[f], label: `effect ${i} ${f}` });
        }
      }
    } else if (t[k] && t[k].keyframes) {
      out.push({ field: { type: "PROPERTY", name: k }, binding: t[k], label: k });
    }
  }
  return out;
}

function hasMotion(n) {
  try {
    if (!("animationStyles" in n)) return false;
    return n.animationStyles.length > 0 || manualFields(n).length > 0;
  } catch (e) {
    return false;
  }
}

function imageHashes(n) {
  if (!("fills" in n) || !Array.isArray(n.fills)) return null;
  const h = n.fills.filter(p => p.type === "IMAGE" && p.visible !== false && p.imageHash).map(p => p.imageHash);
  return h.length ? h.sort().join("+") : null;
}

// Every picture a layer actually shows, including ones inside a component.
// Hidden layers don't count: a size often keeps a hidden spare illustration.
function pictureHashes(n) {
  const out = new Set();
  (function walk(x) {
    if (x.visible === false) return;
    const h = imageHashes(x);
    if (h) h.split("+").forEach(v => out.add(v));
    if ("children" in x) for (const c of x.children) walk(c);
  })(n);
  return out.size ? [...out].sort().join("+") : null;
}

// What a layer shows, as a key two layers share when they show the same thing.
async function matchKey(n, needComponents) {
  if (n.type === "TEXT") {
    const copy = norm(n.characters);
    return { kind: "copy", key: "t:" + copy, label: `same copy “${clip(copy, 60)}”` };
  }
  if (n.type === "INSTANCE") {
    // An instance that shows a picture matches on the picture. Illustrations are
    // often variants of one component, and matching on that would animate every
    // illustration in the suite rather than this one.
    const pics = pictureHashes(n);
    if (pics) return { kind: "image", key: "i:" + pics, label: "same image" };
    if (!needComponents) return null;
    const mc = await n.getMainComponentAsync();
    if (mc) {
      // With no picture involved, sizes often use different variants of one
      // component (small/large CTA), so match on the set rather than the variant.
      const set = mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent : null;
      const c = set || mc;
      return { kind: "component", key: "c:" + (c.key || c.id), label: `same component “${c.name}”` };
    }
  }
  const hashes = imageHashes(n);
  if (hashes) return { kind: "image", key: "i:" + hashes, label: "same image" };
  return { kind: "name", key: "n:" + n.name, label: `same layer name “${n.name}”` };
}

// A built-in Figma preset reads back with an internal id (e.g.
// "CodeComponentId:616:6916") that applyAnimationStyle rejects, so look it up
// again among the presets Figma offers plugins. Saved custom styles are fine as-is.
// Names differ between where a preset is read and where it's offered — a
// saved style may say "motion.preset_name.opacity" where the list says
// "Opacity" — so names are compared without that prefix, case or punctuation.
const presetKey = name => String(name || "").toLowerCase().replace(/^motion\.preset_name\./, "").replace(/[^a-z0-9]/g, "");
function resolveStyleId(s) {
  if (s.type === "CUSTOM") return s.styleId;
  const avail = figma.motion.figmaAnimationStyles();
  const hit = avail.find(a => a.styleId === s.styleId) || avail.find(a => a.name === s.name) ||
              avail.find(a => presetKey(a.name) === presetKey(s.name));
  return hit ? hit.styleId : null;
}

// Figma won't let a plugin animate a layer inside a component instance. When
// that layer fills the instance (a logo's artwork group, say), animating the
// instance looks identical. Returns the outermost instance around n, if any.
function outerInstance(n) {
  let top = null;
  for (let p = n.parent; p && p.type !== "PAGE"; p = p.parent) if (p.type === "INSTANCE") top = p;
  return top;
}

function fills(inner, outer) {
  const a = inner.absoluteBoundingBox, b = outer.absoluteBoundingBox;
  if (!a || !b || !b.width || !b.height) return false;
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 && w * h >= 0.8 * b.width * b.height;
}

function isShown(n) {
  for (let p = n; p && p.type !== "PAGE"; p = p.parent) if (p.visible === false) return false;
  return true;
}

// The whole path from the page down, for pinpointing one banner among many
// that share a name.
// Both are used in error messages, so they must never throw themselves — a
// layer that Figma has just deleted or rebuilt throws on every property read.
function fullWhere(n) {
  try {
    const parts = [n.name];
    for (let p = n.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) parts.unshift(p.name);
    return parts.join(" › ");
  } catch (e) {
    return `a layer that no longer exists (${safeId(n)})`;
  }
}

function where(n) {
  try {
    const parts = [];
    for (let p = n.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) parts.unshift(p.name);
    return parts.slice(-3).join(" › ");
  } catch (e) {
    return "";
  }
}

function safeId(n) { try { return n.id; } catch (e) { return "?"; } }
function safeName(n) { try { return n.name; } catch (e) { return "(deleted layer)"; } }
// Figma marks a node removed when it is deleted or rebuilt — e.g. the layers
// inside an instance after that instance changes.
function gone(n) { try { return !n || n.removed; } catch (e) { return true; } }

// Figma's built-in presets come through with internal names such as
// "motion.preset_name.opacity"; show them the way a person would say them.
function styleName(s) {
  const m = /^motion\.preset_name\.(.+)$/.exec(String((s && s.name) || ""));
  if (!m) return (s && s.name) || "Animation";
  const words = m[1].replace(/[_.]+/g, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (Figma preset)`;
}

function describe(n) {
  const lines = n.animationStyles.map(s =>
    `${styleName(s)} — starts ${secs(s.timelineOffset)}` +
    (s.type !== "CUSTOM" && s.duration != null ? `, lasts ${secs(s.duration)}` : ""));
  const manual = manualFields(n);
  for (const m of manual) lines.push(`${m.label} — ${m.binding.keyframes.length} hand-placed keyframes`);
  // Styles move relative to where a layer sits. Hand-placed keyframes store
  // exact values, which may not suit a layer at a different size or position.
  const pixel = manual.some(m => /^(TRANSLATION|WIDTH|HEIGHT)/.test(m.field.name || ""));
  return { lines, warn: pixel
    ? "Has hand-placed position or size keyframes. These copy as exact pixel values, so check them on the other sizes."
    : "" };
}

const insideAny = (n, ids) => { for (let p = n; p; p = p.parent) if (ids.has(p.id)) return true; return false; };

// Everything in the selection, found by walking DOWN from it. Whether a layer
// is protected is never decided by climbing .parent from the layer: in some
// files that climb doesn't reach the selected frame, so a selected banner's
// own layers looked "outside" it — which once wiped the hero during "remove
// animation from others".
function within(nodes) {
  const ids = new Set();
  for (const n of nodes) {
    ids.add(n.id);
    if ("findAll" in n) for (const d of n.findAll()) ids.add(d.id);
  }
  return ids;
}
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

/* ------------------------------------------------------------- page walk ---- */
// Every layer on the page, in document order, with what climbing .parent can't
// be trusted for in some files — its parent, the outermost component instance
// around it, and whether it and everything above it is visible — worked out
// walking DOWN from the page. Returns null if a newer scan supersedes it.
// One scan walks the page once: its plan and its count of other animation
// share the walk. (Runs pass seq null and always walk fresh.)
let lastWalk = null;
async function walkPage(seq, label) {
  if (seq !== null && lastWalk && lastWalk.seq === seq) return lastWalk.page;
  const page = await walkPageFresh(seq, label);
  if (page && seq !== null) lastWalk = { seq, page };
  return page;
}

async function walkPageFresh(seq, label) {
  const info = new Map(), list = [];
  const stack = [];
  const top = figma.currentPage.children;
  for (let i = top.length - 1; i >= 0; i--) stack.push([top[i], null, null, true]);
  let k = 0;
  while (stack.length) {
    const [n, parent, inst, shownAbove] = stack.pop();
    const shown = shownAbove && n.visible !== false;
    info.set(n.id, { parent, inst, shown });
    list.push(n);
    if (++k % 500 === 0) {
      await pause(`${label} — ${plural(k, "layer")} read`);
      if (stale(seq)) return null;
    }
    if ("children" in n) {
      const ch = n.children, below = inst || (n.type === "INSTANCE" ? n : null);
      for (let i = ch.length - 1; i >= 0; i--) stack.push([ch[i], n.id, below, shown]);
    }
  }
  return {
    list,
    inst: n => (info.get(n.id) || {}).inst || null,          // outermost instance around n
    shown: n => { const i = info.get(n.id); return i ? i.shown : true; },
    // n's ancestors' ids, nearest first
    ancestors: function* (n) { for (let id = (info.get(n.id) || {}).parent; id; id = (info.get(id) || {}).parent) yield id; }
  };
}

/* ------------------------------------------------------------ progress ---- */
// The plugin runs on Figma's own thread, so a long loop freezes the canvas.
// Long jobs hand control back every few milliseconds, which keeps Figma
// responsive and lets the status line show what is happening.
let lastPause = Date.now();
const say = text => post({ type: "progress", text });
async function pause(text) {
  if (Date.now() - lastPause < 40) return;
  say(text);
  await new Promise(r => setTimeout(r, 0));
  lastPause = Date.now();
}

// A newer selection supersedes the scan in progress. Every scan checks this
// at each pause and stops, rather than finishing work nobody will see.
let scanSeq = 0;
const stale = seq => seq !== null && seq !== scanSeq;

// Every animated layer on the page outside the selection — what "remove from
// all except selected" would clear. Returns null if superseded.
async function animatedOutside(sel, seq) {
  const ids = within(sel);
  const page = await walkPage(seq, "Looking for other animated layers");
  if (!page) return null;
  const found = [];
  // Layers inside a component instance get their animation from the main
  // component. A plugin can't remove it there, and touching the instance
  // rebuilds those layers under new ids, so they're counted, not listed.
  found.inherited = 0;
  for (let i = 0; i < page.list.length; i++) {
    const n = page.list[i];
    if (i % 200 === 0) {
      await pause(`Looking for other animated layers — ${plural(i, "layer")} of ${page.list.length.toLocaleString()} checked`);
      if (stale(seq)) return null;
    }
    if (!hasMotion(n) || ids.has(n.id)) continue;
    if (page.inst(n)) found.inherited++;
    else found.push(n);
  }
  return found;
}

function presetProblem(n) {
  const stuck = n.animationStyles.filter(a => !resolveStyleId(a)).map(styleName);
  if (!stuck.length) return "";
  const offered = figma.motion.figmaAnimationStyles().map(styleName).slice(0, 12).join(", ");
  return `“${stuck.join("”, “")}” is one of Figma's built-in presets, and Figma won't let a plugin re-apply it. ` +
    `Save this layer's animation as your own animation style (the way the headlines are done) and run this again.` +
    (offered ? ` (Presets Figma offers plugins: ${offered}.)` : "");
}

/* --------------------------------------------------------------- scan ---- */
// "content": copy to layers showing the same copy, image or component, at any size.
// "layout":  copy to the same spot in other banners of the same size, whatever
//            they show — for versions with different copy, colour or imagery.
let mode = "content";

async function scan() {
  const seq = ++scanSeq;
  const sel = figma.currentPage.selection;
  post({ type: "others", count: null, selected: sel.length });
  if (!sel.length)
    post({ type: "plan", mode, error: {
      layout: "Select the banner(s) you animated. Each one is copied to every other banner of the same size.",
      suite: "Select the one banner you animated. Its animation goes to every banner on this page.",
      export: "Select the banners to export, or a Version frame or section that holds them.",
      content: "Select the animated banner, or just the animated layers in it." }[mode] });
  else if (mode === "layout") await scanLayout(seq, sel);
  else if (mode === "suite") await scanSuite(seq, sel);
  else if (mode === "export") await scanExport(seq, sel);
  else await scanContent(seq, sel);
  if (stale(seq)) return;
  if (mode === "export") { postHistory(); say(""); return; }

  const others = await animatedOutside(sel, seq);
  if (!others) return;
  post({ type: "others", count: others.length, selected: sel.length });
  postHistory();
  say("");
}

async function scanContent(seq, sel) {
  say("Reading the animation on the selection…");
  // The selection, plus everything animated inside it — so selecting the whole
  // hero banner picks up every animated layer at once.
  const sources = [], seen = new Set();
  for (const s of sel) {
    const cands = [s].concat("findAll" in s ? s.findAll(hasMotion) : []);
    for (const c of cands) if (!seen.has(c.id) && hasMotion(c)) { seen.add(c.id); sources.push(c); }
  }
  if (!sources.length)
    return post({ type: "plan", mode, error: "Nothing in the selection has Motion animation on it yet." });

  const entries = [];
  const byKey = new Map();
  for (const s of sources) {
    const k = await matchKey(s, true);
    const d = describe(s);
    const entry = { id: s.id, name: s.name, kind: k.kind, key: k.key, label: k.label,
                    sourceName: s.name, lines: d.lines, warn: d.warn, matches: [], locked: [], note: "", blocked: "" };
    entry.blocked = presetProblem(s);
    // Two animated layers showing the same thing would fight over the same
    // targets. The first one wins; say so rather than pick silently.
    if (byKey.has(k.key)) entry.note = `Same ${k.kind === "copy" ? "copy" : "match"} as “${byKey.get(k.key).name}” above, so its animation is the one copied.`;
    else byKey.set(k.key, entry);
    entries.push(entry);
  }
  const needComponents = entries.some(e => e.kind === "component");
  const byName = new Map(entries.filter(e => e.kind === "name" && !e.note).map(e => [e.sourceName, e]));

  // The hero is the reference, never a target — otherwise a name match can
  // reach into it and animate the frames nested inside the animated one.
  const heroIds = within(sel);

  const page = await walkPage(seq, "Reading the layers on this page");
  if (!page) return;
  const nodes = page.list;
  const claimed = new Set();
  const matchedBy = new Map();   // node id → entry it was matched to
  let found = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (i % 100 === 0) {
      await pause(`Comparing ${plural(i, "layer")} of ${nodes.length.toLocaleString()} with the ${plural(entries.length, "animated layer")} — ${found} match${found === 1 ? "" : "es"} so far`);
      if (stale(seq)) return;
    }
    const n = nodes[i];
    if (heroIds.has(n.id)) continue;
    const k = await matchKey(n, needComponents);
    let entry = k && byKey.get(k.key);
    // A name-matched source also claims same-named layers of other kinds — a
    // logo can be a frame in one size and an instance in the next.
    if (!entry && byName.has(n.name)) entry = byName.get(n.name);
    if (!entry) continue;

    let target = n, via = "";
    const inst = page.inst(n);
    if (inst) {
      if (!fills(n, inst)) {
        entry.locked.push(`${where(n)} › ${n.name}`);
        continue;
      }
      target = inst;
      via = `applied to the whole component “${inst.name}”, since Figma can't animate a layer inside one`;
    }
    if (claimed.has(target.id)) continue;
    // Skip a layer whose parent already gets this same animation: Figma files
    // nest same-named frames, and animating both doubles the motion.
    let nested = false;
    for (const id of page.ancestors(target)) if (matchedBy.get(id) === entry) { nested = true; break; }
    if (nested) continue;
    claimed.add(target.id);
    matchedBy.set(target.id, entry);
    entry.matches.push({ id: target.id, name: target.name, where: where(target), hidden: !page.shown(target), via });
    found++;
  }

  if (stale(seq)) return;
  post({ type: "plan", mode, entries: entries.map(e => Object.assign({}, e, { key: undefined })) });
}

/* -------------------------------------------------------- layout mode ---- */
// Of a set of frames, only those not inside another one of the set — judged
// from each frame's contents, never by climbing .parent. A banner's
// same-size wrapper frame is part of that banner, not a second banner.
function outermost(frames) {
  const inside = new Set();
  for (const f of frames) for (const d of f.findAllWithCriteria({ types: ["FRAME"] })) inside.add(d.id);
  return frames.filter(f => !inside.has(f.id));
}
const sizeKey = n => `${Math.round(n.width)}×${Math.round(n.height)}`;

// Layout mode works downward from the banner rather than climbing up from a
// layer: the banner is known, and a downward walk can't wander off the top of
// the page the way following .parent did in some files.

// Every layer in a banner with its address (the chain of layer names from the
// banner down, with "which one" among same-named siblings at each step), its
// position, whether it and everything above it is visible, and the outermost
// component instance it sits inside, if any. Read once per banner.
function mapBanner(banner) {
  const byId = new Map(), list = [];
  (function walk(x, path, shown, inst) {
    const counts = new Map();
    for (const c of x.children || []) {
      const key = c.type + "\u0000" + c.name;
      const i = counts.get(key) || 0;
      counts.set(key, i + 1);
      const entry = {
        node: c,
        path: path.concat([{ name: c.name, type: c.type, i }]),
        shown: shown && c.visible !== false,
        inst: inst || (c.type === "INSTANCE" ? c : null),
        box: null
      };
      byId.set(c.id, entry);
      list.push(entry);
      walk(c, entry.path, entry.shown, inst || (c.type === "INSTANCE" ? c : null));
    }
  })(banner, [], true, null);
  return { byId, list };
}

function relBox(n, root) {
  const a = n.absoluteBoundingBox, r = root.absoluteBoundingBox;
  return a && r ? { x: a.x - r.x, y: a.y - r.y, w: a.width, h: a.height } : null;
}

function overlap(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.w * a.h + b.w * b.h - w * h);
}

const samePrefix = (path, prefix) =>
  prefix.every((s, k) => path[k] && path[k].name === s.name && path[k].type === s.type && path[k].i === s.i);

// The layer in a banner that plays the part `src` plays in the hero: the same
// address first; where a version swapped that layer for a differently named
// one (a new illustration, say), whatever visible layer sits in the same spot
// at about the same size, looked for under the deepest part of the address
// that still matched. Nothing is better than a wrong guess, so a weak
// positional match returns null.
function counterpart(banner, map, src, used) {
  const want = src.path.map(s => s.name + "\u0000" + s.type + "\u0000" + s.i).join("\u0001");
  let deepest = [];
  for (const e of map.list) {
    const got = e.path.map(s => s.name + "\u0000" + s.type + "\u0000" + s.i).join("\u0001");
    if (got === want) {
      if (e.shown && !used.has(e.node.id)) return { entry: e, how: "same layer" };
      deepest = src.path.slice(0, -1);
      break;
    }
    if (want.startsWith(got + "\u0001") && e.path.length > deepest.length) deepest = e.path;
  }

  let best = null, score = 0;
  for (const e of map.list) {
    if (!e.shown || used.has(e.node.id) || e.path.length <= deepest.length || !samePrefix(e.path, deepest)) continue;
    if (!e.box) e.box = relBox(e.node, banner);
    const sc = overlap(e.box, src.box) + (e.node.type === src.type ? 0.05 : 0);
    if (sc > score) { score = sc; best = e; }
  }
  return score >= 0.6 ? { entry: best, how: `same position (“${best.node.name}”)` } : null;
}

// Where a layer sits, for an error message: its ancestry as Figma reports it.
function ancestry(n) {
  const out = [];
  for (let x = n, k = 0; x && k < 10; x = x.parent, k++) out.push(`${x.type} “${x.name}” (${x.id})`);
  return out.join(" ← ");
}

async function scanLayout(seq, sel) {
  const heroes = sel.filter(n => "findAll" in n);
  if (!heroes.length)
    return post({ type: "plan", mode, error: "Select whole banners for this mode, not individual layers." });
  const heroIds = within(heroes);

  // Frames only, found by Figma itself rather than walking every layer.
  say("Finding banner-sized frames on this page…");
  await new Promise(r => setTimeout(r, 0));
  if (stale(seq)) return;
  const frames = figma.currentPage.findAllWithCriteria({ types: ["FRAME"] });
  // Frames inside a component instance, found from the instances downward.
  const inInstance = new Set();
  for (const inst of figma.currentPage.findAllWithCriteria({ types: ["INSTANCE"] }))
    for (const f of inst.findAllWithCriteria({ types: ["FRAME"] })) inInstance.add(f.id);

  const taken = new Set();
  const out = [];
  for (const [hi, hero] of heroes.entries()) {
    const label = heroes.length > 1 ? ` (banner ${hi + 1} of ${heroes.length})` : "";
    say(`Reading the animation on ${hero.name}${label}…`);
    const h = { id: hero.id, name: hero.name, size: sizeKey(hero), sources: [], blocked: [], banners: [] };
    const heroMap = mapBanner(hero);
    for (const s of hero.findAll(hasMotion)) {
      const problem = presetProblem(s);
      if (problem) { h.blocked.push(`${s.name}: ${problem}`); continue; }
      const e = heroMap.byId.get(s.id);
      if (!e) throw new Error(`Couldn't find “${s.name}” (${s.id}) by walking down from “${hero.name}” (${hero.type} ${hero.id}). Its ancestry: ${ancestry(s)}`);
      h.sources.push({ node: s, name: s.name, type: s.type, lines: describe(s).lines, path: e.path, box: relBox(s, hero) });
    }
    out.push(h);
    if (!h.sources.length) continue;

    // Every other banner this size: not a selected hero, not part of a
    // component, not inside another candidate (inner frames can share its size).
    const cands = frames.filter(n => sizeKey(n) === h.size && !heroIds.has(n.id) && !inInstance.has(n.id));
    const banners = outermost(cands).filter(b => !taken.has(b.id));
    for (const b of banners) taken.add(b.id);

    for (const [bi, b] of banners.entries()) {
      await pause(`Matching ${h.size}${label}: banner ${bi + 1} of ${banners.length} — ${where(b)} › ${b.name}`);
      if (stale(seq)) return;
      const used = new Set(), pairs = [], missing = [], locked = [];
      const map = mapBanner(b);
      for (const s of h.sources) {
        const c = counterpart(b, map, s, used);
        if (!c) { missing.push(s.name); continue; }
        let target = c.entry.node, how = c.how;
        const inst = c.entry.inst;
        if (inst && inst.id !== target.id) {
          if (!fills(target, inst)) { locked.push(s.name); continue; }
          target = inst;
          how += ", applied to the whole component";
        }
        used.add(target.id);
        pairs.push({ src: s.node.id, tgt: target.id, srcName: s.name, tgtName: target.name, how });
      }
      h.banners.push({ id: b.id, name: b.name, where: where(b), hidden: !isShown(b), pairs, missing, locked });
    }
  }

  if (stale(seq)) return;
  post({ type: "plan", mode, heroes: out.map(h => Object.assign({}, h, {
    sources: h.sources.map(s => ({ name: s.name, lines: s.lines })) })) });
}

/* --------------------------------------------------------- whole suite ---- */
// One animated banner reaches the whole suite in three steps, all planned
// before anything changes:
//   1. same content from the hero  — its message, at every size
//   2. same layout from the hero   — every other banner its size, any message
//   3. same content from each banner step 2 reached — their messages, every size
// The banners from step 2 are the bridge between messages; content matching is
// the bridge between sizes. Every target still takes its animation from a
// hero layer, so the result is exactly what the hero shows.
let suitePlan = null;

async function scanSuite(seq, sel) {
  const heroes = sel.filter(n => "findAll" in n);
  if (heroes.length !== 1)
    return post({ type: "plan", mode, error: "Select the one banner you animated. Its animation goes to every banner on this page." });
  const hero = heroes[0];
  const heroIds = within([hero]);
  const size = sizeKey(hero);

  say(`Reading the animation on ${hero.name}…`);
  const heroMap = mapBanner(hero);
  const sources = [], blocked = [];
  for (const s of hero.findAll(hasMotion)) {
    const problem = presetProblem(s);
    if (problem) { blocked.push(`${s.name}: ${problem}`); continue; }
    const e = heroMap.byId.get(s.id);
    if (!e) throw new Error(`Couldn't find “${s.name}” (${s.id}) by walking down from “${hero.name}”. Its ancestry: ${ancestry(s)}`);
    sources.push({ node: s, name: s.name, type: s.type, lines: describe(s).lines, path: e.path, box: relBox(s, hero) });
  }
  if (!sources.length)
    return post({ type: "plan", mode, error: blocked.length ? blocked.join(" ") : "Nothing in the selection has Motion animation on it yet." });

  const assign = new Map();   // target layer id → { src, step }
  let lockedCount = 0, hiddenSkipped = 0;

  const page = await walkPage(seq, "Reading the layers on this page");
  if (!page) return;
  const frames = page.list.filter(n => n.type === "FRAME");

  // Step 2 is planned first: its banners feed step 3.
  say(`Step 2: finding the other ${size} banners…`);
  const sameSize = outermost(frames.filter(b => sizeKey(b) === size && !heroIds.has(b.id) && !page.inst(b)));
  const layoutBanners = [], bridges = [];
  for (const [bi, b] of sameSize.entries()) {
    await pause(`Step 2: matching ${size} banner ${bi + 1} of ${sameSize.length} — ${where(b)} › ${b.name}`);
    if (stale(seq)) return;
    const used = new Set(), missing = [], locked = [];
    let found = 0;
    const map = mapBanner(b);
    for (const s of sources) {
      const c = counterpart(b, map, s, used);
      if (!c) { missing.push(s.name); continue; }
      let target = c.entry.node;
      const inst = c.entry.inst;
      if (inst && inst.id !== target.id) {
        if (!fills(target, inst)) { locked.push(s.name); lockedCount++; continue; }
        target = inst;
      }
      used.add(target.id);
      if (!page.shown(b)) { hiddenSkipped++; continue; }
      assign.set(target.id, { src: s.node.id, step: 2 });
      bridges.push({ node: c.entry.node, src: s, from: b.name });
      found++;
    }
    layoutBanners.push({ id: b.id, where: fullWhere(b), found, missing, locked });
  }

  // Steps 1 and 3: what each source layer shows, then one pass over the page.
  say("Steps 1 and 3: reading what each animated layer shows…");
  const byKey = new Map(), byName = new Map();
  let conflicts = 0;
  const register = async (node, src, step) => {
    const k = await matchKey(node, true);
    const prev = byKey.get(k.key);
    if (prev) { if (prev.src.node.id !== src.node.id) conflicts++; return; }
    const rec = { src, step, kind: k.kind };
    byKey.set(k.key, rec);
    if (k.kind === "name" && !byName.has(node.name)) byName.set(node.name, rec);
  };
  // The hero registers first, so its own copy wins any conflict.
  for (const s of sources) await register(s.node, s, 1);
  for (const [i, b] of bridges.entries()) {
    if (i % 20 === 0) { await pause(`Step 3: reading layer ${i + 1} of ${bridges.length} in the ${size} banners`); if (stale(seq)) return; }
    await register(b.node, b.src, 3);
  }
  const needComponents = [...byKey.values()].some(r => r.kind === "component");

  const nodes = page.list;
  for (let i = 0; i < nodes.length; i++) {
    if (i % 100 === 0) {
      await pause(`Steps 1 and 3: comparing ${plural(i, "layer")} of ${nodes.length.toLocaleString()} — ${plural(assign.size, "match")} so far`);
      if (stale(seq)) return;
    }
    const n = nodes[i];
    if (heroIds.has(n.id)) continue;
    const k = await matchKey(n, needComponents);
    let rec = k && byKey.get(k.key);
    if (!rec && byName.has(n.name)) rec = byName.get(n.name);
    if (!rec) continue;
    let target = n;
    const inst = page.inst(n);
    if (inst) {
      if (!fills(n, inst)) { lockedCount++; continue; }
      target = inst;
    }
    if (assign.has(target.id)) continue;
    // Skip a layer whose parent already gets this same animation.
    let nested = false;
    for (const id of page.ancestors(target)) { const a = assign.get(id); if (a && a.src === rec.src.node.id) { nested = true; break; } }
    if (nested) continue;
    if (!page.shown(target)) { hiddenSkipped++; continue; }
    assign.set(target.id, { src: rec.src.node.id, step: rec.step });
  }

  // Which banners were reached. The hero's siblings define the suite's sizes.
  say("Checking which banners were reached…");
  await new Promise(r => setTimeout(r, 0));
  if (stale(seq)) return;
  const sizes = new Set([size]);
  if (hero.parent && hero.parent.children)
    for (const c of hero.parent.children) if (c.type === "FRAME") sizes.add(sizeKey(c));
  // A banner-sized frame only counts as a banner if it holds at least half the
  // kinds of layer the hero animates — otherwise a header panel with a
  // "Headline" label, or an image mask, would be reported as a missed banner.
  // Text and non-text count as different kinds, so a "CTA" text label doesn't
  // pass for a CTA button.
  const kindOf = n => n.name + (n.type === "TEXT" ? "\u0000text" : "\u0000shape");
  const kinds = new Set(sources.map(s => kindOf(s.node)));
  const kindNames = new Set(sources.map(s => s.name));
  const needKinds = Math.ceil(kinds.size / 2);
  // Containment is worked out downward, from each frame's own contents —
  // never by climbing .parent, which in some files doesn't reach the frame a
  // layer is in. A banner-sized wrapper frame inside a banner is part of that
  // banner, not a second one.
  const candidates = [];
  for (const [ci, b] of frames.entries()) {
    if (ci % 25 === 0) { await pause(`Checking which frames are banners — ${ci + 1} of ${frames.length}`); if (stale(seq)) return; }
    if (!sizes.has(sizeKey(b)) || heroIds.has(b.id) || page.inst(b) || !page.shown(b)) continue;
    const inside = b.findAll();
    const has = new Set();
    for (const n of inside) if (kindNames.has(n.name) && kinds.has(kindOf(n)) && page.shown(n)) has.add(kindOf(n));
    if (has.size < needKinds) continue;
    candidates.push({ node: b, inside });
  }
  const nested = new Set();
  for (const c of candidates) for (const n of c.inside) nested.add(n.id);
  const banners = [];
  for (const c of candidates) if (!nested.has(c.node.id)) { banners.push(c.node); c.texts = c.inside.filter(n => n.type === "TEXT"); }
  const kept = candidates.filter(c => !nested.has(c.node.id));
  const textsOf = new Map(kept.map(c => [c.node.id, c.texts]));
  const insideOf = new Map(kept.map(c => [c.node.id, c.inside]));
  // Each banner checks its own layers against the plan directly. An earlier
  // version credited each layer to "its banner" through a lookup, and in some
  // files that lookup disagreed with the banner's own contents.
  const reached = new Map();   // banner id → { 1: n, 2: n, 3: n }
  for (const c of kept) {
    const r = { 1: 0, 2: 0, 3: 0 };
    let any = false;
    for (const n of c.inside) {
      const a = assign.get(n.id);
      if (a) { r[a.step]++; any = true; }
    }
    if (any) reached.set(c.node.id, r);
  }
  // Text the hero animated, by layer name, that a reached banner shows with
  // copy no source matched — usually a shortened or edited headline.
  const animatedTextNames = new Set(sources.filter(s => s.type === "TEXT").map(s => s.name));
  // The animated copy closest to an unmatched headline, by shared words — so
  // "Acme migrated…" shows its near-twin "Acme is migrating…" and the one-word
  // difference is obvious at a glance.
  const animatedCopy = [...byKey.keys()].filter(k => k.startsWith("t:")).map(k => k.slice(2));
  const words = t => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean));
  const nearestCopy = copy => {
    const a = words(copy);
    let best = "", score = 0;
    for (const c of animatedCopy) {
      const b = words(c);
      let shared = 0;
      for (const w of a) if (b.has(w)) shared++;
      const sc = shared / Math.max(1, new Set([...a, ...b]).size);
      if (sc > score) { score = sc; best = c; }
    }
    return score >= 0.5 ? best : "";
  };
  const notReached = [], partial = [];
  for (const [bi, b] of banners.entries()) {
    if (bi % 10 === 0) { await pause(`Checking banner ${bi + 1} of ${banners.length} for anything missed`); if (stale(seq)) return; }
    if (!reached.has(b.id)) {
      // Say why: for each layer named like an animated hero layer, what the
      // matching saw. Guessing at the cause from counts has been wrong before.
      const why = [];
      for (const n of (insideOf.get(b.id) || []).filter(n => kindNames.has(n.name))) {
        if (why.length >= 5) break;
        let reason;
        if (!page.shown(n)) reason = "hidden, so left alone";
        else {
          const k = await matchKey(n, true);
          const rec = (k && byKey.get(k.key)) || byName.get(n.name);
          const inst = page.inst(n);
          if (!rec) reason = !k ? "can't be compared"
            : k.kind === "copy" ? `its wording (“${clip(norm(n.characters), 50)}”) doesn't match any animated banner`
            : k.kind === "component" ? `it's a different component from the animated one (${k.label.replace(/^same component /, "")})`
            : k.kind === "image" ? "it shows a different picture from any animated one"
            : "nothing animated has this name";
          else if (inst && !fills(n, inst)) reason = `it's inside the “${inst.name}” component, which a plugin can't animate`;
          else if (assign.has(n.id) || (inst && assign.has(inst.id))) reason = "will be animated";
          else reason = "covered by the animated layer around it";
        }
        why.push(`${n.name}: ${reason}`);
      }
      if (!why.length) why.push(`Has no layer called ${[...kindNames].map(x => `“${x}”`).join(" or ")}, so nothing could be matched.`);
      notReached.push({ id: b.id, where: fullWhere(b), why });
      continue;
    }
    const missed = (textsOf.get(b.id) || [])
      .filter(t => animatedTextNames.has(t.name) && !assign.has(t.id) && page.shown(t))
      .map(t => {
        const copy = norm(t.characters), near = nearestCopy(copy);
        return { copy: clip(copy, 60), near: near ? clip(near, 60) : "" };
      });
    if (missed.length) partial.push({ id: b.id, where: fullWhere(b), texts: missed });
  }

  // Copy check: the same message worded slightly differently on different
  // banners is almost always a typo or a copy edit that missed some sizes.
  // Group every visible text by its wording, then join wordings that share
  // most of their words but aren't identical.
  say("Checking the wording matches across banners…");
  const variants = new Map();   // wording → { count, sizes, ids }
  for (const c of kept) {
    for (const t of c.texts) {
      if (!page.shown(t)) continue;
      const copy = norm(t.characters);
      if (copy.split(" ").length < 3) continue;   // too short to judge ("See how")
      const v = variants.get(copy) || { copy, count: 0, sizes: new Set(), ids: new Set() };
      if (!v.ids.has(c.node.id)) { v.count++; v.ids.add(c.node.id); v.sizes.add(sizeKey(c.node)); }
      variants.set(copy, v);
    }
  }
  const similar = (x, y) => {
    const a = words(x), b = words(y);
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.max(1, new Set([...a, ...b]).size);
  };
  const list = [...variants.values()];
  const group = new Map(list.map(v => [v.copy, v.copy]));
  const root = c => { while (group.get(c) !== c) c = group.get(c); return c; };
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (similar(list[i].copy, list[j].copy) >= 0.6) group.set(root(list[j].copy), root(list[i].copy));
  const clusters = new Map();
  for (const v of list) {
    const r = root(v.copy);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(v);
  }
  const copyIssues = [...clusters.values()].filter(c => c.length > 1).map(c =>
    c.sort((a, b) => b.count - a.count).map(v => ({ copy: v.copy, count: v.count, sizes: [...v.sizes], ids: [...v.ids].slice(0, 300) })));

  const steps = { 1: new Map(), 2: new Map(), 3: new Map() };
  for (const [tid, a] of assign) {
    const m = steps[a.step];
    if (!m.has(a.src)) m.set(a.src, []);
    m.get(a.src).push(tid);
  }
  const bannersPerStep = { 1: 0, 2: 0, 3: 0 };
  for (const r of reached.values()) for (const s of [1, 2, 3]) if (r[s]) bannersPerStep[s]++;

  if (stale(seq)) return;
  suitePlan = { seq, steps };
  const count = s => [...steps[s].values()].reduce((n, l) => n + l.length, 0);
  post({ type: "plan", mode,
    hero: { name: hero.name, size, sources: sources.map(s => ({ name: s.name, lines: s.lines })) },
    blocked,
    steps: [1, 2, 3].map(s => ({ step: s, layers: count(s), banners: bannersPerStep[s] })),
    layoutBanners: layoutBanners.filter(b => b.missing.length || b.locked.length),
    bannerTotal: banners.length, reachedTotal: reached.size,
    notReached, partial, copyIssues, conflicts, hiddenSkipped, lockedCount });
}

/* ------------------------------------------------------ restore points ---- */
// Every run that changes animation is a restore point. Before the run touches
// a layer, that layer's current animation is written onto the layer itself
// under a key belonging to the run ("copyMotion.b.<run id>"), and the page
// keeps an index of runs. A later run never overwrites an earlier one's
// backups, so the file holds a browsable history. It survives closing Figma.
const INDEX = "copyMotion.runs", KEY = id => `copyMotion.b.${id}`, MAX_POINTS = 25;
// Backups left by the earlier single-slot version of this plugin, still read.
const LEGACY = "copyMotion.before", LEGACY_NOTE = "copyMotion.lastRun";

function snapshot(n) {
  return {
    styles: n.animationStyles.map(a => ({ type: a.type, styleId: a.styleId, name: a.name,
      timelineOffset: a.timelineOffset || 0, duration: a.duration, props: a.props })),
    tracks: manualFields(n).map(m => ({ field: m.field, baseValue: m.binding.baseValue,
      keyframes: m.binding.keyframes.map(k => ({ timelinePosition: k.timelinePosition, easing: k.easing, value: k.value })) }))
  };
}

const readJSON = (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } };
const readIndex = () => readJSON(figma.currentPage.getPluginData(INDEX), []);
const writeIndex = list => figma.currentPage.setPluginData(INDEX, JSON.stringify(list));

function findByKey(key) {
  try {
    return figma.currentPage.findAllWithCriteria({ pluginData: { keys: [key] } });
  } catch (e) {
    // Slower, but works where searching by plugin data isn't supported.
    return figma.currentPage.findAll(n => { try { return !!n.getPluginData(key); } catch (x) { return false; } });
  }
}

// Every restore point on this page, newest first.
function listPoints() {
  const points = readIndex().map(p => Object.assign({ legacy: false }, p));
  const byRun = new Map();
  for (const n of findByKey(LEGACY)) {
    const b = readJSON(n.getPluginData(LEGACY), null);
    if (b && b.run) byRun.set(b.run, (byRun.get(b.run) || 0) + 1);
  }
  const note = readJSON(figma.currentPage.getPluginData(LEGACY_NOTE), null);
  for (const [id, count] of byRun)
    if (!points.some(p => p.id === id))
      points.push({ id, label: note && note.id === id ? note.label : "Earlier run", at: parseInt(id, 36), count, legacy: true });
  return points.sort((a, b) => b.at - a.at);
}

// The animation a point saved for one layer, or null if it holds none.
function readBackup(n, p) {
  if (p.legacy) {
    const b = readJSON(n.getPluginData(LEGACY), null);
    return b && b.run === p.id ? b.data : null;
  }
  return readJSON(n.getPluginData(KEY(p.id)), null);
}

const nodesOf = p => (p.legacy ? findByKey(LEGACY) : findByKey(KEY(p.id))).filter(n => readBackup(n, p));

function dropBackups(p) {
  for (const n of nodesOf(p)) {
    try { n.setPluginData(p.legacy ? LEGACY : KEY(p.id), ""); } catch (e) { /* layer gone or locked */ }
  }
}

function newRun(label) {
  return { id: Date.now().toString(36), label, at: Date.now(), count: 0, versionSaved: false };
}

// Record a layer's animation before the run touches it. Throws if it can't,
// so the caller leaves the layer alone rather than change it unprotected.
function protect(run, n) {
  if (n.getPluginData(KEY(run.id))) return;   // this run already saved it
  n.setPluginData(KEY(run.id), JSON.stringify(snapshot(n)));
  run.count++;
}

function saveRun(run) {
  if (!run.count) return;
  const list = readIndex().filter(p => p.id !== run.id);
  list.push({ id: run.id, label: run.label, at: run.at, count: run.count, versionSaved: run.versionSaved });
  list.sort((a, b) => a.at - b.at);
  // Keep the newest; the oldest take their backups with them.
  while (list.length > MAX_POINTS) dropBackups(list.shift());
  writeIndex(list);
  postHistory();
}

function postHistory() {
  let points = [], error = "";
  try { points = listPoints(); } catch (e) { error = String((e && e.message) || e); }
  post({ type: "history", page: figma.currentPage.name, error,
    points: points.map(p => ({ id: p.id, label: p.label, at: p.at, count: p.count, versionSaved: !!p.versionSaved, legacy: p.legacy })) });
}

// A real Figma version, saved before any run that changes the file — File ›
// Show version history can roll back to it whatever the plugin did. ⌘Z can't
// be relied on: a long run lands as many undo steps.
async function saveVersion(label) {
  say("Saving a version to Figma's history first…");
  try {
    await figma.saveVersionHistoryAsync(`Copy Motion: before ${label}`,
      "Saved automatically by the Copy Motion plugin before it changed animation. Restore this version to undo that run.");
    return true;
  } catch (e) {
    return false;
  }
}

// The config to re-apply a style. A built-in preset keeps its start both as
// the timeline offset and as its "delay" setting; Figma stores the two equal,
// so they're kept equal here rather than risk the delay counting twice.
function styleConfig(s) {
  if (s.type === "CUSTOM") return { type: "CUSTOM", timelineOffset: s.timelineOffset || 0 };
  const cfg = { type: "FIGMA", timelineOffset: s.timelineOffset || 0 };
  if (s.duration != null) cfg.duration = s.duration;
  if (s.props) cfg.props = "delay" in s.props ? Object.assign({}, s.props, { delay: cfg.timelineOffset }) : s.props;
  return cfg;
}

function clearAnimation(n) {
  for (const s of n.animationStyles.slice()) n.removeAnimationStyle(s.id);
  for (const m of manualFields(n)) n.removeManualKeyframeTrack(m.field);
}

// What "go back to before point X" changes: every layer that X or any later
// point touched, set to the backup from the earliest of those points that
// touched it — which is exactly how that layer looked before X ran.
function planGoBack(id) {
  const points = listPoints();
  const idx = points.findIndex(p => p.id === id);
  if (idx < 0) return null;
  const target = new Map();
  for (const p of points.slice(0, idx + 1)) {          // newest → X
    for (const n of nodesOf(p)) {
      const data = readBackup(n, p);
      if (data) target.set(n.id, { node: n, data });    // older points overwrite newer
    }
  }
  return { point: points[idx], later: points.slice(0, idx), target };
}

function reviewGoBack(id, note) {
  const plan = planGoBack(id);
  if (!plan) return post({ type: "crash", text: "That restore point no longer exists on this page." });
  const names = new Map();
  for (const { node } of plan.target.values()) {
    const nm = safeName(node);
    names.set(nm, (names.get(nm) || 0) + 1);
  }
  post({ type: "goBackReview", note: note || "", id, label: plan.point.label, at: plan.point.at,
    layers: plan.target.size, versionSaved: !!plan.point.versionSaved,
    later: plan.later.map(p => p.label),
    names: [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })) });
}

async function goBack(id, expected) {
  const plan = planGoBack(id);
  if (!plan) return post({ type: "crash", text: "That restore point no longer exists on this page." });
  if (expected != null && plan.target.size !== expected)
    return reviewGoBack(id, `Restore points changed since your review (${expected} layers then, ${plan.target.size} now), so nothing was changed. Here's a fresh review.`);

  scanSeq++;
  running(true, "Restoring");
  const when = new Date(plan.point.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // Going back is a restore point too, so it can itself be undone.
  const run = newRun(`Go back to before “${plan.point.label}” (${when})`);
  run.versionSaved = await saveVersion(run.label);
  let restored = 0, stopped = false;
  const failed = [];
  const items = [...plan.target.values()];
  try {
    for (const [i, { node: n, data }] of items.entries()) {
      await pause(`Restoring ${i + 1} of ${items.length.toLocaleString()} — ${where(n)} › ${safeName(n)}`);
      if (stopRequested) { stopped = true; break; }
      if (gone(n)) { failed.push({ where: safeId(n), error: "layer no longer exists" }); continue; }
      try {
        protect(run, n);
      } catch (e) {
        failed.push({ where: fullWhere(n), error: "left unchanged — couldn't back up its current animation first" });
        continue;
      }
      try {
        clearAnimation(n);
        for (const st of data.styles) {
          const resolved = resolveStyleId(st);
          if (!resolved) throw new Error(`“${st.name}” is a built-in preset a plugin can't re-apply — add it back by hand`);
          n.applyAnimationStyle(resolved, styleConfig(st));
        }
        for (const t of data.tracks) n.applyManualKeyframeTrack(t.field, { baseValue: t.baseValue, keyframes: t.keyframes });
        restored++;
      } catch (e) {
        // Layers inside components take their animation from the main
        // component, so a plugin can't (and needn't) put anything back there.
        const inside = !gone(n) && !!outerInstance(n);
        failed.push({ id: safeId(n), where: fullWhere(n),
          error: inside ? "inside a component — its animation comes from the main component, nothing to restore" : String((e && e.message) || e) });
      }
    }
  } finally {
    saveRun(run);
    figma.commitUndo();
    running(false);
  }
  post({ type: "restored", label: plan.point.label, restored, failed, stopped, versionSaved: run.versionSaved });
  runScan();
}

async function showPoint(id) {
  const p = listPoints().find(x => x.id === id);
  if (!p) return;
  const nodes = nodesOf(p).filter(n => !gone(n));
  if (!nodes.length) return post({ type: "crash", text: "None of the layers from that restore point exist any more." });
  selectQuietly(nodes);
}

function deletePoint(id) {
  const p = listPoints().find(x => x.id === id);
  if (!p) return;
  dropBackups(p);
  writeIndex(readIndex().filter(x => x.id !== id));
  postHistory();
}

/* -------------------------------------------------------------- stop ---- */
let stopRequested = false;
function running(on, label) {
  if (on) stopRequested = false;
  post({ type: "running", on, label });
}

/* -------------------------------------------------------------- apply ---- */
// What Figma knows about a layer that refused animation — enough to tell a
// component, a missing timeline or leftover animation apart.
function diagnose(t, before) {
  let top = t;
  while (top.parent && top.parent.type !== "PAGE" && top.parent.type !== "SECTION") top = top.parent;
  const inComponent = [];
  for (let p = t.parent; p && p.type !== "PAGE"; p = p.parent)
    if (p.type === "COMPONENT" || p.type === "COMPONENT_SET" || p.type === "INSTANCE") inComponent.push(`${p.type.toLowerCase().replace("_", " ")} “${p.name}”`);
  let tl = "unknown";
  try { tl = t.timelines.length ? t.timelines.map(x => secs(x.duration)).join(", ") : "none"; } catch (e) { /* leave unknown */ }
  return [
    `${t.type.toLowerCase()}${t.locked ? ", locked" : ""}${t.visible === false ? ", hidden" : ""}`,
    `top-level frame: ${top.type.toLowerCase()} “${top.name}”`,
    `timeline: ${tl}`,
    inComponent.length ? `inside ${inComponent.join(", ")}` : "",
    `animation before: ${before.length ? before.join(", ") : "none"}`
  ].filter(Boolean).join(" · ");
}

async function apply(targets, label) {
  scanSeq++;   // stop any scan still running; this run owns the thread now
  running(true, "Copying");
  const run = newRun(label || "Copy animation");
  const versionSaved = run.versionSaved = await saveVersion(run.label);
  let done = 0, stopped = false;
  const failed = [], timelines = new Map();
  const total = Object.keys(targets).reduce((n, k) => n + targets[k].length, 0);

  try {
    sources:
    for (const sid of Object.keys(targets)) {
      const src = await figma.getNodeByIdAsync(sid);
      if (!src) continue;
      const styles = src.animationStyles.map(a => Object.assign({}, a, { resolved: resolveStyleId(a) }));
      const stuck = styles.filter(a => !a.resolved);
      if (stuck.length) {
        failed.push({ where: src.name, error: `skipped — “${stuck[0].name}” is a built-in preset a plugin can't re-apply`, count: targets[sid].length });
        continue;
      }
      const tracks = manualFields(src);
      const need = src.timelines.length ? src.timelines[0].duration : 0;

      for (const tid of targets[sid]) {
        await pause(`Copying ${done + failed.length + 1} of ${total.toLocaleString()}`);
        if (stopRequested) { stopped = true; break sources; }
        const t = await figma.getNodeByIdAsync(tid);
        if (gone(t)) { failed.push({ where: tid, error: "layer no longer exists" }); continue; }
        await pause(`Copying ${done + failed.length + 1} of ${total.toLocaleString()} — ${where(t)} › ${t.name}`);
        const before = t.animationStyles.map(a => a.type === "CUSTOM" ? `${a.name} (saved style)` : styleName(a));
        try {
          protect(run, t);
        } catch (e) {
          failed.push({ id: t.id, where: fullWhere(t), error: "left unchanged — couldn't back up its current animation first", detail: String((e && e.message) || e) });
          continue;
        }
        try {
          // Replace, don't stack: clear whatever is already there first.
          clearAnimation(t);
          for (const s of styles) t.applyAnimationStyle(s.resolved, styleConfig(s));
          for (const m of tracks) {
            t.applyManualKeyframeTrack(m.field, {
              baseValue: m.binding.baseValue,
              keyframes: m.binding.keyframes.map(k => ({ timelinePosition: k.timelinePosition, easing: k.easing, value: k.value }))
            });
          }
          // The target's timeline has to be at least as long as the hero's, or
          // the copied animation gets cut off.
          for (const tl of t.timelines) {
            const cur = timelines.get(tl.id);
            if (!cur || cur.need < need) timelines.set(tl.id, { node: t, need, duration: tl.duration });
          }
          done++;
        } catch (e) {
          let detail = "";
          try { detail = diagnose(t, before); } catch (d) { /* the error itself is still reported */ }
          failed.push({ id: safeId(t), where: fullWhere(t), error: gone(t) ? "layer was rebuilt by Figma part-way — run again" : String((e && e.message) || e), detail });
        }
      }
    }

    say("Lengthening timelines to fit…");
    var extended = 0;
    for (const [id, tl] of timelines) {
      if (tl.need > tl.duration) {
        try { tl.node.setTimelineDuration(id, tl.need); extended++; } catch (e) { /* reported via the count */ }
      }
    }
  } finally {
    saveRun(run);
    figma.commitUndo();
    running(false);
  }

  post({ type: "done", done, failed, extended, stopped, total, versionSaved });
  runScan();
}

/* -------------------------------------------------------------- clear ---- */
// Strips animation from everything on the page except the selection, so a
// messy run can be reset. Refuses with nothing selected: "everything except
// nothing" is the whole page, which is never what a reset means.
// Before removing anything, show what the selection keeps and what goes.
async function reviewClear(note) {
  const sel = figma.currentPage.selection;
  if (!sel.length) return post({ type: "cleared", cleared: 0, failed: [], refused: true });
  // Read-only, so a scan still running can carry on alongside it.
  running(true, "Reviewing");
  try {
    say("Reading the animation you're keeping…");
    const keep = [], seen = new Set();
    for (const s of sel) {
      for (const n of [s].concat("findAll" in s ? s.findAll(hasMotion) : [])) {
        if (seen.has(n.id) || !hasMotion(n)) continue;
        seen.add(n.id);
        keep.push({ id: n.id, name: n.name, where: where(n), lines: describe(n).lines });
      }
    }
    const list = await animatedOutside(sel, null);
    // Group what goes by top-level frame and by layer name, so the scale and
    // spread of the removal are visible at a glance.
    const groups = new Map(), names = new Map();
    for (const n of list) {
      let top = n;
      while (top.parent && top.parent.type !== "PAGE" && top.parent.type !== "SECTION") top = top.parent;
      const sec = top.parent && top.parent.type === "SECTION" ? `${top.parent.name} › ` : "";
      const g = groups.get(top.id) || { id: top.id, name: sec + top.name, count: 0 };
      g.count++;
      groups.set(top.id, g);
      names.set(n.name, (names.get(n.name) || 0) + 1);
    }
    post({ type: "others", count: list.length, selected: sel.length });
    post({ type: "clearReview", note: note || "", inherited: list.inherited || 0, signature: signatureOf(list),
      selection: sel.map(n => n.name),
      keep,
      removeCount: list.length,
      groups: [...groups.values()].sort((a, b) => b.count - a.count),
      names: [...names.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) });
  } finally {
    running(false);
    say("");
  }
}

// A short fingerprint of exactly which layers a removal covers.
function signatureOf(list) {
  let h = 2166136261;
  for (const id of list.map(n => n.id).sort()) for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${list.length}:${(h >>> 0).toString(36)}`;
}

// `signature` identifies the exact layers the person reviewed. If they differ
// now, nothing is removed and a fresh review is shown instead.
async function clearOthers(signature) {
  const sel = figma.currentPage.selection;
  if (!sel.length) return post({ type: "cleared", cleared: 0, failed: [], refused: true });
  if (signature != null) {
    const now = await animatedOutside(sel, null);
    if (signatureOf(now) !== signature)
      return reviewClear(`The animated layers changed since your review (now ${now.length}), so nothing was removed. Here's a fresh review.`);
  }
  scanSeq++;
  running(true, "Removing");
  const run = newRun("Remove animation from others");
  const versionSaved = run.versionSaved = await saveVersion(run.label);
  let cleared = 0, stopped = false, vanished = 0;
  const failed = [];
  try {
    const list = await animatedOutside(sel, null);
    for (const n of list) {
      await pause(`Removing animation ${cleared + failed.length + vanished + 1} of ${list.length.toLocaleString()} — ${where(n)} › ${safeName(n)}`);
      if (stopRequested) { stopped = true; break; }
      if (gone(n)) { vanished++; continue; }
      try {
        protect(run, n);
      } catch (e) {
        if (gone(n)) { vanished++; continue; }
        failed.push({ where: fullWhere(n), error: "left unchanged — couldn't back up its animation first" });
        continue;
      }
      try {
        clearAnimation(n);
        cleared++;
      } catch (e) {
        if (gone(n)) { vanished++; continue; }
        failed.push({ where: fullWhere(n), error: String((e && e.message) || e) });
      }
    }
  } finally {
    saveRun(run);
    figma.commitUndo();
    running(false);
  }
  post({ type: "cleared", cleared, failed, stopped, vanished, versionSaved });
  runScan();
}


/* -------------------------------------------------------------- export ---- */
// Figma won't give a plugin its animated SVG (the export option isn't in the
// plugin API — tested). So the plugin exports the static SVG and sends each
// animated layer's keyframes alongside; the panel writes the CSS animation
// itself, the way Figma's own animated export does, then runs the web tool's
// checks and packaging on the result.

// A board holds banners rather than being one: a section, or a frame far
// larger than any display ad (the "Version A" sheets in a suite file).
const isBoard = n => n.type === "SECTION" || ("width" in n && (n.width > 2000 || n.height > 2000));
const animatedInside = n => hasMotion(n) || ("findOne" in n && !!n.findOne(hasMotion));

// Selected frames are banners. A selected board stands for every animated
// frame directly inside it, looking through nested boards.
function bannersIn(sel) {
  const out = [], seen = new Set();
  const add = n => { if (!seen.has(n.id)) { seen.add(n.id); out.push(n); } };
  const walk = n => {
    if (isBoard(n) && "children" in n) {
      for (const c of n.children) {
        if (isBoard(c)) walk(c);
        else if ((c.type === "FRAME" || c.type === "COMPONENT" || c.type === "INSTANCE") && animatedInside(c)) add(c);
      }
    } else if ("findAll" in n) add(n);
  };
  sel.forEach(walk);
  return out;
}

async function scanExport(seq, sel) {
  say("Finding banners to export…");
  const banners = bannersIn(sel);
  if (!banners.length)
    return post({ type: "plan", mode, error: "Nothing selected has animation to export. Select animated banners, or a Version frame or section that holds them." });
  const list = [];
  for (const [i, b] of banners.entries()) {
    if (i % 10 === 0) { await pause(`Reading banner ${i + 1} of ${banners.length}`); if (stale(seq)) return; }
    list.push({ id: b.id, name: b.name, where: where(b), w: Math.round(b.width), h: Math.round(b.height),
                animated: (hasMotion(b) ? 1 : 0) + b.findAll(hasMotion).length });
  }
  if (stale(seq)) return;
  post({ type: "plan", mode, banners: list });
}

// Easing can be a motion variable; the panel can't read variables, so resolve
// each one to the curve it stands for, for this layer.
async function resolveEasings(value, node) {
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = await resolveEasings(value[i], node); return value; }
  if (!value || typeof value !== "object") return value;
  if (value.type === "VARIABLE_ALIAS") {
    try {
      const v = await figma.variables.getVariableByIdAsync(value.id);
      const r = v && v.resolveForConsumer(node);
      return r ? r.value : { type: "UNRESOLVED", id: value.id };
    } catch (e) {
      return { type: "UNRESOLVED", id: value.id };
    }
  }
  for (const k of Object.keys(value)) value[k] = await resolveEasings(value[k], node);
  return value;
}

// The same layer in two copies of one tree, walked side by side.
function mirror(a, b, map) {
  map.set(a.id, b);
  const ac = "children" in a ? a.children : [], bc = "children" in b ? b.children : [];
  for (let i = 0; i < ac.length && i < bc.length; i++) mirror(ac[i], bc[i], map);
  return map;
}

// Merge keyframe tracks property by property (fills/strokes/effects are
// left as they are — those aren't converted anyway).
function mergeAnimations(into, from) {
  for (const k of Object.keys(from || {})) {
    const f = from[k];
    if (!f || !Array.isArray(f.tracks)) { if (!(k in into)) into[k] = f; continue; }
    if (into[k] && Array.isArray(into[k].tracks)) into[k].tracks = into[k].tracks.concat(f.tracks);
    else into[k] = f;
  }
  return into;
}

// Export one banner without touching it. Two things Figma does get in the way
// of exporting the original:
//  - the SVG shows the banner at the current point in its animation, so
//    layers that fade in are missing entirely at the start;
//  - layers using a saved animation style report no keyframes.
// So the plugin exports a temporary copy, placed on its own at the top of the
// page (never beside the banner, where an auto-layout parent would reflow):
// components on the copy are detached so inherited animation can be cleared
// too, every animation is cleared so it exports at rest (the designed layout),
// and the animated layers are tagged so they can be found in the SVG. The
// motion itself is read from the original's preset settings. The copy is
// deleted afterwards. Always answers with an "exported" message — the panel
// waits for one.
async function exportBanner(id, fixSize) {
  const skip = figma.skipInvisibleInstanceChildren;
  let copy = null;
  try {
    const b = await figma.getNodeByIdAsync(id);
    if (gone(b)) return post({ type: "exported", id, error: "That banner no longer exists." });
    say(`Exporting ${where(b)} › ${b.name}…`);
    // Hidden layers inside components must be walked too, so the original and
    // its detached copy line up layer for layer.
    figma.skipInvisibleInstanceChildren = false;
    // Hidden layers aren't in the export, so animating them is meaningless —
    // visibility worked out downward, as everywhere else.
    const shownIn = mapBanner(b);
    const animated = (hasMotion(b) ? [b] : []).concat(b.findAll(hasMotion).filter(n => (shownIn.byId.get(n.id) || {}).shown));
    const notes = [];

    copy = b.clone();
    figma.currentPage.appendChild(copy);
    // Detach every component on the copy (outermost first, repeatedly, since
    // detaching exposes nested ones) so inherited animation can be cleared.
    for (let guard = 0; guard < 2000; guard++) {
      const inst = copy.type === "INSTANCE" ? copy : copy.findOne(n => n.type === "INSTANCE");
      if (!inst) break;
      let f;
      try { f = inst.detachInstance(); } catch (e) { notes.push(`A component couldn't be detached on the export copy (${(e && e.message) || e}); its own animation may be missing.`); break; }
      if (inst === copy) copy = f;
    }
    const twin = mirror(b, copy, new Map());

    // Size fixes, on the copy only — the frame in Figma is never changed.
    //  - Anything past the frame's edge can't be seen in the ad slot, but it
    //    makes Figma's export bigger than the frame. Clip it.
    //  - A frame named for one size but a pixel or two off is almost always a
    //    slip; export it at the named size. A bigger gap may be deliberate, so
    //    that only happens when the person asks (fixSize).
    const fixes = [];
    if ("clipsContent" in copy && !copy.clipsContent) {
      copy.clipsContent = true;
      fixes.push("Clip content was off, so anything past the frame's edge was trimmed for the export.");
    }
    if (Array.isArray(copy.effects) && copy.effects.some(e => e.type === "DROP_SHADOW" && e.visible !== false)) {
      copy.effects = copy.effects.filter(e => e.type !== "DROP_SHADOW");
      fixes.push("The frame's own drop shadow falls outside the ad, so it was left out of the export.");
    }
    const named = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(b.name).trim());
    const frameW = Math.round(b.width), frameH = Math.round(b.height);
    if (named && (+named[1] !== frameW || +named[2] !== frameH)) {
      const nw = +named[1], nh = +named[2];
      if (fixSize || (Math.abs(nw - frameW) <= 2 && Math.abs(nh - frameH) <= 2)) {
        copy.resize(nw, nh);
        fixes.push(`The frame is ${frameW}×${frameH} but named ${nw}×${nh}, so it was exported at ${nw}×${nh}. Resize the frame in Figma to match.`);
      }
    }

    // 1. At rest: no animation anywhere on the copy, so the export is the layout.
    for (const n of [copy].concat(copy.findAll(hasMotion))) {
      try { clearAnimation(n); } catch (e) { /* reported if it shows up as a missing layer */ }
    }

    // 2. Tag the animated layers on the copy, then export it.
    const tagged = [];
    animated.forEach((o, i) => {
      const c = twin.get(o.id);
      if (!c) { notes.push(`${safeName(o)}: couldn't be matched in the export copy, so it won't move.`); return; }
      const token = `cm${i}z`;
      try { c.name = token; tagged.push({ o, c, token }); }
      catch (e) { notes.push(`${safeName(o)}: couldn't be tagged for export (${(e && e.message) || e}), so it won't move.`); }
    });
    say(`Exporting ${where(b)} › ${b.name} from Figma…`);
    const svg = await copy.exportAsync({ format: "SVG_STRING", svgOutlineText: true, svgIdAttribute: true });

    // Figma sizes the SVG to what the frame renders — content hanging over the
    // edge of a non-clipping frame, or a shadow, makes it larger. Pivots are
    // measured from the SVG's own corner, and a size change is reported.
    const frameBox = copy.absoluteBoundingBox;
    const svgBox = copy.absoluteRenderBounds || frameBox;
    // (A size difference is checked, and blocks, in the panel.)

    // 3. Motion. Figma doesn't report keyframes for saved styles, and works
    //    out a preset's keyframes too late for a plugin to read. But every
    //    preset's settings are readable — direction, distance, amount,
    //    duration, easing — so those are sent and turned into motion in the
    //    panel. Only hand-placed keyframes (not from any preset) are read
    //    as keyframes.
    // A preset's start: Figma keeps it both as the timeline offset and as the
    // "delay" setting (the two match on applied presets), so whichever is set.
    const startOf = (offset, props) => Math.max(offset || 0, Number(props && props.delay) || 0);
    const anims = [];
    for (const { o, c, token } of tagged) {
      const presets = [], trace = { styles: [] };
      for (const st of o.animationStyles) {
        trace.styles.push({ type: st.type, name: st.name, timelineOffset: st.timelineOffset, duration: st.duration, props: st.props });
        if (st.type !== "CUSTOM") {
          presets.push({ preset: presetKey(st.name), name: st.name, from: "", start: startOf(st.timelineOffset, st.props), duration: st.duration, props: st.props || {} });
          continue;
        }
        let style = null;
        try { style = await figma.getStyleByIdAsync(st.styleId); } catch (e) { /* reported below */ }
        if (!style || !style.animationEntries) { notes.push(`${o.name}: its animation style “${st.name}” couldn't be read, so it won't move.`); continue; }
        for (const entry of style.animationEntries) {
          presets.push({ preset: presetKey(entry.name), name: entry.name, from: st.name,
            start: (st.timelineOffset || 0) + startOf(entry.timelineOffset, entry.props), duration: entry.duration, props: entry.props || {} });
        }
      }
      // Hand-placed keyframes: tracks that don't belong to any preset.
      let manual = {};
      try {
        const all = JSON.parse(JSON.stringify(o.animations || {}));
        for (const k of Object.keys(all)) {
          const b2 = all[k];
          if (!b2 || !Array.isArray(b2.tracks)) continue;
          const own = b2.tracks.filter(t => !t.animationPreset);
          if (own.length) manual[k] = Object.assign({}, b2, { tracks: own });
        }
      } catch (e) { /* none */ }
      for (const pr of presets) pr.props = await resolveEasings(pr.props, o);
      manual = await resolveEasings(manual, o);
      const box = c.absoluteBoundingBox;
      anims.push({ token, name: o.name, type: o.type, opacity: "opacity" in c ? c.opacity : 1, isBanner: o.id === b.id,
        // Figma scales and rotates a layer about its centre — taken at rest,
        // measured from the SVG's corner.
        center: box && svgBox ? { x: box.x - svgBox.x + box.width / 2, y: box.y - svgBox.y + box.height / 2 } : null,
        presets, animations: manual, trace });
    }

    // The banner's top headline, so files and the report say which message
    // each banner carries — version frames often share a name.
    let headline = "";
    try {
      const texts = b.findAll(n => n.type === "TEXT" && n.visible !== false && norm(n.characters).split(" ").length >= 3);
      texts.sort((x, y) => ((x.absoluteBoundingBox || {}).y || 0) - ((y.absoluteBoundingBox || {}).y || 0));
      if (texts[0]) headline = norm(texts[0].characters);
    } catch (e) { /* optional */ }

    let offered = [];
    try { offered = figma.motion.figmaAnimationStyles().map(a => ({ name: a.name, styleId: a.styleId, props: a.props })); } catch (e) { /* none */ }
    say("");
    post({ type: "exported", id, name: b.name, where: where(b), full: fullWhere(b), parent: b.parent ? safeName(b.parent) : "",
           width: Math.round(copy.width), height: Math.round(copy.height), frameW, frameH, fixes,
           headline, svg, anims, skipped: notes, offered });
  } catch (e) {
    post({ type: "exported", id, error: `Figma couldn't export it: ${(e && e.message) || e}` });
  } finally {
    if (copy) { try { copy.remove(); } catch (e) { /* already gone */ } }
    figma.skipInvisibleInstanceChildren = skip;
    figma.commitUndo();
  }
}

/* --------------------------------------------------------------- wire ---- */
function applySuite(steps) {
  if (!suitePlan || suitePlan.seq !== scanSeq) {
    post({ type: "crash", text: "The page changed since the preview was made, so it has been refreshed. Check it and copy again." });
    return runScan();
  }
  const targets = {};
  for (const s of steps)
    for (const [src, ids] of suitePlan.steps[s] || [])
      targets[src] = (targets[src] || []).concat(ids);
  return apply(targets, "Whole suite");
}

// Clicking down to a banner passes through several selections in a row. Stop
// whatever scan is running straight away, but only start a new one once the
// selection has settled.
let settle = null, quietUntil = 0;
// Selecting layers for the person to look at (Select, Show layers) mustn't
// re-plan from them: that replaced the list they were working from.
function selectQuietly(nodes) {
  quietUntil = Date.now() + 1000;
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
}
figma.on("selectionchange", () => {
  if (Date.now() < quietUntil) { quietUntil = 0; return; }
  scanSeq++;
  clearTimeout(settle);
  say("Selection changed…");
  settle = setTimeout(runScan, 300);
});
// Another page has its own banners and its own restore points.
figma.on("currentpagechange", () => {
  scanSeq++;
  clearTimeout(settle);
  postHistory();
  settle = setTimeout(runScan, 300);
});
// Any job that throws reports it in the panel instead of leaving the status
// line frozen on its last step.
function guard(job, label) {
  return (...args) => job(...args).catch(e => {
    say("");
    running(false);
    post({ type: "crash", text: `${label} stopped: ${(e && e.message) || e}`,
           detail: String((e && e.stack) || "").split("\n").slice(0, 4).join("\n") });
  });
}
const runScan = guard(scan, "Scanning");
const runApply = guard(apply, "Copying");
const runSuite = guard(applySuite, "Copying");
const runClear = guard(clearOthers, "Removing");
const runReview = guard(reviewClear, "Reviewing");
const runGoBack = guard(goBack, "Restoring");
const runShowPoint = guard(showPoint, "Showing");
const runSelect = guard(async ids => {
  const nodes = [];
  for (const id of ids) { const n = await figma.getNodeByIdAsync(id); if (!gone(n)) nodes.push(n); }
  if (!nodes.length) return;
  selectQuietly(nodes);
}, "Selecting");

figma.ui.onmessage = msg => {
  if (msg.type === "scan") runScan();
  if (msg.type === "mode") { mode = msg.mode; runScan(); }
  if (msg.type === "apply") runApply(msg.targets);
  if (msg.type === "applySuite") runSuite(msg.steps);
  if (msg.type === "reviewClear") runReview();
  if (msg.type === "clear") runClear(msg.signature);
  if (msg.type === "history") postHistory();
  if (msg.type === "reviewGoBack") reviewGoBack(msg.id);
  if (msg.type === "goBack") runGoBack(msg.id, msg.expected);
  if (msg.type === "showPoint") runShowPoint(msg.id);
  if (msg.type === "exportBanner") guard(exportBanner, "Exporting")(msg.id, !!msg.fixSize);
  if (msg.type === "select") runSelect(msg.ids);
  if (msg.type === "deletePoint") deletePoint(msg.id);
  if (msg.type === "stop") stopRequested = true;
  // The gallery wants a bigger window; the panel asks, the plugin resizes.
  if (msg.type === "resize") figma.ui.resize(Math.round(msg.w), Math.round(msg.h));
  if (msg.type === "ready") postHistory();
  if (msg.type === "focus") {
    figma.getNodeByIdAsync(msg.id).then(n => { if (n) figma.viewport.scrollAndZoomIntoView([n]); });
  }
};
postHistory();
runScan();
