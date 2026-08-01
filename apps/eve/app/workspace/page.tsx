import { Chat } from "../chat";
import { requireOwnerPage } from "@/lib/web-auth";

export default async function WorkspaceRoute() {
  await requireOwnerPage();
  return <Chat initialView="workspace" />;
}
