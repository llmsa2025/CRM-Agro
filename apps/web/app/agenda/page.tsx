import { Suspense } from "react";
import { AgendaClient } from "./AgendaClient";

export const dynamic = "force-dynamic";

export default function AgendaPage() {
  return (
    <Suspense>
      <AgendaClient />
    </Suspense>
  );
}
