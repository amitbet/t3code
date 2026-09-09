import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
  readonly planType?: string | null | undefined;
}): ServerProviderUsageLimits {
  const planType = input.planType?.trim();
  return {
    checkedAt: input.checkedAt,
    windows: sortWindows(input.windows),
    ...(planType ? { planType } : {}),
  };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * Codex derives `resetsAt` from a relative `resets_in_seconds` at the moment
 * of each read, so two reports of the same quota window disagree by a few
 * seconds. A genuinely new window moves the boundary by roughly its own
 * duration, so anything inside this slack is the same window.
 */
const RESET_WINDOW_JITTER_MS = 5 * 60_000;

function compareResetWindows(
  incoming: string | undefined,
  existing: string | undefined,
): "earlier" | "same" | "later" {
  if (incoming === undefined || existing === undefined) {
    return "same";
  }
  const incomingMs = Date.parse(incoming);
  const existingMs = Date.parse(existing);
  if (!Number.isFinite(incomingMs) || !Number.isFinite(existingMs)) {
    return incoming === existing ? "same" : "later";
  }
  const delta = incomingMs - existingMs;
  if (Math.abs(delta) <= RESET_WINDOW_JITTER_MS) {
    return "same";
  }
  return delta < 0 ? "earlier" : "later";
}

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const windowOrder =
      existing === undefined ? "later" : compareResetWindows(window.resetsAt, existing.resetsAt);
    // Usage is monotonic inside one quota window. Sparse notifications from
    // older Codex sessions can arrive after a newer snapshot, so never rewind
    // a reset boundary or lower a percentage unless the provider identifies a
    // later reset window. A full probe can still make authoritative corrections.
    if (
      existing !== undefined &&
      (windowOrder === "earlier" ||
        (windowOrder === "same" && window.usedPercent < existing.usedPercent))
    ) {
      continue;
    }
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      // Inside one window the provider's reset time drifts by a few seconds
      // between reads; keep the first one seen so the snapshot does not churn.
      ...(existing?.resetsAt !== undefined &&
      (window.resetsAt === undefined || windowOrder === "same")
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
      ...(window.detail === undefined && existing?.detail !== undefined
        ? { detail: existing.detail }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    return previous;
  }
  return makeUsageLimits({
    checkedAt: input.checkedAt,
    windows: merged.values(),
    planType: previous?.planType,
  });
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins &&
    a.detail === b.detail
  );
}

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so the last good snapshot stays; `unsupported` is
 * authoritative and replaces them.
 *
 * A provider that does not include usage in its status probe leaves the last
 * good snapshot alone. This matters for Cursor, whose usage comes from a
 * separate best-effort dashboard read. A successful probe also cannot replace
 * a runtime update observed after that probe began.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (probed === undefined) {
    return published;
  }
  if (
    published !== undefined &&
    published.unavailable === undefined &&
    probed.unavailable === undefined &&
    published.checkedAt > probed.checkedAt
  ) {
    return published;
  }
  return probed;
}
