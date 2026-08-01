import { Chat } from "../chat";
import { requireOwnerPage } from "@/lib/web-auth";

// The email client renders inside the chat shell so the thread sidebar is
// shared; ChatApp keeps the URL in sync ("/chat" vs "/manage" vs "/email") via
// pushState.

export default async function EmailPage() {
  await requireOwnerPage();
  return <Chat initialView="email" />;
}
