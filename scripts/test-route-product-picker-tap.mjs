import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const editor = fs.readFileSync("src/app/routes/[id]/edit/RouteItemEditor.tsx", "utf8");

test("route product search commits touch selection before blur closes results", () => {
  assert.match(editor, /onPointerDown=\{\(event\) => \{/);
  assert.match(editor, /event\.preventDefault\(\);[\s\S]*?chooseProduct\(product\)/);
  assert.match(editor, /event\.detail === 0/);
});
