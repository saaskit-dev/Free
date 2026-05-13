import { spawn } from "node:child_process";
import http from "node:http";

const port = Number.parseInt(process.env.FREE_WORKBENCH_PORT || "8790", 10);
const url = `http://127.0.0.1:${port}`;

const expo = spawn(
  "pnpm",
  ["exec", "expo", "start", "--web", "--port", String(port)],
  {
    env: {
      ...process.env,
      EXPO_PUBLIC_RELAY_URL: process.env.EXPO_PUBLIC_RELAY_URL || "http://127.0.0.1:8791",
      EXPO_PUBLIC_WORKBENCH_ORIGIN: process.env.EXPO_PUBLIC_WORKBENCH_ORIGIN || url,
    },
    shell: false,
    stdio: "inherit",
  },
);

let electron;
const timer = setInterval(() => {
  http
    .get(url, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode < 500 && !electron) {
        electron = spawn("pnpm", ["exec", "electron", "./electron/main.cjs"], {
          cwd: new URL("..", import.meta.url),
          env: {
            ...process.env,
            FREE_WORKBENCH_URL: url,
          },
          shell: false,
          stdio: "inherit",
        });
      }
    })
    .on("error", () => {});
}, 1000);

function shutdown() {
  clearInterval(timer);
  electron?.kill("SIGTERM");
  expo.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
