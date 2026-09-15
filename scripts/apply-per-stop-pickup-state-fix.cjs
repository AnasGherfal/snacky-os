const fs = require('node:fs');
const path = 'src/app/api/operator/routes/[id]/pick-list/route.ts';
let source = fs.readFileSync(path, 'utf8');
const before = `    let confirmed = Boolean(preparedBatch?.confirmedAt);\n    failingStep = "load_pickup_confirmation_state";\n    failingResource = "inventory_movements";\n    const pickMovementsResult = await readClient\n      .from("inventory_movements")\n      .select("id")\n      .eq("related_route_id", routeId)\n      .in("reason", ["storage_to_operator_bag"])\n      .limit(1);\n    if (pickMovementsResult.error) {\n      logOptionalFailure({ step: "load_pickup_confirmation_state", resource: "inventory_movements", error: pickMovementsResult.error });\n    } else {\n      confirmed = Boolean(pickMovementsResult.data?.length);\n    }\n    const isPrepared = Boolean(preparedBatch && !preparedBatch.confirmedAt && !preparedBatch.returnedToAssignedAt);`;
const after = `    // Pickup confirmation is route-wide only after every stop has left Pending.\n    // A previous stop may already have moved stock into the operator bag while\n    // later stops are still waiting to be picked. Treating any prior movement as\n    // \"confirmed\" locks those later stops out of the pickup screen.\n    let hasAnyConfirmedPickup = false;\n    failingStep = "load_pickup_confirmation_state";\n    failingResource = "inventory_movements";\n    const pickMovementsResult = await readClient\n      .from("inventory_movements")\n      .select("id")\n      .eq("related_route_id", routeId)\n      .in("reason", ["storage_to_operator_bag"])\n      .limit(1);\n    if (pickMovementsResult.error) {\n      logOptionalFailure({ step: "load_pickup_confirmation_state", resource: "inventory_movements", error: pickMovementsResult.error });\n    } else {\n      hasAnyConfirmedPickup = Boolean(pickMovementsResult.data?.length);\n    }\n    const confirmed = pendingStopCount === 0 && hasAnyConfirmedPickup;\n    const isPrepared = Boolean(preparedBatch && !preparedBatch.confirmedAt && !preparedBatch.returnedToAssignedAt);`;
if (source.includes(after)) {
  console.log('Per-stop pickup state fix already applied.');
  process.exit(0);
}
if (!source.includes(before)) throw new Error('Expected pickup confirmation block not found; refusing broad edit.');
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log('Applied per-stop pickup state fix.');
