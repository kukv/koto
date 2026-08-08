import { spawn } from "node:child_process";

/** Claude Code CLI (claude) が PATH 上で実行可能か */
export function isCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** claude -p --output-format json を実行し、標準出力(結果 JSON)をそのまま返す */
export function runClaudeCli(prompt: string, model?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json"];
    if (model) args.push("--model", model);
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `claude CLI の起動に失敗しました (${err.message})。Claude Code をインストールしてください`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI error (exit ${code}): ${(stderr || stdout).slice(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
