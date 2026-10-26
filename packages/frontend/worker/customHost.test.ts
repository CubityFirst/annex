import { describe, it, expect } from "vitest";
import worker, { isAppHost, buildSitemapXml, APP_ROBOTS_TXT, type Env } from "./index";

describe("isAppHost", () => {
  it("treats our app, preview, and local-dev hosts as app hosts", () => {
    expect(isAppHost("localhost")).toBe(true);
    expect(isAppHost("127.0.0.1")).toBe(true);
    expect(isAppHost("mymachine.local")).toBe(true);
    expect(isAppHost("cubityfir.st")).toBe(true);
    expect(isAppHost("docs.cubityfir.st")).toBe(true);
    expect(isAppHost("annex-frontend.example.workers.dev")).toBe(true);
    expect(isAppHost("preview.pages.dev")).toBe(true);
  });

  it("treats everything else as a mapped custom domain", () => {
    expect(isAppHost("docs.acme.com")).toBe(false);
    expect(isAppHost("publish.yourannex.com")).toBe(false);
    expect(isAppHost("notcubityfir.st")).toBe(false);
  });
});

describe("buildSitemapXml", () => {
  it("lists the root plus every doc's clean URL", () => {
    const xml = buildSitemapXml("docs.acme.com", null, [{ id: "d1" }, { id: "d2" }]);
    expect(xml).toContain("<loc>https://docs.acme.com/</loc>");
    expect(xml).toContain("<loc>https://docs.acme.com/d1</loc>");
    expect(xml).toContain("<loc>https://docs.acme.com/d2</loc>");
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  });

  it("lists the home doc only as the root URL, not twice", () => {
    const xml = buildSitemapXml("docs.acme.com", "home", [{ id: "home" }, { id: "other" }]);
    expect(xml).toContain("<loc>https://docs.acme.com/</loc>");
    expect(xml).not.toContain("<loc>https://docs.acme.com/home</loc>");
    expect(xml).toContain("<loc>https://docs.acme.com/other</loc>");
  });

  it("prefers a doc's custom slug over its id", () => {
    const xml = buildSitemapXml("docs.acme.com", "home", [
      { id: "home", slug: "welcome" },
      { id: "d1", slug: "getting-started" },
      { id: "d2", slug: null },
    ]);
    // The home doc stays collapsed to "/" even when it has a slug.
    expect(xml).toContain("<loc>https://docs.acme.com/</loc>");
    expect(xml).not.toContain("welcome");
    expect(xml).toContain("<loc>https://docs.acme.com/getting-started</loc>");
    expect(xml).not.toContain("<loc>https://docs.acme.com/d1</loc>");
    expect(xml).toContain("<loc>https://docs.acme.com/d2</loc>");
  });
});

describe("app-host robots.txt", () => {
  const env = {} as Env; // the robots path never touches a binding

  it("is served on our own hosts", async () => {
    const res = await worker.fetch(new Request("https://docs.cubityfir.st/robots.txt"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe(APP_ROBOTS_TXT);
  });

  it("blocks the app, auth flows and private API but keeps published sites crawlable", () => {
    for (const path of ["/api/", "/oauth/", "/login", "/register", "/settings", "/projects/", "/dashboard", "/invite/"]) {
      expect(APP_ROBOTS_TXT).toContain(`Disallow: ${path}\n`);
    }
    expect(APP_ROBOTS_TXT).toContain("Allow: /api/public/\n");
    expect(APP_ROBOTS_TXT).not.toMatch(/Disallow: \/s\//);
    expect(APP_ROBOTS_TXT).not.toMatch(/Disallow: \/\n/);
  });
});
