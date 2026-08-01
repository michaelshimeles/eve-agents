import { Chat } from "../chat";
import { requireOwnerPage } from "@/lib/web-auth";

export default async function FilesPage() {
  await requireOwnerPage();
  return <Chat initialView="files" />;
}
