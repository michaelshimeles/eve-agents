import { Chat } from "../chat";

// The email client renders inside the chat shell so the thread sidebar is
// shared; ChatApp keeps the URL in sync ("/chat" vs "/manage" vs "/email") via
// pushState.

export default function EmailPage() {
  return <Chat initialView="email" />;
}
