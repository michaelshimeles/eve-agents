import { Chat } from "../chat";

// The manage view renders inside the chat shell so the thread sidebar is
// shared; ChatApp keeps the URL in sync ("/chat" vs "/manage") via pushState.

export default function ManagePage() {
  return <Chat initialView="manage" />;
}
