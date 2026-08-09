// バンドルしたサーバを起動し、initialize と tools/list が正常に返ることを確認する。
// require シムの漏れや外部化漏れといったバンドル固有の失敗は通常のテストでは検出できないため、
// リリース前のゲートとして必要。DB には接続しない。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 30_000;

const bundlePath = join(dirname(dirname(fileURLToPath(import.meta.url))), "koto-mcp.mjs");

let finished = false;

function fail(message) {
  if (finished) return;
  finished = true;
  console.error(`smoke: ${message}`);
  process.exit(1);
}

function pass(message) {
  finished = true;
  console.log(`smoke: ${message}`);
  process.exit(0);
}

const child = spawn(process.execPath, [bundlePath], {
  env: {
    ...process.env,
    DATABASE_URL: "postgres://smoke:smoke@127.0.0.1:1/smoke",
    KOTO_REVIEWER: "smoke",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const timer = setTimeout(() => {
  child.kill("SIGKILL");
  fail(`${TIMEOUT_MS}ms 以内に応答がありませんでした`);
}, TIMEOUT_MS);
timer.unref();

child.on("error", (err) => fail(`起動できませんでした: ${err.message}`));
child.on("exit", (code) => fail(`応答を返す前に終了しました (code=${code})`));

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`JSON-RPC として解釈できない出力: ${line}`);
      return;
    }
    if (message.id !== 2) continue;
    const tools = message.result?.tools;
    if (!Array.isArray(tools)) {
      fail(`tools/list が失敗しました: ${line}`);
      return;
    }
    if (tools.length === 0) {
      fail("ツールが1本も返りませんでした");
      return;
    }
    child.kill("SIGKILL");
    pass(`ツール ${tools.length} 本を確認しました`);
  }
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  })}\n`,
);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
