import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const sorter = read("src/lib/route-pickup-checklist.ts");
const routeCreate = read("src/app/routes/new/RouteCreateForm.tsx");
const operatorPickup = read("src/app/operator/routes/[id]/pick-list/page.tsx");

test("route product groups follow Snacky's physical pickup sequence", () => {
  assert.match(
    sorter,
    /const GROUP_ORDER:[\s\S]*"chips",[\s\S]*"drinks",[\s\S]*"chocolates",[\s\S]*"candy",[\s\S]*"rolls_bakery",[\s\S]*"almarai_dairy",[\s\S]*"other",[\s\S]*"water"/,
  );
});

test("chips are prioritized Mr Crunch, Doritos, then Spuds", () => {
  assert.match(sorter, /const SPUDS_ALIASES = \["spuds"\]/);
  assert.match(
    sorter,
    /if \(groupKey === "chips"\)[\s\S]*MR_CRUNCH_ALIASES\)\) return 0;[\s\S]*DORITOS_ALIASES\)\) return 1;[\s\S]*SPUDS_ALIASES\)\) return 2;/,
  );
});

test("drinks are prioritized Pepsi, Schweppes, Vitrac, Mr Power, then X!R", () => {
  assert.match(sorter, /const VITRAC_ALIASES = \["vitrac"\]/);
  assert.match(sorter, /const MR_POWER_ALIASES = \["mr power", "mr\. power"\]/);
  assert.match(
    sorter,
    /if \(groupKey === "drinks"\)[\s\S]*PEPSI_ALIASES\)\) return 0;[\s\S]*SCHWEPPES_ALIASES\)\) return 1;[\s\S]*VITRAC_ALIASES\)\) return 2;[\s\S]*MR_POWER_ALIASES\)\) return 3;[\s\S]*XIR_ALIASES\)\) return 4;/,
  );
});

test("chocolates follow Luppo, Laviva, Maltesers, rolls, Kinder, Said, Maestro, Milka, Gardena", () => {
  assert.match(sorter, /const LUPPO_ALIASES = \["luppo", "lupo"\]/);
  assert.match(sorter, /const LAVIVA_ALIASES = \["laviva"\]/);
  assert.match(sorter, /const MALTESERS_ALIASES = \["maltesers", "malteser"\]/);
  assert.match(sorter, /const ROLL_ALIASES = \["wafer roll", "roll", "rolls", "رول"\]/);
  assert.match(
    sorter,
    /if \(groupKey === "chocolates"\)[\s\S]*LUPPO_ALIASES\)\) return 0;[\s\S]*LAVIVA_ALIASES\)\) return 1;[\s\S]*MALTESERS_ALIASES\)\) return 2;[\s\S]*ROLL_ALIASES\)\) return 3;[\s\S]*KINDER_ALIASES\)\) return 4;[\s\S]*SAID_ALIASES\)\) return 5;[\s\S]*MAESTRO_ALIASES\)\) return 6;[\s\S]*MILKA_ALIASES\)\) return 7;[\s\S]*GARDENA_ALIASES\)\) return 8;/,
  );
});

test("Bebeto is treated as jelly sweets and water stays last", () => {
  assert.match(sorter, /const BEBETO_ALIASES = \["bebeto"\]/);
  assert.match(sorter, /if \(includesAny\(text, BEBETO_ALIASES\) \|\| includesAny\(text, CANDY_KEYWORDS\)\) return "candy";/);
  assert.match(sorter, /const WATER_KEYWORDS/);
  assert.match(sorter, /"other",[\s\S]*"water"/);
});

test("wafer rolls are chocolate priority, not bakery priority", () => {
  const bakeryLine = sorter.match(/const BAKERY_KEYWORDS = \[(.*?)\];/)?.[1] ?? "";
  assert.doesNotMatch(bakeryLine, /"roll"|"rolls"|"رول"/);
  assert.match(sorter, /includesAny\(text, ROLL_ALIASES\)[\s\S]*return "chocolates"/);
});

test("route creation and operator pickup both use the shared sorter", () => {
  assert.match(routeCreate, /comparePickupProductRows/);
  assert.match(operatorPickup, /import \{ comparePickupProductRows \} from "@\/lib\/route-pickup-checklist"/);
  assert.match(operatorPickup, /\.sort\(\(a, b\) => comparePickupProductRows\(a, b\)\)/);
});
