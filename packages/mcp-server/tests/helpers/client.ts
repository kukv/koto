import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createKotoServer } from "../../src/server.js";

/** InMemoryTransport でサーバに接続したクライアントを返す */
export async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), createKotoServer().connect(serverTransport)]);
  return client;
}

/**
 * elicitation に対応したクライアント。respond がダイアログへの応答を決める。
 * ダイアログの中身を検証したいときは respond の引数からリクエストを読む。
 */
export async function connectWithElicitation(
  respond: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>,
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, async (request) => respond(request));
  await Promise.all([client.connect(clientTransport), createKotoServer().connect(serverTransport)]);
  return client;
}

/** callTool の戻り値からテキストを取り出す */
export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}
