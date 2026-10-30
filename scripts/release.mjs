// Publishes a new version of the Copy Motion plugin.
//
//   node scripts/release.mjs 1.0.2 "One-line summary" "Detail …" "Detail …"
//   node scripts/release.mjs patch "One-line summary"   (or minor / major)
//   node scripts/release.mjs patch "One-line summary" --dry-run
//
// Stamps the version, rebuilds the plugin, zips it to dist/Copy-Motion.zip,
// adds the release to copy-motion.json (the toolkit page's version and "What's
// new", and what the plugin checks for updates), then commits, tags, pushes
// and creates the GitHub release with the zip attached. --dry-run stops
// before anything is committed or published.
import { readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts }).trim();
const fail = msg => { console.error(`release: ${msg}`); process.exit(1); };

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const [want, ...notes] = args.filter(a => a !== "--dry-run");
if (!want || !notes.length) fail('usage: node scripts/release.mjs <x.y.z | patch | minor | major> "summary" ["detail" …] [--dry-run]');

const current = readFileSync(join(root, "VERSION"), "utf8").trim();
const [M, m, p] = current.split(".").map(Number);
const version = want === "patch" ? `${M}.${m}.${p + 1}` : want === "minor" ? `${M}.${m + 1}.0`
  : want === "major" ? `${M + 1}.0.0` : want;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`"${want}" isn't a version like 1.2.3, or patch / minor / major`);
const tag = `v${version}`;

if (!dry) {
  if (sh("git", ["status", "--porcelain"])) fail("commit or stash your changes first, so the release matches what's in git");
  if (sh("git", ["tag", "--list", tag])) fail(`${tag} already exists`);
}

// 1. Stamp and build: the version shows in the plugin's footer.
writeFileSync(join(root, "VERSION"), version + "\n");
sh("node", ["figma-plugin/build.mjs"]);

// 2. The installable folder, zipped.
const dist = join(root, "dist"), folder = join(dist, "Copy Motion");
rmSync(dist, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
for (const f of ["manifest.json", "code.js", "ui.html", "README.md"]) copyFileSync(join(root, "figma-plugin", f), join(folder, f));
sh("zip", ["-qrX", "Copy-Motion.zip", "Copy Motion"], { cwd: dist });

// 3. The version file: newest first, in the same shape as Static Recompose's.
const listFile = join(root, "copy-motion.json");
const info = JSON.parse(readFileSync(listFile, "utf8"));
const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const [summary, ...details] = notes;
const history = [{ version, date, summary, notes: details }].concat((info.history || []).filter(r => r.version !== version));
writeFileSync(listFile, JSON.stringify({ version, date, summary,
  download: `https://github.com/hcrocker-sys/figma-toolkit/releases/download/${tag}/Copy-Motion.zip`, history }, null, 2) + "\n");

if (dry) {
  console.log(`Dry run: ${tag} built to dist/Copy-Motion.zip. Nothing committed or published.`);
  console.log("Undo the stamp with: git checkout VERSION copy-motion.json figma-plugin/ui.html");
  process.exit(0);
}

// 4. Commit, tag, push (Pages publishes from main), release.
sh("git", ["add", "VERSION", "copy-motion.json", "figma-plugin/ui.html"]);
sh("git", ["commit", "-m", `Release ${tag}`]);
sh("git", ["tag", tag]);
const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
sh("git", ["push", "origin", ...(branch === "main" ? ["main"] : [branch, "HEAD:main"]), tag]);
// The tag is pushed above, so the release is made on this commit.
sh("gh", ["release", "create", tag, join(dist, "Copy-Motion.zip"), "--verify-tag", "--title", `Copy Motion ${tag}`,
          "--notes", [summary, ...details.map(n => `- ${n}`)].join("\n\n")]);
console.log(`Released ${tag}: ${sh("gh", ["release", "view", tag, "--json", "url", "--jq", ".url"])}`);
