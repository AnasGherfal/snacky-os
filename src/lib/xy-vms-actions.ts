"use server";

import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import {
  syncXyAll,
  syncXyMachineGoods,
  syncXyMachines,
  syncXyMachineStatus,
  syncXyProducts,
  testXyOfficialApi,
  testXyUnsignedMerchant,
} from "@/lib/xy-vms-sync";
import { testXyWebDashboard } from "@/lib/xy-web-sync";

async function requireOwnerAdmin() {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  return profile;
}

export async function syncXyMachinesAction() {
  const profile = await requireOwnerAdmin();
  await syncXyMachines({ profile });
}

export async function syncXyProductsAction() {
  const profile = await requireOwnerAdmin();
  await syncXyProducts({ profile });
}

export async function syncXyMachineGoodsAction() {
  const profile = await requireOwnerAdmin();
  await syncXyMachineGoods({ profile });
}

export async function syncXyMachineStatusAction() {
  const profile = await requireOwnerAdmin();
  await syncXyMachineStatus({ profile });
}

export async function syncXyAllAction() {
  const profile = await requireOwnerAdmin();
  await syncXyAll({ profile });
}

export async function testXyOfficialApiAction() {
  const profile = await requireOwnerAdmin();
  await testXyOfficialApi({ profile });
}

export async function testXyUnsignedMerchantAction() {
  const profile = await requireOwnerAdmin();
  await testXyUnsignedMerchant({ profile });
}

export async function testXyWebDashboardAction() {
  const profile = await requireOwnerAdmin();
  await testXyWebDashboard({ profile });
}
