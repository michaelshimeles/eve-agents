import { IMessageTranscriptPage } from "@/components/imessage-transcript-page";
import { requireOwnerPage } from "@/lib/web-auth";

export default async function Page() {
  await requireOwnerPage();
  return <IMessageTranscriptPage />;
}
