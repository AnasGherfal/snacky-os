import { redirect } from "next/navigation";

export default async function EditCashCollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/cash-collections/${id}?error=${encodeURIComponent("Cash custody records are immutable. Void the batch with a reason and record a replacement instead of editing history.")}`);
}
