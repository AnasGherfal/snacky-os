import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = p => readFileSync(p, "utf8");

test("operator mobile tab opens sealed-bag deposit directly", () => {
  const source = read("src/lib/role-mobile-navigation.ts");
  assert.match(source, /href: "\/cash-handling\/deposit", en: "Deposit", ar: "إيداع الأكياس"/);
});

test("operator desktop sidebar and home have explicit deposit bag entry", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  const home = read("src/app/operator/page.tsx");
  assert.match(sidebar, /href: "\/cash-handling\/deposit", icon: HandCoins/);
  assert.match(home, /href="\/cash-handling\/deposit"/);
});

test("operator copies actual physical bag serial, not a fabricated identifier", () => {
  const screen = read("src/components/operator/RouteStopCashCard.tsx");
  const deposit = read("src/components/cash/CashDepositWorkspace.tsx");
  assert.match(screen, /الرقم المطبوع على الكيس الأمني أو الختم/);
  assert.match(screen, /لا تختار رقماً من عندك/);
  assert.match(screen, /\/cash-handling\/deposit\?id=/);
  assert.match(deposit, /cleanNumber!==box\.bag/);
});
