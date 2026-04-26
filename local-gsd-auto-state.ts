export type LocalGsdAutoRecoverable = {
  category: string;
  message: string;
};

export type LocalGsdAutoRunState = {
  active: boolean;
  stepMode: boolean;
  recoverable?: LocalGsdAutoRecoverable;
};

const localState: LocalGsdAutoRunState = {
  active: false,
  stepMode: false,
  recoverable: undefined,
};

const recoveryCategory = (status: unknown) => status === "blocked" ? "pre-execution" : "session-failed";

export function resetLocalGsdAutoRunState() {
  localState.active = false;
  localState.stepMode = false;
  localState.recoverable = undefined;
}

export function markLocalGsdAutoUnitStarted(unit: { unitType?: unknown } = {}) {
  localState.active = true;
  localState.stepMode = unit.unitType === "step";
  localState.recoverable = undefined;
}

export function markLocalGsdAutoUnitEnded(unit: { status?: unknown; unitType?: unknown; unitId?: unknown } = {}) {
  localState.active = false;

  if (unit.status === "failed" || unit.status === "blocked") {
    localState.recoverable = {
      category: recoveryCategory(unit.status),
      message: `${String(unit.unitType || "unit")} ${String(unit.unitId || "unknown")} ${unit.status}`,
    };
    return;
  }

  localState.recoverable = undefined;
}

export function clearLocalGsdAutoRecoverable() {
  localState.recoverable = undefined;
}

export function getLocalGsdAutoRunState(): LocalGsdAutoRunState {
  return { ...localState, recoverable: localState.recoverable ? { ...localState.recoverable } : undefined };
}

export function isLocalGsdAutoActive() {
  return localState.active;
}
