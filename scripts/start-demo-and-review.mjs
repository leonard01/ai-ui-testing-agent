import { spawn } from "node:child_process";

const servers = [
  { label: "Demo", file: "dist/demo/server.js", url: "http://127.0.0.1:3000" },
  { label: "Review", file: "dist/review-server.js", url: "http://127.0.0.1:3100" },
];
const children = [];
let shuttingDown = false;

function stopAll(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
  // Child processes have piped output and keep this process open until exited.
  process.exitCode = exitCode;
}

for (const server of servers) {
  const child = spawn(process.execPath, [server.file], {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
    windowsHide: false,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`[${server.label}] failed to start:`, error.message);
    stopAll(1);
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[${server.label}] exited (${signal ?? code}). Stopping other server.`);
      stopAll(code && code !== 0 ? code : 1);
    }
  });
  console.log(`[${server.label}] ${server.url}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopAll());
}
