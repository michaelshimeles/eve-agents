import { Chat } from "../chat";
import { requireOwnerPage } from "@/lib/web-auth";

// The manage view renders inside the chat shell so the thread sidebar is
// shared; ChatApp keeps the URL in sync ("/chat" vs "/manage") via pushState.

export default async function ManagePage() {
  await requireOwnerPage();
  return <Chat initialView="manage" />;
}
