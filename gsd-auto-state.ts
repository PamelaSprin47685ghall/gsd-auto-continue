import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

type ContextOverflowModule = {
  isContextOverflow?: (message: unknown, contextWindow?: number) => boolean;
};

type ContextOverflowDetector = (message: unknown, contextWindow?: number) => boolean;

let overrideContextOverflowDetector: ContextOverflowDetector | undefined;
let cachedOverflow: ContextOverflowModule | undefined;
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

const loadOverflow = async () => {
  if (cachedOverflow || loadAttempted) return cachedOverflow;
  loadAttempted = true;

  for (const autoPath of autoCandidates()) {
    const overflow = await importModule<ContextOverflowModule>(overflowCandidate(autoPath));
    if (typeof overflow?.isContextOverflow !== "function") continue;
    cachedOverflow = overflow;
    return cachedOverflow;
  }

  cachedOverflow = undefined;
  return undefined;
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

export const isContextOverflow = async (message: unknown, contextWindow?: number) => {
  if (overrideContextOverflowDetector) return overrideContextOverflowDetector(message, contextWindow);

  const detector = (await loadOverflow())?.isContextOverflow;
  return typeof detector === "function" && detector(message, contextWindow);
};
