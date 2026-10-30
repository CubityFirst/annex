import { describe, it, expect } from "vitest";
import { buildInviteMeta } from "./index";

describe("buildInviteMeta", () => {
  it("builds a contextual title from the project name", () => {
    const { pageTitle } = buildInviteMeta({ projectName: "Acme Docs", ownerName: "Jo", role: "editor" });
    expect(pageTitle).toBe("Join Acme Docs on Annex");
  });

  it("uses 'an' before vowel-initial role labels (editor, admin)", () => {
    expect(buildInviteMeta({ projectName: "P", ownerName: "Jo", role: "editor" }).description)
      .toBe("Jo invited you to collaborate on P as an editor.");
    expect(buildInviteMeta({ projectName: "P", ownerName: "Jo", role: "admin" }).description)
      .toBe("Jo invited you to collaborate on P as an admin.");
  });

  it("uses 'a' before consonant-initial role labels (viewer)", () => {
    expect(buildInviteMeta({ projectName: "P", ownerName: "Jo", role: "viewer" }).description)
      .toBe("Jo invited you to collaborate on P as a viewer.");
  });

  it("expands the 'limited' role to a friendly label", () => {
    expect(buildInviteMeta({ projectName: "P", ownerName: "Jo", role: "limited" }).description)
      .toBe("Jo invited you to collaborate on P as a limited member.");
  });

  it("falls back to 'member' for an unknown role", () => {
    expect(buildInviteMeta({ projectName: "P", ownerName: "Jo", role: "wizard" }).description)
      .toBe("Jo invited you to collaborate on P as a member.");
  });
});
