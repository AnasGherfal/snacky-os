import { ErrorState, SecondaryButton } from "@/components/ui";
import { dispatchActor, dispatchBoard, dispatchContext } from "@/lib/operator-dispatch-server";
import WorkBoard from "./WorkBoard";
export const dynamic="force-dynamic";
export default async function TodayWorkPage() {
  try {
    const actor=await dispatchActor();
    return <WorkBoard initial={dispatchBoard(actor,await dispatchContext(actor))} />;
  } catch(error) {
    return <ErrorState title="Today's Work is unavailable" body={error instanceof Error ? error.message : "Could not load current work."} action={<SecondaryButton href="/operator">Existing routes</SecondaryButton>} />;
  }
}
