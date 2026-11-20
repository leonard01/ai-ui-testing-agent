import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../../demo/index.html", import.meta.url));
const server = createServer((request, response) => {
  if (request.url === "/" || request.url === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  } else if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  } else {
    response.writeHead(404);
    response.end("Not found");
  }
});
server.listen(3000, "127.0.0.1", () =>
  console.log("Demo: http://127.0.0.1:3000"),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close());
