import test from "node:test";
import assert from "node:assert/strict";
import { discoverXyDashboardAssets } from "../src/lib/xy-public-asset-paths.ts";

test("XY production index's unquoted script src attributes are discovered", () => {
  const html = '<script type=text/javascript src=./static/js/app.32bcd15e13b8e85ca349.js></script>'
    + '<script src="./static/js/vendor.js"></script>'
    + "<link href=./static/css/styles.css rel=stylesheet>"
    + '<script src=https://evil.example/exfil.js></script>';
  const found = discoverXyDashboardAssets(html, "https://www.xynetweb.com/");
  assert.deepEqual(found.sort(), [
    "https://www.xynetweb.com/static/js/app.32bcd15e13b8e85ca349.js",
    "https://www.xynetweb.com/static/js/vendor.js",
  ]);
});

test("only vendor Javascript assets are followed", () => {
  const html = '<script src=https://notxynetweb.com/a.js></script>'
    + '<script src=/static/js/app.js?cache=abc></script>'
    + '<img src=./static/logo.png>';
  const found = discoverXyDashboardAssets(html, "https://www.xynetweb.com/");
  assert.deepEqual(found, ["https://www.xynetweb.com/static/js/app.js?cache=abc"]);
});
