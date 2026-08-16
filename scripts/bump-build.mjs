#!/usr/bin/env node
/**
 * Increment the build number.
 *
 * The version says *what* this is and changes when someone decides it should. The build
 * number says *which build*, and answers a different question: "is the thing you are running
 * the thing I just gave you?" That question came up repeatedly while testing across two
 * machines, and the only way to answer it was comparing binary timestamps by hand.
 *
 * Kept in its own file rather than in package.json so an automatic bump never collides with a
 * hand edit to the version, and so the diff on every build is one line in a file that holds
 * nothing else.
 *
 * Run by `beforeBuildCommand`, so it counts *builds*, not dev reloads.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "build-number.json");

let current = { build: 0 };
try {
  current = JSON.parse(readFileSync(file, "utf8"));
} catch {
  // First run, or a file someone truncated. Starting from zero is better than failing a build
  // over a counter.
}

const next = { build: (Number(current.build) || 0) + 1, at: new Date().toISOString() };
writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
console.log(`build number → ${next.build}`);
