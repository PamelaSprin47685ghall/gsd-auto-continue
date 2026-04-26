import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type GsdAutoErrorContext = {
  message: string;
  category: string;
  stopReason?: string;
  isTransient?: boolean;
  retryAfterMs?: number;
};

export type GsdAutoSnapshot = {
  active: boolean;
  paused: boolean;
  stepMode: boolean;
  basePath: string;
  errorContext?: GsdAutoErrorContext;
};

type GsdAutoModule = {
  getAutoDashboardData?: () => Partial<GsdAutoSnapshot>;
};

type GsdJournalModule = {
  queryJournal?: (basePath: string, filters?: { eventType?: string }) => JournalEntry[];
};

type ContextOverflowModule = {
  isContextOverflow?: (message: unknown, contextWindow?: number) => boolean;
};

type JournalEntry = {
  ts?: string;
  eventType?: string;
  data?: {
    status?: string;
    errorContext?: Partial<GsdAutoErrorContext>;
  };
};

type SnapshotReader = () => Promise<GsdAutoSnapshot | undefined>;
type ContextOverflowDetector = (message: unknown, contextWindow?: number) => boolean;

type GsdInternals = {
  auto?: GsdAutoModule;
  journal?: GsdJournalModule;
  overflow?: ContextOverflowModule;
};

let overrideReader: SnapshotReader | undefined;
let overrideContextOverflowDetector: ContextOverflowDetector | undefined;
let cachedInternals: GsdInternals | undefined;
let loadAttempted = false;

const existing = (path: string | undefined) => path && existsSync(path) ? path : undefined;

const executablePath = (name: string) =>
  process.env.PATH
    ?.split(delimiter)
    .map((directory) => existing(join(directory, name)))
    .find((path): path is string => typeof path === "string");

const real = (path: string | undefined) => {
  if (!path) return undefined;

  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const installedAutoCandidate = (binaryPath: string | undefined) => {
  const path = real(binaryPath);
  if (!path) return undefined;

  const directory = dirname(path);
  return [
    join(directory, "../resources/extensions/gsd/auto.js"),
    join(directory, "../dist/resources/extensions/gsd/auto.js"),
    join(directory, "../pkg/resources/extensions/gsd/auto.js"),
    join(directory, "../pkg/dist/resources/extensions/gsd/auto.js"),
  ].map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate));
};

const packageRootFromAutoPath = (autoPath: string) => {
  const marker = `${sep}dist${sep}resources${sep}extensions${sep}gsd${sep}auto.js`;
  return autoPath.endsWith(marker) ? autoPath.slice(0, -marker.length) : undefined;
};

const overflowCandidate = (autoPath: string) => {
  const packageRoot = packageRootFromAutoPath(autoPath);
  if (!packageRoot) return undefined;

  return existing(join(packageRoot, "packages/pi-ai/dist/utils/overflow.js"));
};

const autoCandidates = () => [
  existing(process.env.GSD_AUTO_MODULE_PATH),
  installedAutoCandidate(process.env.GSD_BIN_PATH),
  installedAutoCandidate(process.argv[1]),
  installedAutoCandidate(executablePath("pi")),
  installedAutoCandidate(executablePath("gsd")),
].filter((path): path is string => typeof path === "string" && path.length > 0);

const importModule = async <T>(path: string | undefined) => {
  if (!path) return undefined;

  try {
    return await import(path.startsWith("file:") ? path : pathToFileURL(path).href) as T;
  } catch {
    return undefined;
  }
};

const loadInternals = async () => {
  if (cachedInternals || loadAttempted) return cachedInternals;
  loadAttempted = true;

  for (const autoPath of autoCandidates()) {
    const auto = await importModule<GsdAutoModule>(autoPath);
    if (typeof auto?.getAutoDashboardData !== "function") continue;

    cachedInternals = {
      auto,
      journal: await importModule<GsdJournalModule>(join(dirname(autoPath), "journal.js")),
      overflow: await importModule<ContextOverflowModule>(overflowCandidate(autoPath)),
    };
    return cachedInternals;
  }

  cachedInternals = undefined;
  return undefined;
};

const normalizeErrorContext = (errorContext: Partial<GsdAutoErrorContext> | undefined) => {
  if (typeof errorContext?.message !== "string" || typeof errorContext.category !== "string") return undefined;

  return {
    message: errorContext.message,
    category: errorContext.category,
    ...(typeof errorContext.stopReason === "string" ? { stopReason: errorContext.stopReason } : {}),
    ...(typeof errorContext.isTransient === "boolean" ? { isTransient: errorContext.isTransient } : {}),
    ...(typeof errorContext.retryAfterMs === "number" ? { retryAfterMs: errorContext.retryAfterMs } : {}),
  };
};

const latestErrorContext = (journal: GsdJournalModule | undefined, basePath: string) => {
  if (!basePath || typeof journal?.queryJournal !== "function") return undefined;

  try {
    const latestRecoverable = journal
      .queryJournal(basePath, { eventType: "unit-end" })
      .reverse()
      .find((entry) => entry.data?.status === "cancelled" || entry.data?.status === "blocked" || entry.data?.status === "failed");

    return latestRecoverable ? normalizeErrorContext(latestRecoverable.data?.errorContext) : undefined;
  } catch {
    return undefined;
  }
};

export const setGsdAutoSnapshotReaderForTests = (reader: SnapshotReader | undefined) => {
  overrideReader = reader;
};

export const setContextOverflowDetectorForTests = (detector: ContextOverflowDetector | undefined) => {
  overrideContextOverflowDetector = detector;
};

export const importInstalledGsdModule = async <T>(relativePath: string) => {
  for (const autoPath of autoCandidates()) {
    const packageRoot = packageRootFromAutoPath(autoPath);
    const module = await importModule<T>(packageRoot ? join(packageRoot, relativePath) : undefined);
    if (module) return module;
  }

  return undefined;
};

export const readGsdAutoSnapshot = async () => {
  if (overrideReader) return overrideReader();

  const internals = await loadInternals();
  const snapshot = internals?.auto?.getAutoDashboardData?.();
  if (!snapshot) return undefined;

  const basePath = typeof snapshot.basePath === "string" ? snapshot.basePath : "";

  return {
    active: snapshot.active === true,
    paused: snapshot.paused === true,
    stepMode: snapshot.stepMode === true,
    basePath,
    errorContext: latestErrorContext(internals.journal, basePath),
  };
};

export const isContextOverflow = async (message: unknown, contextWindow?: number) => {
  if (overrideContextOverflowDetector) return overrideContextOverflowDetector(message, contextWindow);

  const detector = (await loadInternals())?.overflow?.isContextOverflow;
  return typeof detector === "function" && detector(message, contextWindow);
};
