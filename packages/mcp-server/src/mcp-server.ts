#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKotoServer } from "./server.js";

const transport = new StdioServerTransport();
await createKotoServer().connect(transport);
console.error("knowledge-base MCP server running (stdio)");
