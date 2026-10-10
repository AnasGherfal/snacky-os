import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync("src/app/routes/page.tsx", "utf8");
const operator = fs.readFileSync("src/app/operator/routes/page.tsx", "utf8");
const operatorHome = fs.readFileSync("src/app/operator/page.tsx", "utf8");
const card = fs.readFileSync("src/components/operator/OwnerQaRouteCard.tsx", "utf8");
const qaPage = fs.readFileSync("src/app/operator/routes/qa-real/page.tsx", "utf8");

test("test route is pinned on main Routes page, not only operator page or Testing Lab", () => {
  assert.match(main, /<OwnerQaRouteCard locale=\{locale\} \/>/);
  assert.match(main, /hasRole\(profile, "owner"\)/);
  assert.match(main, /<PageHeader/);
});

test("test route is also clearly visible at top of Operator Routes and operator home", () => {
  assert.match(operator, /<OwnerQaRouteCard locale=\{locale\} \/>/);
  assert.match(operatorHome, /<OwnerQaRouteCard locale=\{locale\} \/>/);
  assert.match(operator, /hasRole\(profile, "owner"\)/);
  assert.match(operatorHome, /hasRole\(profile, "owner"\)/);
});

test("all navigation points to the same safe owner-only genuine machine QA route", () => {
  assert.match(card, /href="\/operator\/routes\/qa-real"/);
  assert.match(card, /Test Route — HT Mall & Khalij University/);
  assert.match(card, /SAFE TEST · NO WRITES/);
  assert.match(card, /Do not pass this off as an active database route/);
  assert.match(qaPage, /hasRole\(profile, "owner"\)/);
  assert.doesNotMatch(card, /onClick|\bfetch\(|storage\.from|\.insert\(|\.update\(/);
});
