// The demo's `web` service: answers every request with the worktree it runs
// in, its own port, and the shared db's port. devtrees injects both ports.
import { createServer } from "node:http";
import { basename } from "node:path";

const { WEB_PORT, DB_PORT } = process.env;
const worktree = basename(process.cwd());

createServer((_req, res) => {
  res.end(`web from ${worktree} on :${WEB_PORT}, db on :${DB_PORT}\n`);
}).listen(Number(WEB_PORT));
