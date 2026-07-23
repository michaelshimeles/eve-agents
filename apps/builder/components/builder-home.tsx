"use client";

import { Tabs } from "frosted-ui";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { UpdateFlow } from "@/components/update-flow";
import { BuilderWizard } from "@/components/wizard";

// Landing switcher: build a brand-new agent (the wizard) or update one
// deployed earlier onto the latest template. Deployed agents link straight
// to the update tab with ?update=<project-name> when they detect a newer
// template, so the flow opens with their project preselected.

export function BuilderHome() {
  const updateParam = useSearchParams().get("update");
  const [mode, setMode] = useState(updateParam !== null ? "update" : "create");

  return (
    <>
      <div className="mx-auto w-full max-w-5xl px-6 pt-8">
        <Tabs.Root value={mode} onValueChange={(value) => setMode(value as string)}>
          <Tabs.List size="2" className="w-fit max-w-full">
            <Tabs.Trigger value="create">Create an agent</Tabs.Trigger>
            <Tabs.Trigger value="update">Update an agent</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
      </div>
      {mode === "create" ? (
        <BuilderWizard />
      ) : (
        <UpdateFlow initialProjectName={updateParam ?? ""} />
      )}
    </>
  );
}
