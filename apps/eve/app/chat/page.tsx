import { Chat } from "../chat";
import { requireOwnerPage } from "@/lib/web-auth";

export default async function ChatPage() {
  await requireOwnerPage();
  return <Chat />;
}
