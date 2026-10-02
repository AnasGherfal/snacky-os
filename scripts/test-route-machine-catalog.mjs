import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRouteMachineCatalog } from "../src/lib/route-machine-catalog.ts";

test("route catalog uses Snacky name and does not manufacture an unknown location", () => {
  const [machine] = buildRouteMachineCatalog([{
    id: "machine-1",
    name: "HTMall",
    machine_code: "SNK-2509000371",
    vms_machine_id: "2509000371",
    location: null,
  }]);

  assert.equal(machine.name, "HTMall");
  assert.equal(machine.location_name, null);
});

test("route catalog falls back to the XY machine name before its code", () => {
  const [machine] = buildRouteMachineCatalog([{
    id: "machine-2",
    name: null,
    machine_code: "SNK-2411000046",
    vms_raw_metadata: { raw: { jqmc: "HospAlmoa" } },
    location: null,
  }]);

  assert.equal(machine.name, "HospAlmoa");
  assert.equal(machine.machine_code, "SNK-2411000046");
});

test("route catalog uses the machine code only when Snacky and XY names are missing", () => {
  const [machine] = buildRouteMachineCatalog([{
    id: "machine-3",
    name: "Unknown machine",
    machine_code: "SNK-2503000216",
    vms_raw_metadata: { raw: { jqmc: "" } },
  }]);

  assert.equal(machine.name, "SNK-2503000216");
  assert.equal(machine.location_name, null);
});

test("route catalog treats a serial saved as name as a fallback behind the XY name", () => {
  const [machine] = buildRouteMachineCatalog([{
    id: "machine-4",
    name: "SNK-2509000371",
    machine_code: "SNK-2509000371",
    vms_raw_metadata: { raw: { jqmc: "HTMall" } },
    location: null,
  }]);

  assert.equal(machine.name, "HTMall");
  assert.equal(machine.machine_code, "SNK-2509000371");
});

test("operator pickup list loads real machine names and keeps the code secondary", async () => {
  const [api, page] = await Promise.all([
    readFile(new URL("../src/app/api/operator/routes/[id]/pick-list/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/operator/routes/[id]/pick-list/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(api, /machine_display_name, machine_code, location_id, vms_machine_id, vms_location_name, vms_raw_metadata/);
  assert.match(api, /buildRouteMachineCatalog/);
  assert.match(api, /locationName: catalog\?\.location_name \?\? machineName/);
  assert.match(page, /\$\{group\.machineName\}/);
  assert.match(page, /group\.machineCode !== group\.machineName/);
});
