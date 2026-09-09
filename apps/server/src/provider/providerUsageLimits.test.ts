import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("ignores a stale reset window and a regression within the current window", () => {
    const staleReset = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:01:00.000Z",
      update: {
        windows: [
          {
            ...session,
            usedPercent: 95,
            resetsAt: "2026-09-03T13:00:00.000Z",
          },
        ],
      },
    });
    expect(staleReset).toBe(published);

    const regressed = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:01:00.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 5 }],
      },
    });
    expect(regressed).toBe(published);
  });

  it("treats a reset time that only jitters by seconds as the same window", () => {
    // A status probe computed the boundary two seconds later than the turn
    // notifications do. Those notifications must still land, and the snapshot
    // keeps the boundary it already had so nothing churns.
    const probed = {
      checkedAt,
      windows: [
        { ...session, usedPercent: 9, resetsAt: "2026-09-03T14:00:02.000Z" },
        { ...weekly, usedPercent: 32, resetsAt: "2026-09-09T14:00:02.000Z" },
      ],
    };
    const next = applyUsageLimitsUpdate({
      previous: probed,
      checkedAt: "2026-09-03T12:30:00.000Z",
      update: {
        windows: [
          { ...session, usedPercent: 97, resetsAt: "2026-09-03T14:00:00.000Z" },
          { ...weekly, usedPercent: 46, resetsAt: "2026-09-09T14:00:00.000Z" },
        ],
      },
    });
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:30:00.000Z",
      windows: [
        { ...session, usedPercent: 97, resetsAt: "2026-09-03T14:00:02.000Z" },
        { ...weekly, usedPercent: 46, resetsAt: "2026-09-09T14:00:02.000Z" },
      ],
    });
    // The jittered repeat of an unchanged reading is still a no-op.
    expect(
      applyUsageLimitsUpdate({
        previous: next,
        checkedAt: "2026-09-03T12:30:05.000Z",
        update: {
          windows: [{ ...session, usedPercent: 97, resetsAt: "2026-09-03T14:00:01.000Z" }],
        },
      }),
    ).toBe(next);
  });

  it("accepts a lower percentage after the provider advances the reset window", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt: "2026-09-03T14:00:01.000Z",
        update: {
          windows: [
            {
              ...session,
              usedPercent: 5,
              resetsAt: "2026-09-03T19:00:00.000Z",
            },
          ],
        },
      }),
    ).toEqual({
      checkedAt: "2026-09-03T14:00:01.000Z",
      windows: [{ ...session, usedPercent: 5, resetsAt: "2026-09-03T19:00:00.000Z" }, weekly],
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });

  it("keeps runtime-only usage when a provider status probe omits it", () => {
    expect(resolveUsageLimitsAfterProbe({ published, probed: undefined })).toBe(published);
  });

  it("does not let a probe overwrite a runtime update that landed after it began", () => {
    const runtimeUpdate = {
      ...published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 60 }, weekly],
    };
    const olderProbe = {
      ...published,
      checkedAt: "2026-09-03T12:00:01.000Z",
      windows: [{ ...session, usedPercent: 10 }, weekly],
    };
    expect(resolveUsageLimitsAfterProbe({ published: runtimeUpdate, probed: olderProbe })).toBe(
      runtimeUpdate,
    );
  });
});
