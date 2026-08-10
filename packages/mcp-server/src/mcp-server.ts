#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkNaming } from "./check-naming.js";
import { createKotoServer } from "./server.js";

// PostToolUse フックから同じ配布物を使えるようにする(フックは MCP 経由で DB を引けないため)
if (process.argv[2] === "check-naming") {
  // fs/promises の readFile は fd(数値)を型上受け付けないため、fd を扱える同期版を使う
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    // 標準入力が読めなくてもフェイルオープンの一部として扱う
  }
  process.exit(await checkNaming(stdin));
}

const transport = new StdioServerTransport();
await createKotoServer().connect(transport);
console.error("knowledge-base MCP server running (stdio)");
