/**
 * Record — and re-check — the provenance of a "baseline" `dist/main.js` that was built elsewhere.
 *
 * The PR's Before/After size claim is only meaningful if the "Before" artifact really is a build of
 * the baseline revision. A size and a `dist/` directory do not prove that: `dist/` is gitignored, so
 * `git status` says nothing about it, and a stale bundle from an earlier revision looks identical
 * from the outside. This tool collects the checks that DO discriminate, and writes them down:
 *
 *   1. the worktree is at the expected revision and has no uncommitted changes;
 *   2. the metafile describes the very artifact next to it (byte counts agree);
 *   3. the bundle was built **in place** (`// node_modules/...` module paths, no `../../` escapes —
 *      a build whose node_modules was reached through a junction is ~158 KB larger; see README);
 *   4. the bundle still contains the code paths under test (here: the Gemini ones);
 *   5. every bundled source file in the metafile exists in the worktree, and every source file that
 *      should be bundled is in the metafile (type-only modules are legitimately absent);
 *   6. if a later revision changed no bundled input relative to this one, the two revisions must
 *      produce the same bundle — which is how an artifact built at revision B can be trusted as
 *      revision A's build.
 *
 * Usage:
 *   node tools/provider-settings-shots/baseline-provenance.mjs \
 *     --worktree <dir> --dist <dir>/dist --revision caf9703 \
 *     --same-bundle-as b4fb0b5 \
 *     --marker "@google/genai" --marker "google-generative-ai" --marker "Gemini API" \
 *     --out-json tools/provider-settings-shots/metrics/<name>.metrics.json
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const OUTPUT_KEY = 'dist/main.js';
// Files esbuild actually reads into the bundle. A diff limited to these is a diff of the bundle.
const BUNDLED_INPUTS = ['main.ts', 'src', 'styles.css', 'manifest.json', 'esbuild.config.mjs', 'package.json', 'package-lock.json'];

function parseArgs(argv) {
  const values = {};
  const lists = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : next;
    if (!next || next.startsWith('--')) values[key] = value;
    else {
      values[key] = value;
      i += 1;
    }
    if (key === 'marker' || key === 'same-bundle-as' || key === 'tree-identical-to' || key === 'note') {
      lists[key] = lists[key] || [];
      lists[key].push(value);
    }
  }
  return { values, lists };
}

const { values, lists } = parseArgs(process.argv.slice(2));
for (const key of ['worktree', 'dist', 'revision', 'out-json']) {
  if (!values[key]) throw new Error(`--${key} is required`);
}

const worktree = path.resolve(values.worktree);
const distDir = path.resolve(values.dist);
const mainJsPath = path.join(distDir, 'main.js');
const metaPath = path.join(distDir, 'esbuild-meta.json');

const git = (args) => {
  try {
    return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    return `GIT-ERROR: ${(error.stderr || error.message || '').toString().trim()}`;
  }
};

const head = git(['rev-parse', 'HEAD']);
const statusShort = git(['status', '--porcelain']);
// Only the files esbuild reads can change the bundle, so cleanliness is asserted on those: a
// modified README or CHANGELOG in the same worktree is irrelevant to the artifact under test.
const bundledStatusShort = git(['status', '--porcelain', '--', ...BUNDLED_INPUTS]);
const mainJsBytes = fs.statSync(mainJsPath).size;
const mainJsMtime = fs.statSync(mainJsPath).mtime.toISOString();
const metafile = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const output = metafile.outputs && metafile.outputs[OUTPUT_KEY];
if (!output) throw new Error(`${metaPath} has no outputs["${OUTPUT_KEY}"]`);
const metaBytes = output.bytes;

const source = fs.readFileSync(mainJsPath, 'utf8');
const count = (needle) => source.split(needle).length - 1;
const markers = (lists.marker || []).map((marker) => ({ marker, occurrences: count(marker) }));
const inPlaceModuleComments = count('// node_modules/');
const escapingModuleComments = (source.match(/\/\/ \.\.\//g) || []).length;

// Bundled source inputs the metafile claims, versus what is on disk.
const metaInputs = new Set(Object.keys(metafile.inputs || {}));
const bundledMetaInputs = [...metaInputs].filter((i) => i === 'main.ts' || i.startsWith('src/'));
const onDisk = [];
const walk = (relDir) => {
  for (const entry of fs.readdirSync(path.join(worktree, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel);
    else if (/\.(ts|md|json)$/.test(entry.name)) onDisk.push(rel);
  }
};
walk('src');
if (fs.existsSync(path.join(worktree, 'main.ts'))) onDisk.push('main.ts');
const missingFromMetafile = onDisk.filter((file) => !bundledMetaInputs.includes(file)).sort();
const missingFromDisk = bundledMetaInputs.filter((file) => !onDisk.includes(file)).sort();

/**
 * Is a source file that esbuild did NOT bundle legitimately type-only?
 *
 * A filename heuristic ("types.ts", "*.d.ts") is not good enough — this repo also has
 * `runtime-types.ts` and `provider-capabilities.ts`. What actually makes a module disappear is that
 * it declares no runtime construct, so scan for one instead of guessing from the name. Comments are
 * stripped first so a `function` mentioned in prose does not count.
 */
const isTypeOnly = (relFile) => {
  // A `.d.ts` is type-only by definition (`declare module '*.md' { const content: string }` is not
  // runtime code even though it contains the word `const`).
  if (relFile.endsWith('.d.ts')) return true;
  const text = fs
    .readFileSync(path.join(worktree, relFile), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // A declaration needs an identifier after the keyword, so a property *named* like a keyword
  // (`enum?: string[]`, `const?: string`) does not count as one.
  const declaration = /^\s*(export\s+)?(declare\s+)?(const|let|var|function|class|async)\s+[A-Za-z_$]/m;
  const enumDeclaration = /^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s+[A-Za-z_$]/m;
  const defaultExport = /^\s*export\s+default\b/m;
  const statement = /^\s*(if|for|while|switch|return|throw)\s*[(\s]/m;
  return !declaration.test(text) && !enumDeclaration.test(text) && !defaultExport.test(text) && !statement.test(text);
};
const unbundledClassification = missingFromMetafile.map((file) => ({
  file,
  typeOnly: isTypeOnly(file),
  bytes: fs.statSync(path.join(worktree, file)).size,
}));

// A later revision that changed no bundled input produces the same bundle. This is what lets an
// artifact built at one revision stand in for another.
const sameBundleAs = (lists['same-bundle-as'] || []).map((other) => {
  const diff = git(['diff', '--stat', other, values.revision, '--', ...BUNDLED_INPUTS]);
  return {
    otherRevision: other,
    bundledInputsIdentical: diff === '',
    diffStat: diff || null,
  };
});

// Whole-tree identity: when a rebase rewrites a commit's SHA without changing a byte, this is the
// check that says so, and it is what lets a build made before the rebase be labelled with the SHA
// that is actually on the branch.
const treeIdenticalTo = (lists['tree-identical-to'] || []).map((other) => {
  const otherTree = git(['rev-parse', `${other}^{tree}`]);
  const thisTree = git(['rev-parse', `${values.revision}^{tree}`]);
  const diff = git(['diff', '--stat', other, values.revision]);
  return {
    otherRevision: other,
    otherTree,
    revisionTree: thisTree,
    treesIdentical: otherTree === thisTree && diff === '',
    fullTreeDiffStat: diff || null,
  };
});

const sourceMtimes = onDisk
  .map((file) => ({ file, mtime: fs.statSync(path.join(worktree, file)).mtime.toISOString() }))
  .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));

const checks = {
  // Asserted against the revision's TREE, not against HEAD: a rebase (or a worktree parked on an
  // older commit) changes HEAD without changing the bytes esbuild reads, and the bytes are what the
  // artifact has to match.
  bundledInputsMatchRevisionTree: git(['diff', '--stat', values.revision, '--', ...BUNDLED_INPUTS]) === '',
  bundledInputsUnmodified: bundledStatusShort === '',
  metafileMatchesArtifact: metaBytes === mainJsBytes,
  builtInPlace: escapingModuleComments === 0 && inPlaceModuleComments > 0,
  bundledInputsIdenticalToComparedRevision: sameBundleAs.every((s) => s.bundledInputsIdentical),
  metafileInputsAllExistOnDisk: missingFromDisk.length === 0,
  everyUnbundledSourceFileIsTypeOnly: unbundledClassification.every((f) => f.typeOnly),
};

const report = {
  schema: 'baizer-baseline-provenance/1',
  generatedAt: new Date().toISOString(),
  worktree,
  revision: values.revision,
  revisionTree: git(['rev-parse', `${values.revision}^{tree}`]),
  head,
  headMatchesRevision: head === git(['rev-parse', values.revision]),
  gitStatusPorcelain: statusShort || null,
  gitStatusPorcelainBundledInputs: bundledStatusShort || null,
  artifact: {
    path: mainJsPath,
    bytes: mainJsBytes,
    sha256: createHash('sha256').update(fs.readFileSync(mainJsPath)).digest('hex').toUpperCase(),
    mtime: mainJsMtime,
    metafilePath: metaPath,
    metafileBytes: metaBytes,
    metafileMatchesArtifact: metaBytes === mainJsBytes,
    inputCount: metaInputs.size,
  },
  builtInPlace: {
    nodeModulesModuleComments: inPlaceModuleComments,
    escapingModuleComments,
    note: 'a build that reaches node_modules through a junction emits `// ../../…` paths and is ~158 KB larger for this repo',
  },
  markers,
  markerNote:
    'Counts are case-sensitive and are taken from the built artifact. They are assertions about what '
    + 'the BUNDLE contains, not about the source tree: this build is not minified, so comments ship. '
    + 'A surviving `gemini` in a comment is not Google support, and a surviving api id is expected '
    + 'even after removal because pi-ai\'s compat registry names every api factory (the removed one is '
    + 'replaced by a stub that throws a readable error). Read them together with the module table in '
    + 'the bundle-size record.',
  notes: lists.note || [],
  metafileInputs: {
    bundledSourceInputs: bundledMetaInputs.length,
    sourceFilesOnDisk: onDisk.length,
    onDiskButNotBundled: missingFromMetafile,
    unbundledClassification,
    note: 'a module is absent from the bundle only if it declares no runtime construct; that is scanned, not guessed from the filename',
    bundledButNotOnDisk: missingFromDisk,
  },
  sameBundleAs,
  treeIdenticalTo,
  newestSourceMtime: sourceMtimes[0] || null,
  artifactNewerThanSources: sourceMtimes.length ? mainJsMtime > sourceMtimes[0].mtime : null,
  checks,
  allChecksPass: Object.values(checks).every(Boolean),
};

fs.mkdirSync(path.dirname(path.resolve(values['out-json'])), { recursive: true });
fs.writeFileSync(path.resolve(values['out-json']), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`worktree   ${worktree}`);
console.log(`revision   ${values.revision}  tree ${report.revisionTree}  (HEAD ${head}${report.headMatchesRevision ? '' : ' — differs, tree check is what counts'})  bundled inputs clean=${checks.bundledInputsUnmodified}`);
console.log(`artifact   ${mainJsBytes} B  sha256 ${report.artifact.sha256.slice(0, 16)}…  metafile=${metaBytes} B  match=${checks.metafileMatchesArtifact}`);
console.log(`in place   ${inPlaceModuleComments} '// node_modules/' vs ${escapingModuleComments} '// ../'  ok=${checks.builtInPlace}`);
console.log(`markers    ${markers.map((m) => `${m.marker}=${m.occurrences}`).join('  ')}`);
for (const s of sameBundleAs) {
  console.log(`same as    ${s.otherRevision}: bundled inputs identical=${s.bundledInputsIdentical}`);
}
for (const s of treeIdenticalTo) {
  console.log(`tree same  ${s.otherRevision}: trees identical=${s.treesIdentical} (${s.otherTree})`);
}
console.log(`inputs     ${bundledMetaInputs.length} bundled / ${onDisk.length} on disk; on-disk-but-not-bundled=${missingFromMetafile.join(', ') || 'none'}`);
console.log(`checks     ${Object.entries(checks).map(([k, v]) => `${v ? 'PASS' : 'FAIL'}:${k}`).join(' ')}`);
if (!report.allChecksPass) process.exitCode = 1;
