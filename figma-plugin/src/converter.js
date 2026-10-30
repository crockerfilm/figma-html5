// The converter: checks, fixes and packages one banner — the plugin's engine.
// build.mjs inlines this file into the plugin's panel (figma-plugin/ui.html),
// wrapped so its names can't collide with the panel's own. No page code here.
/* ============================================================================
 * SPEC
 * Google's rules for HTML5 display, which programmatic (DV360,
 * trafficked through CM360) and direct buys both follow:
 *   · zip + backup JPG under 200 KB together (client spec sheet), with the
 *     backup under 50 KB, so the zip stays under 150,000 bytes. That is also
 *     Google Ad Manager's 150K initial-load limit.
 *   · animation stops within 15 s. DV360 rejects "Creative animates longer
 *     than 30 seconds", so a banner can't loop forever, and the IAB guideline
 *     DV360 points to (which direct publishers enforce) is 15 s: 2 plays of a
 *     3 s timeline with an 8 s hold and a 1 s fade is exactly 15 s.
 *   · text outlined · no external calls · flat package · ad.size meta · IAB
 *     clickTag · explicit end tags in the inline SVG (Google Ads rejects
 *     <path/>).
 * The 15 s limit on one play is a guard, not something the client sets.
 * Change these numbers if a placement is briefed differently — nothing else
 * in this file needs to change.
 * ========================================================================== */
const SPEC = {
  maxZipKB: 146,               // 146 × 1024 < 150,000 bytes: zip + 50 KB backup under 200 KB
  maxAnimationSeconds: 15,     // one play of the timeline
  maxTotalSeconds: 15,         // across all plays (Infinity: no limit)
  maxLoops: Infinity,          // plays (Infinity: no cap)
  holdOnLastFrame: true,       // true: the animation must stop, not loop forever
  requireOutlinedText: true,   // no font dependency at render time
  allowExternalRefs: false,    // creative must be self-contained
  jpegQuality: 0.8,
  jpegQualityFloor: 0.72,      // tried when 0.8 would shrink a photo below the size it's drawn at
  maxBackupBytes: 49000,       // the backup JPG beside each zip: under 50 KB, and zip + backup under 200 KB

  // Only formats the spec lists. An image's own pixels decide which it gets:
  // anything using alpha must keep it, everything else takes the smaller one.
  formatOpaque: "image/jpeg",
  formatAlpha: "image/png",

  // Resolution ladder, as fractions of the size each image is actually drawn at
  // on the canvas. Rung 0 is 2× — sharp on Retina screens, where 1× looked fuzzy
  // to the client — and nothing is ever upscaled past its source. Being relative
  // to the image rather than the canvas means a small decorative element is never
  // encoded at hero resolution, and a hero is never starved to pay for one. Each
  // image picks its own rung against measured encoded bytes — no assumptions
  // about what any image contains.
  ladder: [2, 1.5, 1, 0.8, 0.65, 0.5, 0.4, 0.32, 0.25, 0.2, 0.15, 0.1]
};

// Split an animation shorthand on the commas between animations — not the
// ones inside cubic-bezier(…) or steps(…), which once misread durations.
function splitAnimationsRaw(value) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const splitAnimations = value => splitAnimationsRaw(value).map(seg => seg.replace(/\([^)]*\)/g, " "));   // drop function arguments
const kb = n => (n / 1024).toFixed(1) + " KB";
const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(2) + " MB" : kb(n);
const XLINK = "http://www.w3.org/1999/xlink";

let built = null;

/* ---------------------------------------------------------------- zip ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function deflateRaw(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const def = await deflateRaw(f.data);
    const useDef = def.length < f.data.length;
    const body = useDef ? def : f.data;
    const lh = new Uint8Array(30), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, useDef ? 8 : 0, true); lv.setUint16(12, 0x2821, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true);
    lv.setUint32(22, f.data.length, true); lv.setUint16(26, name.length, true);
    parts.push(lh, name, body);
    const ch = new Uint8Array(46), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, useDef ? 8 : 0, true); cv.setUint16(14, 0x2821, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true);
    cv.setUint32(24, f.data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cSize = central.reduce((n, p) => n + p.length, 0);
  const e = new Uint8Array(22), ev = new DataView(e.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true); ev.setUint32(12, cSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e], { type: "application/zip" });
}

/* ------------------------------------------------------------- matrix ---- */
const IDENTITY = [1, 0, 0, 1, 0, 0];
function matMul(m, n) {
  return [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3],
          m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
}
function matInvert(m) {
  const d = m[0]*m[3] - m[1]*m[2];
  if (!d) return IDENTITY.slice();
  return [m[3]/d, -m[1]/d, -m[2]/d, m[0]/d,
          (m[2]*m[5]-m[3]*m[4])/d, (m[1]*m[4]-m[0]*m[5])/d];
}
function parseTransform(str) {
  let m = IDENTITY.slice();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str))) {
    const v = t[2].split(/[\s,]+/).filter(x => x !== "").map(Number);
    let n;
    switch (t[1]) {
      case "matrix": n = v.length === 6 ? v : IDENTITY.slice(); break;
      case "translate": n = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case "scale": n = [v[0] ?? 1, 0, 0, v.length > 1 ? v[1] : (v[0] ?? 1), 0, 0]; break;
      case "rotate": {
        const a = (v[0] || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const r = [c, s, -s, c, 0, 0];
        n = v.length >= 3 ? matMul([1,0,0,1,v[1],v[2]], matMul(r, [1,0,0,1,-v[1],-v[2]])) : r;
        break;
      }
      case "skewX": n = [1, 0, Math.tan((v[0]||0)*Math.PI/180), 1, 0, 0]; break;
      case "skewY": n = [1, Math.tan((v[0]||0)*Math.PI/180), 0, 1, 0, 0]; break;
      default: n = IDENTITY.slice();
    }
    m = matMul(m, n);
  }
  return m;
}

/* -------------------------------------------------------------- images --- */
function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("could not decode an embedded image"));
    i.src = src;
  });
}
const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

function drawTo(img, w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const x = c.getContext("2d", { willReadFrequently: true });
  x.imageSmoothingQuality = "high";   // big reductions alias at the default
  x.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// An image that uses its alpha channel cannot become JPEG without going black,
// so format is decided by the pixels, not by assumption.
function usesAlpha(img) {
  const probe = Math.min(1200, Math.max(img.naturalWidth, img.naturalHeight));
  const s = probe / Math.max(img.naturalWidth, img.naturalHeight);
  const c = drawTo(img, img.naturalWidth * s, img.naturalHeight * s);
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/* ------------------------------------------------------------- inspect --- */
function inspect(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("svg"))
    throw new Error("That file isn't valid SVG.");
  const svg = doc.querySelector("svg");

  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const width = parseFloat(svg.getAttribute("width")) || (vb.length === 4 ? vb[2] : 0);
  const height = parseFloat(svg.getAttribute("height")) || (vb.length === 4 ? vb[3] : 0);
  // How many screen pixels one user unit covers. A viewBox far smaller than the
  // pixel size magnifies every coordinate, so rounding has to follow it.
  const viewBoxScale = (vb.length === 4 && vb[2] > 0 && width) ? width / vb[2] : 1;

  // Animations can live in a <style> block or in an inline style attribute, and
  // missing the inline ones means reporting an ad as finite while it loops forever.
  const styleEls = [...doc.querySelectorAll("style")];
  const inlineAnimated = [...doc.querySelectorAll("[style]")]
    .filter(e => /animation/i.test(e.getAttribute("style") || ""));
  const css = styleEls.map(s => s.textContent).join("\n")
    + "\n" + inlineAnimated.map(e => e.getAttribute("style")).join(";\n");
  const keyframes = (css.match(/@keyframes/g) || []).length;
  const smil = doc.querySelectorAll("animate, animateTransform, animateMotion").length;

  let cycle = 0;
  for (const decl of css.match(/animation\s*:\s*[^;}]+/g) || []) {
    for (const seg of splitAnimations(decl.replace(/animation\s*:\s*/, ""))) {
      const times = seg.trim().split(/\s+/).filter(t => /^-?[\d.]+m?s$/.test(t));
      const sec = t => t.endsWith("ms") ? parseFloat(t) / 1000 : parseFloat(t);
      cycle = Math.max(cycle, (times[0] ? sec(times[0]) : 0) + Math.max(0, times[1] ? sec(times[1]) : 0));
    }
  }

  // Work out how large each image is actually drawn. Figma paints photos through a
  // pattern, so the real size sits on the shape the pattern fills, not on <image>.
  // More pixels than that is waste; fewer makes it visibly soft.
  const images = [];
  for (const el of doc.querySelectorAll("image")) {
    const href = el.getAttribute("href") || el.getAttributeNS(XLINK, "href") || "";
    if (!href.startsWith("data:")) continue;

    let dispW = parseFloat(el.getAttribute("width")) || 0;
    let dispH = parseFloat(el.getAttribute("height")) || 0;
    const iw = dispW, ih = dispH;
    const id = el.getAttribute("id");
    if (id) {
      // Figma uses one <image> for every place a picture appears, each through
      // its own pattern, and a pattern's transform carries any crop or zoom.
      // The largest placement decides how many pixels it needs.
      let best = 0;
      for (const use of doc.querySelectorAll("use")) {
        if ((use.getAttribute("href") || use.getAttributeNS(XLINK, "href")) !== `#${id}`) continue;
        const pattern = use.closest("pattern");
        if (!pattern || !pattern.id) continue;
        const m = parseTransform(use.getAttribute("transform") || "");
        const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
        const box = pattern.getAttribute("patternContentUnits") === "objectBoundingBox";
        const ref = `url(#${pattern.id})`;
        for (const n of doc.querySelectorAll("[fill], [stroke]")) {
          if (n.getAttribute("fill") !== ref && n.getAttribute("stroke") !== ref) continue;
          const W = parseFloat(n.getAttribute("width")) || 0, H = parseFloat(n.getAttribute("height")) || 0;
          if (!W && !H) continue;
          // The picture's own drawn size where it's known; else the shape's.
          const dw = iw && box ? iw * sx * W : iw ? iw * sx : W, dh = ih && box ? ih * sy * H : ih ? ih * sy : H;
          if (Math.max(dw, dh) > best) { best = Math.max(dw, dh); dispW = dw; dispH = dh; }
        }
      }
    }
    images.push({ el, href, dispW, dispH });
  }

  const diamond = [...new Set([...doc.querySelectorAll("[data-figma-skip-parse]")].map(el => {
    let n = el.parentElement;
    while (n && !n.id) n = n.parentElement;
    return n ? n.id : "(unnamed layer)";
  }))];

  return {
    text, doc, svg, width, height, viewBoxScale, css, keyframes, smil, cycle, images, diamond,
    blurs: doc.querySelectorAll("feGaussianBlur").length,
    media: doc.querySelectorAll("audio, video").length,
    infinite: /\binfinite\b/.test(css) || !!doc.querySelector('[repeatCount="indefinite"]'),
    scripts: [...doc.querySelectorAll("script")],
    textNodes: doc.querySelectorAll("text").length,
    fontFace: /@font-face/.test(css),
    foreignObject: doc.querySelectorAll("foreignObject").length,
    externalRefs: [...new Set((text.match(/(?:href|src)\s*=\s*["'](https?:\/\/[^"']+)/g) || [])
      .map(s => s.replace(/^.*["']/, "")))],
    bytes: new TextEncoder().encode(text).length
  };
}

/* ========================================================================== *
 * RULES — each one either passes, applies a deterministic fix, or blocks with
 * the exact change a human has to make. Order matters: blockers that make the
 * file unusable are evaluated before anything is rewritten.
 * ========================================================================== */
const RULES = [

  { id: "dimensions", title: "Canvas has explicit dimensions",
    run(ctx) {
      if (!ctx.width || !ctx.height)
        return block("The SVG has no width/height or viewBox, so the ad size can't be determined.",
                     "Re-export from Figma with the frame selected.");
      return pass(`${ctx.width} × ${ctx.height}`);
    } },

  { id: "animation", title: "Creative is animated",
    run(ctx) {
      if (!ctx.keyframes && !ctx.smil)
        return block("No @keyframes and no SMIL tags — this is a static export.",
                     'In Figma\'s export panel switch from the Static tab to Animated, keep "Ignore overlapping layers" ticked, then export again.');
      return pass(`${ctx.keyframes || ctx.smil} animation definitions, ${ctx.cycle}s cycle`);
    } },

  { id: "duration", title: `One play fits in ${SPEC.maxAnimationSeconds}s`,
    run(ctx) {
      if (ctx.cycle > SPEC.maxAnimationSeconds)
        return block(`A single play runs ${ctx.cycle}s.`,
                     `Shorten the animation in Figma to ${SPEC.maxAnimationSeconds}s or less. This can't be fixed on export without dropping frames.`);
      return pass(ctx.cycle ? `${ctx.cycle}s per play` : "no timed animation");
    } },

  { id: "self-contained", title: "No external references",
    run(ctx) {
      if (!SPEC.allowExternalRefs && ctx.externalRefs.length)
        return block(`Loads ${ctx.externalRefs.length} asset(s) from the internet: ${ctx.externalRefs.slice(0,3).join(", ")}`,
                     "Embed these in Figma before exporting — a creative must not call out to other servers.");
      return pass("fully self-contained");
    } },

  { id: "foreign-object", title: "No <foreignObject>",
    run(ctx) {
      if (ctx.foreignObject)
        return block(`${ctx.foreignObject} <foreignObject> element(s) found.`,
                     "These render inconsistently in ad frames. Rasterise or redraw that layer in Figma.");
      return pass("none");
    } },

  { id: "outlined-text", title: "Text is outlined",
    run(ctx) {
      if (!SPEC.requireOutlinedText) return pass("not required");
      if (ctx.textNodes || ctx.fontFace)
        return block(`${ctx.textNodes} live <text> element(s)${ctx.fontFace ? " and an @font-face rule" : ""}.`,
                     'Tick "Outline text" in Figma\'s export panel and export again, otherwise the ad depends on fonts that may not load.');
      return pass("no font dependency");
    } },

  { id: "scripts", title: "No scripts in the artwork",
    run(ctx) {
      if (!ctx.scripts.length) return pass("none");
      const n = ctx.scripts.length;
      ctx.scripts.forEach(s => s.remove());
      return fixed(`Removed ${n} <script> element(s) from the SVG.`,
                   "Ad platforms reject scripts inside creative artwork. Nothing in a Figma export needs them.");
    } },

  { id: "diamond-gradient", title: "Gradient fills aligned and seam-free",
    run(ctx) {
      const repaired = [], deseamed = [];
      const SEAM_PX = 1.5;   // overlap, in device pixels, between mirrored quadrants

      for (const b of ctx.doc.querySelectorAll("[data-figma-skip-parse]")) {
        let named = b.parentElement;
        while (named && !named.id) named = named.parentElement;
        const name = named ? named.id : "(unnamed layer)";

        // 1. Cancel the ancestor transform Figma failed to apply to the gradient.
        let anc = IDENTITY.slice();
        const chain = [];
        for (let n = b.parentElement; n && n.nodeName.toLowerCase() !== "svg"; n = n.parentElement) chain.unshift(n);
        for (const el of chain) {
          const t = el.getAttribute("transform");
          if (t) anc = matMul(anc, parseTransform(t));
        }
        if (!anc.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9)) {
          const inv = matInvert(anc);
          let touched = false;
          for (const g of b.children) {
            const cur = g.getAttribute && g.getAttribute("transform");
            if (!cur) continue;
            g.setAttribute("transform", "matrix(" + matMul(inv, parseTransform(cur)).map(v => +v.toFixed(5)).join(" ") + ")");
            touched = true;
          }
          if (touched) repaired.push(name);
        }

        // 2. Figma builds the diamond from four rectangles mirrored about x=0 and
        // y=0. They abut exactly, and with antialiasing disabled those shared edges
        // read as a faint cross through the artwork. Grow each rect back across the
        // mirror axes so the quadrants overlap instead of meeting. The gradient is
        // userSpaceOnUse, so changing rect bounds moves no colour — it only extends
        // the painted area, and the overlap sits where both quadrants agree.
        for (const g of b.children) {
          if (!g.getAttribute) continue;
          const m = parseTransform(g.getAttribute("transform") || "");
          const ex = SEAM_PX / (Math.hypot(m[0], m[1]) || 1);
          const ey = SEAM_PX / (Math.hypot(m[2], m[3]) || 1);
          let any = false;
          for (const r of g.querySelectorAll("rect")) {
            const num = a => parseFloat(r.getAttribute(a)) || 0;
            r.setAttribute("x", +(num("x") - ex).toFixed(4));
            r.setAttribute("y", +(num("y") - ey).toFixed(4));
            r.setAttribute("width", +(num("width") + ex).toFixed(4));
            r.setAttribute("height", +(num("height") + ey).toFixed(4));
            r.removeAttribute("shape-rendering");   // let the overlap antialias
            any = true;
          }
          if (any) deseamed.push(name);
        }
      }

      if (!repaired.length && !deseamed.length)
        return pass(ctx.diamond.length ? "already aligned" : "no diamond gradients");

      const layers = [...new Set([...repaired, ...deseamed])];
      return fixed(`Repaired ${layers.length} layer(s): ${layers.join(", ")}.`,
        "Figma leaves these gradients in canvas coordinates while moving the shape into local ones, which slices the artwork, and builds them from four mirrored rectangles whose shared edges show as a faint cross. Both the offset and the seams have been corrected.");
    } },

  { id: "media", title: "No audio or video",
    run(ctx) {
      if (!ctx.media) return pass("none");
      return block(`${ctx.media} <audio> or <video> element(s).`,
        "Display creatives can't carry autoplaying media. Remove them in Figma, or deliver this as a video format instead.");
    } },

  { id: "filter-bounds", title: "Filter regions are valid",
    run(ctx) {
      const repaired = [];
      for (const f of ctx.doc.querySelectorAll("filter")) {
        let touched = false;
        for (const a of ["x", "y", "width", "height"]) {
          const v = f.getAttribute(a);
          if (v !== null && !isFinite(parseFloat(v))) {
            f.setAttribute(a, (a === "x" || a === "y") ? "-10%" : "120%");
            touched = true;
          }
        }
        if (touched) repaired.push(f.getAttribute("id") || "(unnamed)");
      }
      if (!repaired.length) return pass("all valid");
      return fixed(`Repaired ${repaired.length} filter region(s).`,
        'Figma writes x="inf" width="-inf" when it cannot work out a filter\'s bounds. Browsers fall back to the default region so it still renders, but it throws console errors and gives a validator something to object to. Replaced with the standard default.');
    } },

  { id: "render-cost", title: "Render cost",
    run(ctx) {
      // A blur's cost scales with its radius, and animating that radius forces the
      // whole filter to be recomputed every frame — far worse than a static blur.
      let widest = 0;
      for (const b of ctx.doc.querySelectorAll("feGaussianBlur"))
        for (const v of (b.getAttribute("stdDeviation") || "").split(/[\s,;]+/))
          widest = Math.max(widest, parseFloat(v) || 0);
      const animatedBlur = [...ctx.doc.querySelectorAll("animate")]
        .some(a => /stdDeviation/i.test(a.getAttribute("attributeName") || ""));

      if (animatedBlur)
        return warn(`A blur radius is animated (up to ${Math.round(widest)}px)`,
          "Animating stdDeviation re-renders the entire blur every frame and is the most expensive thing a display ad can do. In Figma, animate the layer's opacity, position or scale instead of its blur amount, or bake the effect into a short image sequence.");
      if (widest >= 40)
        return warn(`A blur radius of ${Math.round(widest)}px`,
          "Very wide blurs are costly to render on low-end devices. In Figma, flatten this layer into an image rather than leaving a live blur effect on it.");
      if (ctx.blurs <= 8) return pass(`${ctx.blurs} blur filter(s), widest ${Math.round(widest)}px`);
      return warn(`${ctx.blurs} blur filters`,
        "Gaussian blur is recalculated every frame and is a common cause of an ad being pulled for CPU load on low-end devices. In Figma, flatten blurred artwork into an image layer rather than leaving a live blur effect on it.");
    } },

  { id: "loop", title: "Animation stops instead of looping forever",
    run(ctx) {
      if (!ctx.infinite) return pass("already finite");
      if (!SPEC.holdOnLastFrame) return pass("looping allowed");
      // Two limits apply at once: total seconds, and a hard cap on plays.
      const limit = isFinite(SPEC.maxTotalSeconds) ? SPEC.maxTotalSeconds : SPEC.maxAnimationSeconds;
      const loops = ctx.cycle > 0
        ? Math.max(1, Math.min(SPEC.maxLoops, Math.floor(limit / ctx.cycle)))
        : 1;
      ctx.loops = loops;
      // The long form takes a bare count; the shorthand also gets "forwards"
      // so the ad holds its last frame.
      const cap = text => text
        .replace(/(animation-iteration-count\s*:\s*)infinite/g, `$1${loops}`)
        .replace(/\binfinite\b/g, `${loops} forwards`);
      for (const s of ctx.doc.querySelectorAll("style"))
        s.textContent = cap(s.textContent);
      // inline style attributes too, or an ad can ship looping forever while
      // every check reports it as capped
      for (const el of ctx.doc.querySelectorAll("[style]")) {
        const v = el.getAttribute("style") || "";
        if (/animation/i.test(v) && /\binfinite\b/.test(v))
          el.setAttribute("style", cap(v));
      }
      ctx.doc.querySelectorAll('[repeatCount="indefinite"]')
        .forEach(el => el.setAttribute("repeatCount", String(loops)));
      return fixed(`Capped at ${loops} play${loops === 1 ? "" : "s"} (${(loops * ctx.cycle).toFixed(1)}s), holding the last frame.`,
                   "Figma exports a seamless infinite loop. Check the preview ends on your end card — if it ends on frame one, move the end card to the end of the timeline in Figma.");
    } }
];

const pass  = (detail) => ({ status: "pass", detail });
const fixed = (detail, note) => ({ status: "fixed", detail, note });
const block = (detail, todo) => ({ status: "block", detail, todo });
const info  = (detail) => ({ status: "info", detail });
const warn  = (detail, note) => ({ status: "warn", detail, note });

/* ------------------------------------------------------------ looping ---- */
// Plays, and a pause between them, chosen by the person rather than inherited
// from the export. Every animation is moved onto one shared cycle — the whole
// timeline plus the pause — so layers stay in step on every play: each keyframe
// lands where it falls in that cycle, and the first and last frames are held
// before and after it. The last play stops the moment the motion ends (a
// fractional iteration count) and holds the end frame, so the total is
// plays × timeline + (plays − 1) × pause, never an extra trailing pause.
const ANIM_TIMING = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$/;
function parseAnimation(seg) {
  const fnRe = /(cubic-bezier|steps|linear)\([^)]*\)/g;
  const fns = seg.match(fnRe) || [];
  const a = { name: "", times: [], timing: fns[0] || "", count: "1", direction: "normal" };
  for (const t of seg.replace(fnRe, " ").trim().split(/\s+/).filter(Boolean)) {
    if (/^-?[\d.]+m?s$/.test(t)) a.times.push(t.endsWith("ms") ? parseFloat(t) / 1000 : parseFloat(t));
    else if (/^(infinite|\d+(\.\d+)?)$/.test(t)) a.count = t;
    else if (ANIM_TIMING.test(t)) a.timing = t;
    else if (/^(normal|reverse|alternate|alternate-reverse)$/.test(t)) a.direction = t;
    else if (/^(none|forwards|backwards|both|running|paused)$/.test(t)) { /* replaced below */ }
    else a.name = t;
  }
  a.duration = a.times[0] || 0;
  a.delay = Math.max(0, a.times[1] || 0);
  return a;
}

// @keyframes blocks in a stylesheet, with where each sits in the text.
function keyframeBlocks(text) {
  const out = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1, i = re.lastIndex;
    for (; i < text.length && depth; i++) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; }
    const inner = text.slice(re.lastIndex, i - 1);
    const frames = [];
    for (const f of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      for (const sel of f[1].split(",").map(x => x.trim()))
        frames.push({ p: sel === "from" ? 0 : sel === "to" ? 100 : parseFloat(sel), body: f[2] });
    frames.sort((a, b) => a.p - b.p);
    out.push({ name: m[1], start: m.index, end: i, frames });
    re.lastIndex = i;
  }
  return out;
}

// "Fade out before each replay": the outermost animated layers are each wrapped
// in a group that fades to nothing over the last `fade` seconds of every cycle,
// after the end-frame pause, so each replay starts clean. Static layers never
// fade, and nor does an animated layer holding a near-full-size image (a
// background) — its animated layers inside still do.
function fadeBeforeLoop(doc, styles, C, start, count) {
  const svg = doc.documentElement;
  const W = parseFloat(svg.getAttribute("width")) || 0, H = parseFloat(svg.getAttribute("height")) || 0;
  const animated = new Set();
  for (const st of styles)
    for (const m of st.textContent.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|;)\s*animation(-name)?\s*:/.test(m[2])) continue;
      for (const sel of m[1].split(",")) {
        try { doc.querySelectorAll(sel.trim()).forEach(e => animated.add(e)); } catch (e) { /* not a selector (a keyframe step) */ }
      }
    }
  doc.querySelectorAll("[style]").forEach(e => { if (/animation(-name)?\s*:/.test(e.getAttribute("style") || "")) animated.add(e); });
  const holdsImage = id => { const t = id && doc.getElementById(id); return !!t && (t.localName === "image" || !!t.querySelector("image, use")); };
  const big = el => [el, ...el.querySelectorAll("image, rect, use")].some(c => {
    const w = parseFloat(c.getAttribute("width")), h = parseFloat(c.getAttribute("height"));
    if (!(W && H && w >= 0.9 * W && h >= 0.9 * H)) return false;
    if (c.localName === "image") return true;
    const ref = /url\(\s*['"]?#([^'")\s]+)/.exec(c.getAttribute("fill") || c.getAttribute("style") || "");
    return holdsImage(ref && ref[1]) || (c.localName === "use" && holdsImage((c.getAttribute("href") || c.getAttribute("xlink:href") || "").slice(1)));
  });
  const chosen = [];
  for (const el of doc.querySelectorAll("*")) {   // document order: ancestors first
    if (!animated.has(el) || el === svg || el.closest("defs, clipPath, mask, pattern, symbol, marker")) continue;
    if (chosen.some(c => c.contains(el)) || big(el)) continue;
    chosen.push(el);
  }
  const NS = svg.namespaceURI || "http://www.w3.org/2000/svg";
  for (const el of chosen) {
    const g = doc.createElementNS(NS, "g");
    g.setAttribute("class", "cmfade");
    el.parentNode.insertBefore(g, el);
    g.appendChild(el);
  }
  const pct = t => `${+(Math.min(1, Math.max(0, t / C)) * 100).toFixed(3)}%`;
  let st = styles[0];
  if (!st) { st = doc.createElementNS(NS, "style"); svg.insertBefore(st, svg.firstChild); }
  st.textContent += `\n.cmfade{animation:cmfade ${+C.toFixed(4)}s linear 0s ${count} normal both}` +
    `@keyframes cmfade{0%{opacity:1}${pct(start)}{opacity:1}100%{opacity:0}}`;
  return chosen.length;
}

function applyLoop(doc, plays, pause, fade = 0) {
  const styles = [...doc.querySelectorAll("style")];
  const inline = [...doc.querySelectorAll("[style]")].filter(e => /animation\s*:/i.test(e.getAttribute("style") || ""));
  const declRe = /((?:^|[;{\s])animation\s*:\s*)([^;}]+)/g;
  if ([...doc.querySelectorAll("animate, animateTransform, animateMotion, set")].length)
    return { ok: false, reason: "this file animates with SMIL tags, which can't be re-timed" };
  if (styles.some(s => /animation-(name|duration|delay|iteration-count)\s*:/.test(s.textContent)))
    return { ok: false, reason: "its animation is written in long form, which can't be re-timed" };

  const uses = [];
  const collect = text => { for (const m of text.matchAll(declRe)) for (const seg of splitAnimationsRaw(m[2])) { const a = parseAnimation(seg); if (a.name) uses.push(a); } };
  styles.forEach(st => collect(st.textContent));
  inline.forEach(e => collect(e.getAttribute("style")));
  if (!uses.length) return { ok: false, reason: "no CSS animation was found" };
  if (uses.some(a => a.direction !== "normal")) return { ok: false, reason: "some animation plays in reverse or alternates" };

  const blocks = new Map();
  for (const st of styles) for (const b of keyframeBlocks(st.textContent)) if (!blocks.has(b.name)) blocks.set(b.name, b);
  const T = Math.max(...uses.map(a => a.delay + a.duration));
  if (!(T > 0)) return { ok: false, reason: "the animation has no length" };
  // Each cycle: the motion, the end frame held for the pause, then the fade.
  const F = plays > 1 ? Math.max(0, fade) : 0;
  const H = plays > 1 ? Math.max(0, pause) : 0, C = T + H + F;
  // Forever: every play is the whole cycle. Otherwise the last play stops as
  // the motion ends (a fractional count), with no trailing pause or fade.
  const count = plays === Infinity ? "infinite" : plays > 1 ? Math.ceil((plays - (H + F) / C) * 1e4) / 1e4 : 1;
  const pct = t => `${+(Math.min(1, Math.max(0, t / C)) * 100).toFixed(3)}%`;
  const still = body => body.replace(/(-webkit-)?animation-timing-function\s*:[^;}]*;?/g, "");
  const remap = (name, b, delay, dur) => {
    const f = b.frames, out = [];
    if (!f.length) return `@keyframes ${name}{}`;
    if (delay > 0) out.push(`0%{${still(f[0].body)}}`);
    for (const x of f) out.push(`${pct(delay + x.p / 100 * dur)}{${x.body}}`);
    if (delay + dur < C - 1e-6) out.push(`100%{${still(f[f.length - 1].body)}}`);
    return `@keyframes ${name}{${out.join("")}}`;
  };

  // A keyframes block used once is rewritten in place; one shared by several
  // animations with different timings gets a copy per animation.
  const usage = new Map();
  uses.forEach(a => usage.set(a.name, (usage.get(a.name) || 0) + 1));
  const inPlace = new Map(), copies = [];
  let k = 0;
  const rewrite = seg => {
    const a = parseAnimation(seg);
    if (!a.name || !blocks.has(a.name)) return seg;
    let name = a.name;
    if (usage.get(a.name) > 1) { name = `${a.name}-p${k++}`; copies.push(remap(name, blocks.get(a.name), a.delay, a.duration)); }
    else inPlace.set(a.name, remap(name, blocks.get(a.name), a.delay, a.duration));
    return `${name} ${+C.toFixed(4)}s ${a.timing || "ease"} 0s ${count} normal both`;
  };
  const rewriteDecls = text => text.replace(declRe, (m, pre, val) => pre + splitAnimationsRaw(val).map(rewrite).join(","));
  for (const st of styles) st.textContent = rewriteDecls(st.textContent);
  for (const e of inline) e.setAttribute("style", rewriteDecls(e.getAttribute("style")));
  for (const st of styles) {
    let text = st.textContent;
    for (const b of keyframeBlocks(text).reverse())
      if (inPlace.has(b.name)) text = text.slice(0, b.start) + inPlace.get(b.name) + text.slice(b.end);
    st.textContent = text;
  }
  if (copies.length && styles[0]) styles[0].textContent += "\n" + copies.join("\n");
  const faded = F ? fadeBeforeLoop(doc, styles, C, T + H, count) : 0;
  return { ok: true, timeline: T, faded, total: plays === Infinity ? Infinity : plays * T + (plays - 1) * (H + F) };
}

/* ------------------------------------------------------- frame render --- */
// One moment of the banner as pixels. Every animation must run on one clock
// (all start at 0s, as applyLoop leaves them), so pausing them all t seconds in
// freezes exactly that moment. The SVG is drawn as an image, so it needs every
// image inlined as a data: URI.
const cssOf = doc => [...doc.querySelectorAll("style")].map(s => s.textContent)
  .concat([...doc.querySelectorAll("[style]")].map(e => e.getAttribute("style") || "")).join("\n");
// Frames can be frozen only when every animation is a plain "animation:"
// shorthand: long-form properties, the -webkit- prefix and SMIL aren't timed by
// the override in frameCanvas, and long form isn't read by runLength either.
function whyNoFreeze(doc) {
  if (doc.querySelector("animate, animateTransform, animateMotion, set")) return "it animates with SMIL tags";
  const css = cssOf(doc);
  if (/(^|[;{\s])(-webkit-)?animation-(name|duration|delay|iteration-count|direction|fill-mode)\s*:|-webkit-animation\s*:/.test(css))
    return "its animation is written in long form";
  return "";
}
// And to compare frames mid-run, everything must start at 0s on one clock.
function sharesOneClock(doc) {
  if (whyNoFreeze(doc)) return false;
  for (const m of cssOf(doc).matchAll(/(?:^|[;{\s])animation\s*:\s*([^;}]+)/g))
    for (const seg of splitAnimationsRaw(m[1])) if (parseAnimation(seg).times[1]) return false;
  return true;
}
async function frameCanvas(svgText, t, w, h, background) {
  const frozen = svgText.replace(/(<svg\b[^>]*>)/,
    `$1<style>*{animation-play-state:paused!important;animation-delay:${-(+t.toFixed(3))}s!important}</style>`);
  const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(frozen));
  const c = document.createElement("canvas");
  c.width = Math.round(w); c.height = Math.round(h);
  // A default canvas, like the one the signed-off delivery was checked on: a
  // read-optimised one draws edges a hair differently.
  const x = c.getContext("2d");
  if (background) { x.fillStyle = background; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
// How long the animation runs in all, from every animation's delay, duration
// and iteration count; Infinity if anything loops forever.
function runLength(doc) {
  let total = 0;
  for (const m of cssOf(doc).matchAll(/(?:^|[;{\s])animation\s*:\s*([^;}]+)/g))
    for (const seg of splitAnimationsRaw(m[1])) {
      const a = parseAnimation(seg);
      if (!a.name) continue;
      // A 0s animation never moves, however often it repeats (0 × Infinity is NaN).
      const runs = a.count === "infinite" ? Infinity : parseFloat(a.count) || 1;
      total = Math.max(total, a.delay + (a.duration > 0 ? a.duration * runs : 0));
    }
  return total;
}
const framePixels = async (svgText, t, w, h) =>
  (await frameCanvas(svgText, t, w, h)).getContext("2d").getImageData(0, 0, Math.round(w), Math.round(h)).data;
// More than a rounding difference anywhere in the frame.
function framesDiffer(a, b) {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 3) return true;
  return false;
}
// When to look — the moments the delivery the client signed off was checked at:
// every 0.1 s through the motion and half a second into the hold (at most 60
// looks), then every 2 s of the hold, four points through the fade, and the
// frame the ad finally stops on. Later plays repeat the first.
function sampleTimes(timing) {
  const T = timing.timeline || 0, H = timing.hold || 0, F = timing.fade || 0;
  const out = [];
  if (isFinite(timing.total) && timing.total > 0) out.push(timing.total + 0.5);
  const step = Math.max(0.1, (T + 0.5) / 60);
  for (let t = 0; t <= T + 0.5 + 1e-6; t += step) out.push(t);
  for (let t = T + 1; t < T + H - 1e-6; t += 2) out.push(t);
  if (F > 0) for (const f of [0, 0.3, 0.6, 0.9]) out.push(T + H + F * f);
  return [...new Set(out.map(t => +t.toFixed(3)))];
}
// Every keyframe's moment and the midpoints between them, so something on
// screen only briefly (a flash between two regular looks) is still seen.
function keyMoments(doc) {
  const css = cssOf(doc), at = [];
  const blocks = new Map(keyframeBlocks(css).map(b => [b.name, b]));
  for (const m of css.matchAll(/(?:^|[;{\s])animation\s*:\s*([^;}]+)/g))
    for (const seg of splitAnimationsRaw(m[1])) {
      const a = parseAnimation(seg), b = blocks.get(a.name);
      if (b) for (const f of b.frames) at.push(a.delay + f.p / 100 * a.duration);
    }
  let ts = [...new Set(at.map(t => +t.toFixed(3)))].sort((x, y) => x - y);
  ts = ts.concat(ts.slice(1).map((t, i) => +((t + ts[i]) / 2).toFixed(3)));
  // Sampled springs can give hundreds; an even spread of them is enough.
  return ts.length > 120 ? ts.filter((t, i) => i % Math.ceil(ts.length / 120) === 0) : ts;
}
const base64 = u8 => {
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
};

/* ------------------------------------------------------ hidden images ---- */
// Figma frames often carry images nobody sees: copy variants stacked under the
// photo on top, or a photo used only for the outline of a mask. Every image
// costs weight, so these starve the ones that show. Each image is tested by
// rendering the banner through its timeline without it, against small copies
// of every image to keep it quick, and goes only if no frame changes. Removals
// are tried one at a time against the original, so two layers hiding each other
// can't both go.
function editImage(root, i, how) {
  const ims = [...root.querySelectorAll(`image[data-cm-g="${i}"]`)];
  if (!ims.length) return false;
  if (how === "white" && ims.some(im => !im.hasAttribute("width") || !im.hasAttribute("height"))) return false;
  for (const im of ims) {
    if (how === "remove") {
      if (im.id) root.querySelectorAll("use").forEach(u => {
        if ((u.getAttribute("href") || u.getAttributeNS(XLINK, "href")) === `#${im.id}`) u.remove();
      });
      im.remove();
    } else {
      // Only its outline matters (it shapes an alpha mask), and an opaque photo's
      // outline is its box: a white rect of the same size does the same job.
      const r = im.ownerDocument.createElementNS(im.namespaceURI, "rect");
      for (const a of [...im.attributes])
        if (!/^(href|xlink:href|preserveAspectRatio|data-name|data-cm-g)$/.test(a.name)) r.setAttribute(a.name, a.value);
      r.setAttribute("fill", "#fff");
      im.replaceWith(r);
    }
  }
  return true;
}
async function removeHiddenImages(ctx, decoded, times) {
  if (!decoded.length) return { removed: [] };
  const why = whyNoFreeze(ctx.doc);
  if (why) return { removed: [], skipped: `${why}, so frames can't be compared` };
  if (!sharesOneClock(ctx.doc)) return { removed: [], skipped: "its animations don't all start together, so frames can't be compared" };
  if (!(times.length > 1) && ctx.keyframes) return { removed: [], skipped: "the animation's length couldn't be read" };
  const w = ctx.width, h = ctx.height;
  decoded.forEach((d, i) => d.els.forEach(el => el.setAttribute("data-cm-g", i)));
  try {
    const small = decoded.map(d => {
      const s = Math.min(1, 160 / Math.max(d.img.naturalWidth, d.img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(d.img.naturalWidth * s)); c.height = Math.max(1, Math.round(d.img.naturalHeight * s));
      c.getContext("2d").drawImage(d.img, 0, 0, c.width, c.height);
      return c.toDataURL(d.alpha ? "image/png" : "image/jpeg", 0.9);
    });
    const proto = ctx.doc.documentElement.cloneNode(true);
    decoded.forEach((d, i) => proto.querySelectorAll(`image[data-cm-g="${i}"]`).forEach(el => {
      el.setAttribute("href", small[i]);
      if (el.hasAttributeNS(XLINK, "href")) el.setAttributeNS(XLINK, "xlink:href", small[i]);
    }));
    const textWith = edits => {
      const root = proto.cloneNode(true);
      for (const [i, how] of edits) if (!editImage(root, i, how)) return null;
      return new XMLSerializer().serializeToString(root);
    };
    const base = [];
    const s0 = textWith(new Map());
    for (const t of times) base.push(await framePixels(s0, t, w, h));
    // A control: with every image gone the frame must change. If it doesn't,
    // this browser didn't draw the images at all, and every comparison would
    // wrongly call them hidden.
    const none = textWith(new Map(decoded.map((d, i) => [i, "remove"])));
    if (none && !framesDiffer(base[0], await framePixels(none, times[0], w, h)) &&
        !framesDiffer(base[1] || base[0], await framePixels(none, times[1] !== undefined ? times[1] : times[0], w, h)))
      return { removed: [], skipped: "the images didn't draw in this browser's test frames" };
    const same = async edits => {
      const s = textWith(edits);
      if (!s) return false;
      for (let k = 0; k < times.length; k++) if (framesDiffer(base[k], await framePixels(s, times[k], w, h))) return false;
      return true;
    };
    const edits = new Map();
    const order = decoded.map((d, i) => i).sort((a, b) => decoded[b].href.length - decoded[a].href.length);
    for (const i of order)
      for (const how of decoded[i].alpha ? ["remove"] : ["remove", "white"]) {
        const trial = new Map(edits).set(i, how);
        if (await same(trial)) { edits.set(i, how); break; }
      }
    for (const [i, how] of edits) editImage(ctx.doc.documentElement, i, how);
    const removed = [...edits].map(([i, how]) => ({ i, how, bytes: Math.round(decoded[i].href.length * 0.75) }));
    return { removed };
  } catch (e) {
    // Never let the check stop a build: if this browser can't read the frames
    // back, everything stays in.
    return { removed: [], skipped: `the frames couldn't be compared here (${(e && e.message) || e})` };
  } finally {
    ctx.doc.querySelectorAll("[data-cm-g]").forEach(el => el.removeAttribute("data-cm-g"));
  }
}

/* ------------------------------------------------------------- backup ---- */
// The backup image an ad server shows where HTML5 can't run: the end frame as
// a JPEG, the best quality that fits SPEC.maxBackupBytes. Drawn from the images
// that ship, over the shell's own black, so it matches the ad exactly.
async function makeBackup(out) {
  if (!out || !out.chosen || !out.html || !out.timing) return { error: "Nothing was built to make a backup from." };
  let svg = out.html.slice(out.html.indexOf("<svg"), out.html.lastIndexOf("</svg>") + 6);
  for (const a of out.assets) svg = svg.split(`"${a.name}"`).join(`"data:${a.type};base64,${base64(a.data)}"`);
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const tm = out.timing;
  // After the last play everything sits in its final state whatever its delay,
  // so a finite run needs no shared clock; a mid-hold frame of an endless loop does.
  const why = whyNoFreeze(doc);
  if (why) return { error: `The end frame can't be drawn here: ${why}. Export the backup from Figma.` };
  if (!isFinite(tm.total) && !sharesOneClock(doc)) return { error: "It loops forever and its animations don't all start together, so the end frame can't be drawn. Export the backup from Figma." };
  if (!(tm.total > 0) && !(tm.timeline > 0) && /@keyframes/.test(cssOf(doc))) return { error: "The animation's length couldn't be read, so the end frame isn't known. Export the backup from Figma." };
  // The end frame: after the last play has finished, or mid-hold for a banner
  // that loops forever.
  const at = isFinite(tm.total) ? tm.total + 0.5 : tm.hold > 0 ? tm.timeline + tm.hold / 2 : Math.max(0, tm.timeline - 0.02);
  try {
    const c = await frameCanvas(svg, at, out.ctx.width, out.ctx.height, "#000");
    const enc = async q => new Uint8Array(await (await toBlob(c, "image/jpeg", q)).arrayBuffer());
    let lo = 0.1, hi = 0.95, best = null;
    const top = await enc(hi);
    if (top.length <= SPEC.maxBackupBytes) best = { q: hi, data: top };
    else {
      for (let k = 0; k < 8; k++) {
        const q = (lo + hi) / 2, d = await enc(q);
        if (d.length <= SPEC.maxBackupBytes) { best = { q, data: d }; lo = q; } else hi = q;
      }
      if (!best) { const d = await enc(0.1); if (d.length <= SPEC.maxBackupBytes) best = { q: 0.1, data: d }; }
    }
    if (!best) return { error: `Even at the lowest quality the end frame is over ${Math.round(SPEC.maxBackupBytes / 1000)} KB as a JPEG.` };
    // An ad that ends blank, or back where it started, almost always means the
    // timeline doesn't end on the end card.
    const end = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (let i = 0; i < end.length; i += 4) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], end[i + k]); mx[k] = Math.max(mx[k], end[i + k]); }
    const blank = mx.every((v, k) => v - mn[k] < 8);
    let sameAsStart = false;
    if (!blank && at > 0.5) {
      const first = (await frameCanvas(svg, 0, out.ctx.width, out.ctx.height, "#000")).getContext("2d").getImageData(0, 0, c.width, c.height).data;
      sameAsStart = !framesDiffer(end, first);
    }
    return { data: best.data, bytes: best.data.length, quality: +best.q.toFixed(2), at: +at.toFixed(2), width: c.width, height: c.height, blank, sameAsStart };
  } catch (e) {
    return { error: `The end frame couldn't be drawn here (${(e && e.message) || e}).` };
  }
}

/* ------------------------------------------------------------- minify ---- */
// Geometry only. Path coordinates are in user units, so 2 decimals is far below
// one pixel. CSS is left alone: keyframe matrices carry scale factors like
// 0.00499251 that do not survive rounding.
function minifyGeometry(doc, decimals) {
  for (const el of doc.querySelectorAll("[d], [points]")) {
    for (const attr of ["d", "points"]) {
      const v = el.getAttribute(attr);
      if (v) el.setAttribute(attr, v.replace(/-?\d*\.\d+/g, n => String(+parseFloat(n).toFixed(decimals))));
    }
  }
}

// Google Ads rejects self-closing tags in inline SVG (<path/>) and wants
// <path></path>. The serializer writes an end tag for any element that has a
// child, so an empty text node in each childless element is enough.
// Figma's layer names (data-name) go too: they read like file names
// ("photo.jpg") that aren't in the zip, which an asset checker can report as
// missing. Each <image> also gets xlink:href for browsers older than SVG 2.
function serialize(doc) {
  const root = doc.documentElement.cloneNode(true);
  for (const el of [root, ...root.querySelectorAll("*")]) {
    el.removeAttribute("data-name");
    if (el.localName === "image" && el.hasAttribute("href") && !el.hasAttributeNS(XLINK, "href"))
      el.setAttributeNS(XLINK, "xlink:href", el.getAttribute("href"));
    if (!el.firstChild) el.appendChild(doc.createTextNode(""));
  }
  return new XMLSerializer().serializeToString(root)
    .replace(/<!--[\s\S]*?-->/g, "").replace(/>\s+</g, "><");
}

/* --------------------------------------------------- build the ad shell --- */
function buildHtml(svgMarkup, w, h, title, clickId, rootId) {
  clickId = clickId || "ad-clickthrough";
  rootId = rootId || "ad-root";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="ad.size" content="width=${w},height=${h}">
  <title>${String(title).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])}</title>
  <script type="text/javascript">
    // IAB clickTag. No landing page URL is stored in this file.
    // The ad server supplies it, either by appending ?clickTag=<encoded url>
    // to the creative URL, or by overwriting this variable at serve time.
    var clickTag = "";
    (function () {
      var q = window.location.search || "";
      var m = /[?&]clickTag=([^&#]*)/i.exec(q);
      if (!m || !m[1]) { return; }
      var u = "";
      try {
        u = decodeURIComponent(m[1].replace(/\\+/g, "%20"));
      } catch (e) {
        return;
      }
      // Only accept http(s) so a crafted parameter cannot inject javascript:
      if (/^https?:\\/\\//i.test(u)) { clickTag = u; }
    })();
  <\/script>
  <style>
    html, body { margin: 0; padding: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: #000; }
    #${rootId} { position: relative; width: ${w}px; height: ${h}px; }
    #${rootId} > svg { display: block; width: ${w}px; height: ${h}px; }
    /* !important so a stylesheet inside the artwork can't hide the click layer */
    #${clickId} {
      position: absolute !important; top: 0 !important; left: 0 !important;
      width: ${w}px !important; height: ${h}px !important;
      display: block !important; visibility: visible !important;
      opacity: 1 !important; pointer-events: auto !important;
      z-index: 2147483647 !important; cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="${rootId}">
${svgMarkup}
    <div id="${clickId}"></div>
  </div>
  <script type="text/javascript">
    (function () {
      var el = document.getElementById('${clickId}');
      if (!el) { return; }
      el.addEventListener('click', function () {
        // Re-checked at click time: an ad server may overwrite clickTag after
        // load, and only a web address should ever be opened.
        if (window.clickTag && /^https?:\\/\\//i.test(window.clickTag)) {
          window.open(window.clickTag, '_blank');
          // Google's ad-serving rules: animation stops on an exit click.
          // Finishing lands every animation on its end frame.
          if (document.getAnimations) {
            document.getAnimations().forEach(function (a) { try { a.finish(); } catch (e) {} });
          }
        }
      });
    })();
  <\/script>
</body>
</html>`;
}

/* ============================================================== pipeline == */
// opts.plays: "auto" (as exported), a number of plays, or "forever"/Infinity;
// opts.pause: seconds the end frame holds between plays.
// What fits the time limit, said plainly: how many plays at this pause, and
// how short the pause must be for the plays chosen.
function fitHint(T, plays, pause, fade) {
  const max = SPEC.maxTotalSeconds, secs = x => `${+x.toFixed(1)}s`;
  const fit = Math.floor((max + pause + fade + 1e-6) / (T + pause + fade));
  const keep = plays > 1 ? Math.floor(((max - plays * T) / (plays - 1) - fade) * 2 + 1e-6) / 2 : -1;
  const ways = [];
  if (fit >= 2) ways.push(`${fit} plays fit with this pause`);
  if (keep >= 0) ways.push(`${plays} plays fit with a pause of ${secs(keep)} or less`);
  if (T <= max) ways.push(`Plays once runs ${secs(T)}`);
  return `One play is ${secs(T)}. ${ways.length ? ways.join("; ") + "." : "Shorten the timeline in Figma."}`;
}
async function run(file, opts = {}) {
  const ctx = inspect(await file.text());
  const results = [];

  // structural rules first — a blocker here means nothing gets rewritten
  for (const rule of RULES) {
    const r = rule.run(ctx);
    results.push({ rule, ...r });
    if (r.status === "block" && ["dimensions", "animation"].includes(rule.id)) {
      return { ctx, results, blocked: true };
    }
  }

  // When things happen, for comparing frames and drawing the end frame: one
  // play, the hold and fade between plays, and the whole run as it now stands
  // (after any cap on looping).
  let timing = { timeline: ctx.cycle || 0, hold: 0, fade: 0, total: runLength(ctx.doc) };

  // Plays chosen by the person replace whatever looping the export had.
  if (opts.plays && opts.plays !== "auto") {
    const forever = opts.plays === "forever" || opts.plays === Infinity;
    const plays = forever ? Infinity : Math.max(1, Math.min(SPEC.maxLoops, Number(opts.plays) || 1));
    const pause = plays > 1 ? Math.max(0, Number(opts.pause) || 0) : 0;
    const playsRule = { id: "plays", title: "Plays" };
    const fade = plays > 1 ? Math.max(0, Number(opts.fade) || 0) : 0;
    const loop = applyLoop(ctx.doc, plays, pause, fade);
    if (loop.ok) timing = { timeline: loop.timeline, hold: pause, fade, total: loop.total };
    if (!loop.ok) {
      results.push({ rule: playsRule, ...warn(`The number of plays couldn't be set: ${loop.reason}. Left as exported.`, "") });
    } else {
      const i = results.findIndex(x => x.rule.id === "loop");
      if (i >= 0) results.splice(i, 1);   // superseded: the plays are now set explicitly
      const gap = (pause ? `, ${pause}s pause between` : "") +
        (fade ? `, ${loop.faded} animated layer${loop.faded === 1 ? "" : "s"} fading out over ${fade}s before each replay` : "");
      const what = forever ? `Loops forever${gap}` : plays === 1 ? "Plays once" : `${plays} plays${gap}`;
      const pending = forever && !SPEC.holdOnLastFrame
        ? pass(`${what} — ${loop.timeline.toFixed(1)}s per play.`)
        : forever ? block(`${what}, but this spec needs the animation to stop.`, "Choose a number of plays.")
        : loop.total > SPEC.maxTotalSeconds + 1e-6
          ? block(`${what}: ${loop.total.toFixed(1)}s in total, over the ${SPEC.maxTotalSeconds}s limit.`, fitHint(loop.timeline, plays, pause, fade))
          : pass(`${what} — ${loop.total.toFixed(1)}s in total, ending on the last frame.`);
      results.push({ rule: playsRule, ...pending });
    }
  }

  const name = file.name.replace(/\.svg$/i, "");
  const longest = Math.max(ctx.width, ctx.height);
  const budget = SPEC.maxZipKB * 1024;

  // Round coordinates relative to how much screen space a user unit covers, so a
  // small viewBox blown up to a large canvas doesn't get visibly distorted.
  const decimals = Math.min(6, Math.max(1, Math.ceil(Math.log10(ctx.viewBoxScale || 1) + 1.4)));
  minifyGeometry(ctx.doc, decimals);

  // The ad shell owns these ids. If the artwork already uses one, getElementById
  // would return the artwork's element and the ad would stop being clickable.
  let suffix = "", n = 2;
  while (ctx.doc.querySelector(`[id="ad-root${suffix}"], [id="ad-clickthrough${suffix}"]`))
    suffix = "-" + n++;
  const rootId = "ad-root" + suffix, clickId = "ad-clickthrough" + suffix;

  // One decode per distinct image: a logo placed four times should cost its bytes
  // once, not four times.
  const groups = new Map();
  for (const im of ctx.images) {
    if (!groups.has(im.href)) groups.set(im.href, { href: im.href, els: [] });
    groups.get(im.href).els.push(im.el);
  }
  const decoded = [];
  for (const g of groups.values()) {
    const img = await loadImage(g.href);
    // The size it is drawn at, at its largest placement; the ladder scales from
    // here (up to 2× for Retina).
    const target = Math.max(0, ...ctx.images.filter(im => im.href === g.href).map(im => Math.max(im.dispW || 0, im.dispH || 0)))
                || Math.max(img.naturalWidth, img.naturalHeight);
    decoded.push({ href: g.href, els: g.els, img, alpha: usesAlpha(img), target });
  }

  // Images that never show cost weight the visible ones need.
  if (decoded.length) {
    const looks = [...new Set(sampleTimes(timing).concat(keyMoments(ctx.doc)))];
    const hidden = await removeHiddenImages(ctx, decoded, looks);
    const hiddenRule = { id: "hidden", title: "Images that never show" };
    if (hidden.removed.length) {
      const gone = new Set(hidden.removed.map(r => r.i));
      for (let i = decoded.length - 1; i >= 0; i--) if (gone.has(i)) decoded.splice(i, 1);
      ctx.images = ctx.images.filter(im => im.el.isConnected && im.el.localName === "image");
      const n = hidden.removed.length, saved = hidden.removed.reduce((s, r) => s + r.bytes, 0);
      const masks = hidden.removed.filter(r => r.how === "white").length;
      results.push({ rule: hiddenRule, ...fixed(
        `${n} image${n === 1 ? "" : "s"} that never show${n === 1 ? "s" : ""} on screen left out (${kb(saved)} of source).`,
        `${masks ? `${masks} only shaped a mask and became a plain box; the rest ` : "They "}sat under other layers. Each was checked frame by frame through the animation: nothing on screen changed. Deleting unused layers in Figma does the same.`) });
    } else if (hidden.skipped) {
      results.push({ rule: hiddenRule, ...info(`Not checked: ${hidden.skipped}.`) });
    } else {
      results.push({ rule: hiddenRule, ...pass("Every image shows at some point.") });
    }
  }

  // Rasters ship as separate files so nothing pays the 33% base64 tax, kept flat
  // at the package root because nothing guarantees a validator walks subfolders.
  decoded.forEach((d, i) => {
    d.type = d.alpha ? SPEC.formatAlpha : SPEC.formatOpaque;
    d.file = `img${i}.${d.type === "image/png" ? "png" : "jpg"}`;
    d.els.forEach(el => {
      el.setAttribute("href", d.file);
      el.removeAttributeNS(XLINK, "href");
    });
  });

  // Vector markup is a fixed cost that no amount of image crushing can move.
  // Measure it first, so images are never degraded to chase a budget the
  // artwork itself is blowing.
  const markupHtml = buildHtml(serialize(ctx.doc), ctx.width, ctx.height, name, clickId, rootId);
  const markupBytes = new TextEncoder().encode(markupHtml);
  const markupZipped = (await deflateRaw(markupBytes)).length;

  const weightRule = { id: "weight", title: `Package within ${SPEC.maxZipKB} KB` };
  // Each file costs its zip headers (local + central, name twice) on top of its bytes.
  const zipOverhead = 22 + (76 + 2 * "index.html".length) + decoded.length * (76 + 2 * 12);
  const imageBudget = budget - markupZipped - zipOverhead;
  // The fit at one JPEG quality: every image's rung on the ladder. A PNG doesn't
  // depend on the JPEG quality, so its encodes are shared between fits.
  const memo = new Map();
  const fitAt = async quality => {
    const encode = async (d, rung) => {
      const s = Math.min(1, (d.target * SPEC.ladder[rung]) / Math.max(d.img.naturalWidth, d.img.naturalHeight));
      const canvas = drawTo(d.img, d.img.naturalWidth * s, d.img.naturalHeight * s);
      const blob = await toBlob(canvas, d.type, d.type === "image/jpeg" ? quality : undefined);
      return {
        name: d.file, type: d.type, rung, data: new Uint8Array(await blob.arrayBuffer()),
        w: canvas.width, h: canvas.height, natW: d.img.naturalWidth, natH: d.img.naturalHeight,
        target: d.target, drawn: Math.max(canvas.width, canvas.height)
      };
    };
    const at = async (i, rung) => {
      const key = decoded[i].type === "image/jpeg" ? `${i}:${rung}:${quality}` : `${i}:${rung}`;
      if (!memo.has(key)) memo.set(key, await encode(decoded[i], rung));
      return memo.get(key);
    };
    const totalOf = async picks => {
      let n = 0;
      for (let i = 0; i < picks.length; i++) n += (await at(i, picks[i])).data.length;
      return n;
    };

    let picks = [], overBudget = false;

    if (imageBudget <= 0) {
      // Markup alone is over budget, so no amount of image reduction can help.
      // Leave them at full size: the numbers should show where the weight really
      // is, not a set of ruined images in a package that is blocked anyway.
      overBudget = true;
      for (let i = 0; i < decoded.length; i++) picks.push(0);
    } else if (decoded.length) {
      // Give every image an equal slice, take the largest rung that fits it, then
      // hand back whatever the split left over — largest gain first, fixed order,
      // so the same input always lands on the same result.
      const share = imageBudget / decoded.length;
      for (let i = 0; i < decoded.length; i++) {
        let chosenRung = SPEC.ladder.length - 1;
        for (let r = 0; r < SPEC.ladder.length; r++) {
          if ((await at(i, r)).data.length <= share) { chosenRung = r; break; }
        }
        picks.push(chosenRung);
      }
      for (let guard = 0; guard < SPEC.ladder.length * decoded.length; guard++) {
        let improved = false;
        for (let i = 0; i < picks.length; i++) {
          if (picks[i] === 0) continue;
          const trial = picks.slice();
          trial[i] -= 1;
          if (await totalOf(trial) <= imageBudget) { picks = trial; improved = true; }
        }
        if (!improved) break;
      }
      overBudget = (await totalOf(picks)) > imageBudget;
    }

    const assets = [];
    for (let i = 0; i < decoded.length; i++) assets.push(await at(i, picks[i]));
    return { picks, overBudget, assets, quality };
  };
  // A photo squeezed below the size it's drawn at looks soft; a little more JPEG
  // compression at full size looks better. So if the first fit shrinks one, try
  // once at the lower quality and keep that if fewer are shrunk.
  // The retry is kept only if fewer photos are shrunk and no PNG (a logo, a
  // cutout) is shrunk that wasn't before.
  const isShrunk = a => a.drawn < Math.min(a.target, Math.max(a.natW, a.natH)) - 0.5;
  const shrunk = f => f.assets.filter(a => a.type === "image/jpeg" && isShrunk(a)).length;
  let fit = await fitAt(SPEC.jpegQuality);
  if (SPEC.jpegQualityFloor && SPEC.jpegQualityFloor < SPEC.jpegQuality && !fit.overBudget && shrunk(fit)) {
    const alt = await fitAt(SPEC.jpegQualityFloor);
    const pngWorse = alt.assets.some((a, i) => a.type !== "image/jpeg" && isShrunk(a) && !isShrunk(fit.assets[i]));
    if (!alt.overBudget && !pngWorse && shrunk(alt) < shrunk(fit)) fit = alt;
  }
  let { picks, overBudget, assets } = fit;
  const qNote = fit.quality === SPEC.jpegQuality ? ""
    : ` JPEG quality ${Math.round(fit.quality * 100)}, so ${shrunk(fit) ? "fewer photos ship" : "no photo ships"} smaller than ${shrunk(fit) ? "they're" : "it's"} drawn.`;

  const files = [{ name: "index.html", data: markupBytes },
                 ...assets.map(a => ({ name: a.name, data: a.data }))];
  const zip = await makeZip(files);
  const chosen = { zipBytes: zip.size, unzipped: files.reduce((n, f) => n + f.data.length, 0),
                   files, markupZipped, picks };
  const html = markupHtml;

  if (chosen.zipBytes <= budget) {
    // Only an image below the size it's drawn at counts as reduced; 1.5× is
    // still sharper than the screen.
    const reduced = assets.filter(a => SPEC.ladder[a.rung] < 1);
    results.push({ rule: weightRule,
      ...(reduced.length
        ? fixed(`${kb(chosen.zipBytes)} — ${reduced.length} image(s) resampled to fit.${qNote}`,
                assets.map(a => `${a.name} ${a.natW}×${a.natH} → ${a.w}×${a.h} (${kb(a.data.length)})`).join("; ")
                + `. Vector markup is ${kb(markupZipped)} of the total.`)
        : pass(`${kb(chosen.zipBytes)}, nothing had to be reduced.${qNote}`)) });
  } else if (imageBudget <= 0) {
    results.push({ rule: weightRule,
      ...block(`The vector artwork alone is ${kb(markupZipped)}, over the ${SPEC.maxZipKB} KB budget before any image is counted.`,
        "Images can't fix this — the weight is in the shapes, blurs, gradients and keyframes. In Figma reduce the number of animated layers or effects, or flatten complex vector artwork into a single image layer, then export again.") });
  } else {
    const worst = [...assets].sort((a, b) => b.data.length - a.data.length)[0];
    results.push({ rule: weightRule,
      ...block(`Smallest achievable is ${kb(chosen.zipBytes)}, over the ${SPEC.maxZipKB} KB budget.`,
        `Every image is already at the bottom of the resolution ladder. "${worst.name}" is still ${kb(worst.data.length)} at ${worst.w}×${worst.h}, down from ${worst.natW}×${worst.natH}${worst.type === "image/png" ? " — it has to stay PNG because it uses transparency, which costs far more than a photo" : ""}. In Figma, simplify or crop that layer, or remove its transparency so it can ship as a JPEG.`) });
  }

  // Fitting the budget by quietly wrecking an image is not the same as fitting it.
  const soft = assets
    .filter(a => a.target && a.drawn && a.target / a.drawn >= 1.5)
    .map(a => `${a.name} at ${a.w}×${a.h} is stretched ${(a.target / a.drawn).toFixed(1)}× on screen`);
  if (soft.length) {
    results.push({ rule: { id: "sharpness", title: "Image sharpness" },
      ...warn(`${soft.length} image(s) had to be shrunk below the size they are drawn at.`,
        soft.join("; ") + ". They will look soft. To sharpen them, free up budget elsewhere — flatten a live blur into an image, remove transparency from anything that doesn't need it so it can ship as a JPEG, or simplify the vector artwork.") });
  }

  if (assets.length) {
    const png = assets.filter(a => a.type === "image/png").length;
    results.push({ rule: { id: "format", title: "Raster formats" },
      ...info(`${assets.length - png} JPEG, ${png} PNG. Format is chosen per image from its own pixels — anything using transparency has to stay PNG, since JPEG would fill those areas with black.`) });
  }

  return { ctx, results, chosen, html, assets, name, timing, blocked: false };
}
