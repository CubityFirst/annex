import { describe, it, expect } from "vitest";
import { buildAgentPrompt } from "./OAuthClientsPage";

const BASE = {
  clientId: "client-123",
  redirectUris: ["https://app.example.com/callback"],
  scopes: "openid profile email",
  isPublic: false,
};

describe("buildAgentPrompt", () => {
  it("NEVER inlines a plaintext secret, even right after create/rotate (AF-S5)", () => {
    const prompt = buildAgentPrompt({ ...BASE, hasFreshSecret: true });
    expect(prompt).toContain("client-123");
    expect(prompt).toContain("paste it from your secret manager");
    // No secret-looking material beyond the placeholder instruction.
    expect(prompt).not.toMatch(/client_secret: [A-Za-z0-9_-]{20,}/);
  });

  it("points at rotate for an existing confidential client", () => {
    const prompt = buildAgentPrompt(BASE);
    expect(prompt).toContain("rotate this client");
  });

  it("marks public clients as secretless PKCE-only", () => {
    const prompt = buildAgentPrompt({ ...BASE, isPublic: true, hasFreshSecret: true });
    expect(prompt).toContain("client_secret: (none - public client, PKCE only)");
    expect(prompt).not.toContain("paste it from your secret manager");
  });

  it("adds the roles-gating requirement only when the roles scope is granted", () => {
    expect(buildAgentPrompt(BASE)).not.toContain('roles.includes("admin")');
    expect(buildAgentPrompt({ ...BASE, scopes: "openid profile email roles" })).toContain(
      'roles.includes("admin")',
    );
  });

  it("lists extra registered redirect URIs", () => {
    const prompt = buildAgentPrompt({
      ...BASE,
      redirectUris: ["https://a.example/cb", "https://b.example/cb"],
    });
    expect(prompt).toContain("https://a.example/cb");
    expect(prompt).toContain("also registered: https://b.example/cb");
  });
});
