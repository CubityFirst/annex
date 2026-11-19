import { describe, it, expect } from "vitest";
import { resolvePersonalPlan, type PlanRow } from "./plan";

const FREE: PlanRow = {
  granted_plan: null,
  granted_plan_expires_at: null,
  granted_plan_started_at: null,
  personal_plan: null,
  personal_plan_status: null,
  personal_plan_started_at: null,
  personal_plan_cancel_at: null,
  personal_plan_style: null,
  personal_presence_color: null,
  personal_crit_sparkles: null,
};

const NOW = 1_000_000;

describe("resolvePersonalPlan", () => {
  it("returns free when no plan info is set", () => {
    const r = resolvePersonalPlan(FREE, NOW);
    expect(r.plan).toBe("free");
    expect(r.via).toBe("free");
    expect(r.since).toBeNull();
  });

  it("returns ink when paid plan is active", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      personal_plan: "ink",
      personal_plan_status: "active",
      personal_plan_started_at: 500,
    }, NOW);
    expect(r.plan).toBe("ink");
    expect(r.via).toBe("paid");
    expect(r.since).toBe(500);
    expect(r.status).toBe("active");
  });

  it("keeps perks active during past_due grace period", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      personal_plan: "ink",
      personal_plan_status: "past_due",
      personal_plan_started_at: 500,
    }, NOW);
    expect(r.plan).toBe("ink");
    expect(r.status).toBe("past_due");
  });

  it("trialing counts as active", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      personal_plan: "ink",
      personal_plan_status: "trialing",
      personal_plan_started_at: 500,
    }, NOW);
    expect(r.plan).toBe("ink");
  });

  it("returns free when paid plan is canceled", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      personal_plan: "ink",
      personal_plan_status: "canceled",
      personal_plan_started_at: 500,
    }, NOW);
    expect(r.plan).toBe("free");
    expect(r.via).toBe("free");
  });

  it("returns free when paid plan is unpaid or incomplete_expired", () => {
    for (const status of ["unpaid", "incomplete_expired", "incomplete"]) {
      const r = resolvePersonalPlan({
        ...FREE,
        personal_plan: "ink",
        personal_plan_status: status,
        personal_plan_started_at: 500,
      }, NOW);
      expect(r.plan).toBe("free");
    }
  });

  it("granted plan with NULL expiry beats no paid plan", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      granted_plan: "ink",
      granted_plan_expires_at: null,
    }, NOW);
    expect(r.plan).toBe("ink");
    expect(r.via).toBe("granted");
    expect(r.status).toBe("granted");
  });

  it("granted plan with future expiry beats no paid plan", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      granted_plan: "ink",
      granted_plan_expires_at: NOW + 1000,
    }, NOW);
    expect(r.plan).toBe("ink");
    expect(r.via).toBe("granted");
  });

  it("granted plan with past expiry falls back to paid", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      granted_plan: "ink",
      granted_plan_expires_at: NOW - 1,
      personal_plan: "ink",
      personal_plan_status: "active",
      personal_plan_started_at: 500,
    }, NOW);
    expect(r.plan).toBe("ink");
    expect(r.via).toBe("paid");
  });

  it("granted plan with past expiry and no paid plan falls back to free", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      granted_plan: "ink",
      granted_plan_expires_at: NOW - 1,
    }, NOW);
    expect(r.plan).toBe("free");
  });

  it("granted plan beats paid plan even when both are active", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      granted_plan: "ink",
      granted_plan_expires_at: null,
      personal_plan: "ink",
      personal_plan_status: "active",
      personal_plan_started_at: 500,
    }, NOW);
    expect(r.via).toBe("granted");
  });

  it("unknown plan strings normalize to free", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      personal_plan: "mystery_tier",
      personal_plan_status: "active",
    }, NOW);
    expect(r.plan).toBe("free");
  });

  it("surfaces cancelAt for paid plans pending cancellation", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      personal_plan: "ink",
      personal_plan_status: "active",
      personal_plan_started_at: 100,
      personal_plan_cancel_at: NOW + 86400_000,
    }, NOW);
    expect(r.plan).toBe("ink");
    expect(r.cancelAt).toBe(NOW + 86400_000);
  });

  it("granted plans never carry a cancelAt", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      granted_plan: "ink",
      granted_plan_expires_at: null,
      personal_plan_cancel_at: NOW + 86400_000,
    }, NOW);
    expect(r.cancelAt).toBeNull();
  });

  it("granted plans surface granted_plan_started_at as since", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      granted_plan: "ink",
      granted_plan_expires_at: null,
      granted_plan_started_at: 12345,
    }, NOW);
    expect(r.via).toBe("granted");
    expect(r.since).toBe(12345);
  });

  it("crit sparkles default to true for paid Ink users (NULL column)", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      personal_plan: "ink",
      personal_plan_status: "active",
    }, NOW);
    expect(r.critSparkles).toBe(true);
  });

  it("crit sparkles respect explicit 0 (off) for Ink users", () => {
    const r = resolvePersonalPlan({
      ...FREE,
      personal_plan: "ink",
      personal_plan_status: "active",
      personal_crit_sparkles: 0,
    }, NOW);
    expect(r.critSparkles).toBe(false);
  });

  it("crit sparkles are always false for free users", () => {
    const r = resolvePersonalPlan({ ...FREE, personal_crit_sparkles: 1 }, NOW);
    expect(r.plan).toBe("free");
    expect(r.critSparkles).toBe(false);
  });
});
