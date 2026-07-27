from pathlib import Path

path = Path('src/app/routes/[id]/edit/RouteItemEditor.tsx')
source = path.read_text(encoding='utf-8')
old = '''              <button
                key={product.id}
                type="button"
                className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-start hover:bg-emerald-50 focus:bg-emerald-50 focus:outline-none"
                onClick={() => chooseProduct(product)}
              >'''
new = '''              <button
                key={product.id}
                type="button"
                className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-start hover:bg-emerald-50 focus:bg-emerald-50 focus:outline-none"
                onPointerDown={(event) => {
                  // Keep the search input focused until selection is committed.
                  // Mobile Safari/Chrome can fire blur before click and unmount this list.
                  event.preventDefault();
                  chooseProduct(product);
                }}
                onClick={(event) => {
                  // Keyboard activation does not always produce pointerdown.
                  if (event.detail === 0) chooseProduct(product);
                }}
              >'''
if old not in source:
    raise SystemExit('Product picker button target not found')
source = source.replace(old, new, 1)
path.write_text(source, encoding='utf-8')

test = Path('scripts/test-route-product-picker-tap.mjs')
test.write_text('''import assert from "node:assert/strict";\nimport fs from "node:fs";\nimport test from "node:test";\n\nconst editor = fs.readFileSync("src/app/routes/[id]/edit/RouteItemEditor.tsx", "utf8");\n\ntest("route product search commits touch selection before blur closes results", () => {\n  assert.match(editor, /onPointerDown=\\{\\(event\\) => \\{/);\n  assert.match(editor, /event\\.preventDefault\\(\\);[\\s\\S]*?chooseProduct\\(product\\)/);\n  assert.match(editor, /event\\.detail === 0/);\n});\n''', encoding='utf-8')
