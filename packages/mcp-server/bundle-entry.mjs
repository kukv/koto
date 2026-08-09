// esbuild のバンドル用エントリ。
// dist/mcp-server.js を直接エントリにすると、その先頭の shebang が banner の後ろ(2行目)に
// 置かれて構文エラーになるため、shebang を持たないこのファイルを噛ませる。
import "./dist/mcp-server.js";
