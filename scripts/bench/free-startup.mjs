#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const iterations = Number(process.env.FREE_BENCH_ITERATIONS ?? "20");
const candidates = [
  {
    args: ["dist/bin.js", "--help"],
    command: process.execPath,
    name: "node-dist-help",
    required: join(repoRoot, "dist", "bin.js"),
  },
  {
    args: ["--help"],
    command: firstBinary(),
    name: "bun-binary-help",
    required: firstBinary(),
  },
].filter((candidate) => candidate.required && existsSync(candidate.required));

const results = candidates.map((candidate) => benchmark(candidate));
process.stdout.write(`${JSON.stringify({ iterations, results }, null, 2)}\n`);

function benchmark(candidate) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const result = spawnSync(candidate.command, candidate.args, {
      cwd: repoRoot,
      stdio: "ignore",
    });
    const durationMs = performance.now() - startedAt;
    if (result.status !== 0) {
      throw new Error(`${candidate.name} failed with exit ${result.status}`);
    }
    samples.push(durationMs);
  }
  samples.sort((left, right) => left - right);
  return {
    maxMs: round(samples.at(-1) ?? 0),
    meanMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    medianMs: round(samples[Math.floor(samples.length / 2)] ?? 0),
    minMs: round(samples[0] ?? 0),
    name: candidate.name,
  };
}

function firstBinary() {
  const target = process.platform === "darwin" && process.arch === "arm64"
    ? "free-darwin-arm64"
    : undefined;
  return target ? join(repoRoot, "dist-bin", target) : undefined;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
