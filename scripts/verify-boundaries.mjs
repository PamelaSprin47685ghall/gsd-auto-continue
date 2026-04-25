#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);
const srcRoot = join(root, "src");

const failures = [];

function fail(message) {
  failures.push(message);
}

function readTracked(relativePath) {
  if (relativePath.startsWith("../") || relativePath.includes("/../")) {
    throw new Error(`Verifier path escapes package root: ${relativePath}`);
  }

  return readFileSync(join(root, relativePath), "utf8");
}

function assertFileExists(relativePath) {
  if (!existsSync(join(root, relativePath))) {
    fail(`Missing required tracked file: ${relativePath}`);
  }
}

function assertFileAbsent(relativePath) {
  if (existsSync(join(root, relativePath))) {
    fail(`Forbidden legacy file still exists: ${relativePath}`);
  }
}

function assertMatch(source, pattern, message) {
  if (!pattern.test(source)) fail(message);
}

function assertNoMatch(source, pattern, message) {
  if (pattern.test(source)) fail(message);
}

function countMeaningfulLines(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//")).length;
}

function assertLineBudget(relativePath, maxMeaningfulLines) {
  const source = readTracked(relativePath);
  const lineCount = countMeaningfulLines(source);
  if (lineCount > maxMeaningfulLines) {
    fail(`${relativePath} has ${lineCount} meaningful lines; expected <= ${maxMeaningfulLines} to avoid god-file regression`);
  }
}

const requiredFiles = [
  "package.json",
  "index.ts",
  "index.test.mjs",
  "src/actions.ts",
  "src/config.ts",
  "src/diagnostics.ts",
  "src/lifecycle.ts",
  "src/recovery.ts",
  "src/runtime-state.ts",
  "src/timers.ts",
  "src/types.ts",
];

for (const relativePath of requiredFiles) {
  assertFileExists(relativePath);
}

assertFileAbsent("src/classifiers.ts");

const packageJson = JSON.parse(readTracked("package.json"));
if (JSON.stringify(packageJson.pi?.extensions) !== JSON.stringify(["index.ts"])) {
  fail('package.json must declare pi.extensions exactly as ["index.ts"]');
}

const indexSource = readTracked("index.ts");
assertLineBudget("index.ts", 45);
assertMatch(indexSource, /export\s+default\s+async\s+function\s+registerExtension\s*\(/, "index.ts must keep registerExtension as the default factory");
assertMatch(indexSource, /from\s+["']\.\/src\/lifecycle\.ts["']/, "index.ts must delegate lifecycle registration to src/lifecycle.ts");
assertMatch(indexSource, /registerLifecycleHooks\s*\(/, "index.ts must call registerLifecycleHooks rather than own lifecycle handlers");
assertMatch(indexSource, /createRecoveryOperations\s*\(/, "index.ts must compose recovery operations rather than inline recovery logic");
assertNoMatch(indexSource, /classifiers?\.ts|createClassifier|ClassifierDependencies/, "index.ts must not import legacy classifier plumbing");
assertNoMatch(indexSource, /\bpi\.on\s*\(/, "index.ts must remain a thin hub and not register lifecycle hooks directly");
assertNoMatch(indexSource, /\bctx\.abort\s*\(/, "index.ts must not own abort behavior");
assertNoMatch(indexSource, /\b(?:setTimeout|clearTimeout)\s*\(/, "index.ts must not own timer scheduling primitives");
assertNoMatch(indexSource, /\b(?:sendUserMessage|retryLastTurn)\s*\(/, "index.ts must not own Pi dispatch fallback primitives");
assertNoMatch(indexSource, /\bhandle(?:Stop|Type1|Type2|ToolErrorTurn)\b/, "index.ts must not grow recovery decision handlers");

const testSource = readTracked("index.test.mjs");
const forbiddenBehaviorTestPatterns = [
  [/readFileSync/, "readFileSync"],
  [/readFile\s*\(/, "readFile("],
  [/source\.includes/, "source.includes"],
  [/assert\.match\(source/, "assert.match(source"],
];
for (const [pattern, label] of forbiddenBehaviorTestPatterns) {
  assertNoMatch(testSource, pattern, `index.test.mjs must stay behavioral and not reintroduce implementation source reads (${label})`);
}

const configSource = readTracked("src/config.ts");
assertMatch(configSource, /TYPE1_SIGNAL_PHRASES/, "src/config.ts must define Type 1 signal phrases without regex classifiers");
assertNoMatch(configSource, /new\s+RegExp|_RE\b/, "src/config.ts must not reintroduce regex-based error classification");

const lifecycleSource = readTracked("src/lifecycle.ts");
assertLineBudget("src/lifecycle.ts", 150);
assertNoMatch(lifecycleSource, /classifiers?\.ts|ClassifierDependencies/, "lifecycle.ts must not depend on legacy classifier plumbing");
assertNoMatch(lifecycleSource, /\bctx\.abort\s*\(/, "lifecycle.ts must not directly call ctx.abort(); recovery owns tool-error abort decisions");
assertNoMatch(
  lifecycleSource,
  /state\.(?:consecutiveToolErrorTurns|toolErrorGuardAbortArmed)\b/,
  "lifecycle.ts must not mutate tool-error guard counters or armed state directly",
);
assertNoMatch(
  lifecycleSource,
  /\b(?:recordToolErrorTurn|resetToolErrorGuard|armToolErrorGuardAbort|disarmToolErrorGuardAbort)\b/,
  "lifecycle.ts must not import or call tool-error guard state mutators directly",
);
assertNoMatch(lifecycleSource, /\b(?:setTimeout|clearTimeout)\s*\(/, "lifecycle.ts must not own timer scheduling primitives");
assertNoMatch(lifecycleSource, /\bsendUserMessage\s*\(/, "lifecycle.ts must not own Pi user-message dispatch fallbacks");

const recoverySource = readTracked("src/recovery.ts");
assertLineBudget("src/recovery.ts", 420);
assertMatch(recoverySource, /\bhandleStop\s*\(/, "recovery.ts must own stop recovery decisions");
assertMatch(recoverySource, /\bhandleToolErrorTurn\s*\(/, "recovery.ts must own tool-error guard recovery decisions");
assertMatch(recoverySource, /Loop \$\{loop\}\/unlimited/, "recovery.ts must expose Type 2 unlimited loop status");
assertNoMatch(recoverySource, /classifiers?\.ts|ClassifierDependencies/, "recovery.ts must not use legacy classifier plumbing");
assertNoMatch(recoverySource, /\btype3\b|Type 3/, "recovery.ts must not retain legacy Type 3 recovery branches");
assertNoMatch(recoverySource, /new\s+RegExp|_RE\b/, "recovery.ts must not reintroduce regex-based error classification");
assertNoMatch(recoverySource, /\b(?:setTimeout|clearTimeout)\s*\(/, "recovery.ts must delegate timer primitives to src/timers.ts");
assertNoMatch(recoverySource, /\bsendUserMessage\s*\(/, "recovery.ts must delegate safe user-message dispatch to src/actions.ts");
assertNoMatch(recoverySource, /\bretryLastTurn\s*\(/, "recovery.ts must delegate retryLastTurn dispatch to src/actions.ts");

const timersSource = readTracked("src/timers.ts");
assertMatch(timersSource, /\bsetTimeout\s*\(/, "src/timers.ts must own retry timer scheduling");
assertMatch(timersSource, /\bclearTimeout\s*\(/, "src/timers.ts must own retry timer cancellation");

const actionSource = readTracked("src/actions.ts");
assertMatch(actionSource, /\bsendUserMessage\s*\(/, "src/actions.ts must own safe sendUserMessage dispatch");
assertMatch(actionSource, /\bretryLastTurn\b/, "src/actions.ts must own safe retryLastTurn dispatch");
assertMatch(actionSource, /triggerTurn\s*:\s*true/, "src/actions.ts must own hidden trigger-turn fallback dispatch");

for (const moduleName of ["actions.ts", "config.ts", "diagnostics.ts", "lifecycle.ts", "recovery.ts", "runtime-state.ts"]) {
  const relativePath = `src/${moduleName}`;
  const source = readFileSync(join(srcRoot, moduleName), "utf8");
  assertNoMatch(source, /\b(?:setTimeout|clearTimeout)\s*\(/, `${relativePath} must not own timer scheduling primitives`);
}

for (const moduleName of ["config.ts", "diagnostics.ts", "lifecycle.ts", "recovery.ts", "runtime-state.ts", "timers.ts", "types.ts"]) {
  const relativePath = `src/${moduleName}`;
  const source = readFileSync(join(srcRoot, moduleName), "utf8");
  assertNoMatch(source, /\bsendUserMessage\s*\(/, `${relativePath} must not own safe sendUserMessage dispatch`);
  assertNoMatch(source, /\bsendMessage\s*\([^\n]*triggerTurn|triggerTurn\s*:\s*true/, `${relativePath} must not own hidden trigger-turn fallback dispatch`);
  assertNoMatch(source, /\bretryLastTurn\s*\(/, `${relativePath} must not own retryLastTurn dispatch`);
}

const allSources = requiredFiles.map((relativePath) => [relativePath, readTracked(relativePath)]);
for (const [relativePath, source] of allSources) {
  if (relativePath === "README.md" || relativePath === "README-NEW.md") continue;
  assertNoMatch(source, /src\/classifiers\.ts|createClassifierDependencies/, `${relativePath} must not reference removed classifier module`);
}

if (failures.length > 0) {
  console.error("gsd-auto-continue boundary verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`gsd-auto-continue boundary verification passed (${requiredFiles.length} tracked files checked, classifiers removed).`);
