#!/usr/bin/env node
// Annex MCP server (stdio). stdout carries the MCP protocol, so every
// diagnostic goes to stderr - and never includes a full key.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AnnexClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { buildServer, SERVER_VERSION } from "./server.js";
import { SiteRegistry } from "./sites.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`annex-mcp: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const client = new AnnexClient(config.apiUrl, fetch, `annex-mcp/${SERVER_VERSION}`);
  const registry = new SiteRegistry(client, config.keys);
  // Resolve keys up front so the advertised tool list matches what the keys
  // can actually do. Failures don't abort startup: they show in list_sites
  // and are retried on demand.
  await registry.refresh();
  for (const s of registry.list()) {
    console.error(
      s.status === "ready"
        ? `annex-mcp: ${s.site} → "${s.name}" (${s.scope}${s.canInvite ? ", members" : ""}, role ${s.role}) via ${s.key}`
        : `annex-mcp: ${s.site} (${s.key}) unavailable: ${s.error}`,
    );
  }
  if (config.readOnly) console.error("annex-mcp: read-only mode - write tools are disabled.");

  const server = buildServer({ client, registry, readOnly: config.readOnly });
  await server.connect(new StdioServerTransport());
}

main().catch(err => {
  console.error("annex-mcp: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
