import { describe, it, expect } from "vitest";
import { buildProjectDetails, type ProjectDetailRow } from "./projects";

const BASE_ROW: ProjectDetailRow = {
  id: "proj_1",
  name: "Acme Docs",
  description: null,
  owner_id: "user_1",
  created_at: "2024-01-01T00:00:00.000Z",
  published_at: null,
  changelog_mode: "off",
  home_doc_id: null,
  vanity_slug: null,
  logo_square_updated_at: null,
  logo_wide_updated_at: null,
  features: 0,
  ai_enabled: 0,
  ai_summarization_type: "manual",
  graph_enabled: 0,
  published_graph_enabled: 0,
  organization_id: null,
  organization_name: null,
};

// An empty project: every aggregate sub-query returns NULL sums / no rows.
function buildEmpty(row: ProjectDetailRow = BASE_ROW) {
  return buildProjectDetails({
    project: row,
    owner: null,
    customDomain: null,
    docStats: { total: 0, published: null },
    aiSummaries: { n: 0 },
    folderCount: { n: 0 },
    fileStats: { n: 0, bytes: 0 },
    memberCounts: { accepted: null, pending: null },
    byRole: [],
    members: [],
  });
}

describe("buildProjectDetails — published flag", () => {
  it("is a draft when published_at is null", () => {
    expect(buildEmpty().profile.published).toBe(false);
  });
  it("is published when published_at is set", () => {
    const d = buildEmpty({ ...BASE_ROW, published_at: "2024-02-02T00:00:00.000Z" });
    expect(d.profile.published).toBe(true);
    expect(d.profile.published_at).toBe("2024-02-02T00:00:00.000Z");
  });
});

describe("buildProjectDetails — content stats", () => {
  it("coalesces NULL aggregates to zero for an empty project", () => {
    const d = buildEmpty();
    expect(d.content.docs).toEqual({ total: 0, published: 0, drafts: 0, with_ai_summary: 0 });
    expect(d.content.folders).toBe(0);
    expect(d.content.files).toEqual({ count: 0, total_bytes: 0 });
    expect(d.members.accepted).toBe(0);
    expect(d.members.pending).toBe(0);
  });

  it("derives drafts as total minus published", () => {
    const d = buildProjectDetails({
      project: BASE_ROW,
      owner: null,
      customDomain: null,
      docStats: { total: 10, published: 4 },
      aiSummaries: { n: 3 },
      folderCount: { n: 2 },
      fileStats: { n: 5, bytes: 2048 },
      memberCounts: { accepted: 2, pending: 1 },
      byRole: [{ role: "owner", count: 1 }, { role: "editor", count: 1 }],
      members: [],
    });
    expect(d.content.docs).toEqual({ total: 10, published: 4, drafts: 6, with_ai_summary: 3 });
    expect(d.content.files).toEqual({ count: 5, total_bytes: 2048 });
    expect(d.members).toMatchObject({ accepted: 2, pending: 1 });
  });
});

describe("buildProjectDetails — ownership & organization", () => {
  it("returns a null owner when the account is gone", () => {
    expect(buildEmpty().profile.owner).toBeNull();
  });
  it("passes through the resolved owner identity", () => {
    const d = buildProjectDetails({
      ...emptyInputs(),
      owner: { id: "user_1", name: "Ada", email: "ada@example.com" },
    });
    expect(d.profile.owner).toEqual({ id: "user_1", name: "Ada", email: "ada@example.com" });
  });
  it("is standalone with no organization", () => {
    expect(buildEmpty().organization).toBeNull();
  });
  it("reports the organization the site belongs to", () => {
    const d = buildEmpty({ ...BASE_ROW, organization_id: "org_9", organization_name: "Globex" });
    expect(d.organization).toEqual({ id: "org_9", name: "Globex" });
  });
});

describe("buildProjectDetails — settings booleans", () => {
  it("maps the 0/1 integer toggles to booleans", () => {
    const d = buildEmpty({
      ...BASE_ROW,
      features: 5,
      ai_enabled: 1,
      ai_summarization_type: "automatic",
      graph_enabled: 1,
      published_graph_enabled: 0,
    });
    expect(d.settings).toEqual({
      features: 5,
      ai_enabled: true,
      ai_summarization_type: "automatic",
      graph_enabled: true,
      published_graph_enabled: false,
    });
  });
});

describe("buildProjectDetails — members", () => {
  it("maps the accepted integer flag to a boolean per member", () => {
    const d = buildProjectDetails({
      ...emptyInputs(),
      members: [
        { id: "m1", user_id: "u1", email: "o@x.com", name: "Owner", role: "owner", accepted: 1, created_at: "2024-01-01T00:00:00.000Z" },
        { id: "m2", user_id: "u2", email: "p@x.com", name: "Pending", role: "viewer", accepted: 0, created_at: "2024-01-02T00:00:00.000Z" },
      ],
    });
    expect(d.members.list).toEqual([
      { id: "m1", user_id: "u1", email: "o@x.com", name: "Owner", role: "owner", accepted: true, created_at: "2024-01-01T00:00:00.000Z" },
      { id: "m2", user_id: "u2", email: "p@x.com", name: "Pending", role: "viewer", accepted: false, created_at: "2024-01-02T00:00:00.000Z" },
    ]);
  });
});

describe("buildProjectDetails — branding", () => {
  it("surfaces the mapped custom domain", () => {
    const d = buildProjectDetails({
      ...emptyInputs(),
      project: { ...BASE_ROW, vanity_slug: "acme" },
      customDomain: { hostname: "docs.acme.com", status: "active" },
    });
    expect(d.branding.vanity_slug).toBe("acme");
    expect(d.branding.custom_domain).toEqual({ hostname: "docs.acme.com", status: "active" });
  });
  it("has no custom domain when unmapped", () => {
    expect(buildEmpty().branding.custom_domain).toBeNull();
  });
});

// Shared zeroed inputs so individual tests only override the field under test.
function emptyInputs() {
  return {
    project: BASE_ROW,
    owner: null,
    customDomain: null,
    docStats: { total: 0, published: null },
    aiSummaries: { n: 0 },
    folderCount: { n: 0 },
    fileStats: { n: 0, bytes: 0 },
    memberCounts: { accepted: null, pending: null },
    byRole: [] as Array<{ role: string; count: number }>,
    members: [] as Parameters<typeof buildProjectDetails>[0]["members"],
  };
}
