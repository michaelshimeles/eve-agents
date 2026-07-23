"use client";

import { Badge, Button, Callout, Heading, Select, Spinner, Text, TextField } from "frosted-ui";
import { CircleCheck, Info, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// The update flow: paste a token, pick the agent's project, one click.
// Everything the redeploy needs (features, instructions, custom schedules)
// is read back from the deployed agent itself by /api/update, so nothing has
// to be re-entered and nothing is ever stored. Deployed agents link here
// with ?update=<project> prefilled when they detect a newer template.

interface Identity {
  user: { id: string; username: string; email?: string };
  teams: { id: string; slug: string; name: string }[];
}

interface ProjectItem {
  id: string;
  name: string;
  updatedAt: number | null;
}

interface InspectResult {
  projectName: string;
  currentVersion: string | null;
  latestVersion: string;
  upToDate: boolean;
  features: string[];
  customScheduleCount: number;
}

type UpdatePhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "building"; deploymentId: string; inspectorUrl: string | null }
  | { kind: "finalizing" }
  | { kind: "ready"; url: string; sessionOk: boolean; sessionError: string | null }
  | { kind: "error"; message: string; log: string | null };

export function UpdateFlow({ initialProjectName }: { initialProjectName: string }) {
  const [token, setToken] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [identifyError, setIdentifyError] = useState<string | null>(null);

  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [manualName, setManualName] = useState(initialProjectName);

  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefillConsumed = useRef(false);
  /** Stamps + scope from update start — restored if the build fails or polling stops. */
  const pendingRollback = useRef<{
    token: string;
    teamId: string | null;
    projectName: string;
    version: string | null;
    release: number | null;
  } | null>(null);

  async function rollbackStampsAfterFailedBuild(opts?: {
    keepalive?: boolean;
  }): Promise<string | null> {
    const pending = pendingRollback.current;
    if (pending === null) return null;
    // Clear first so pagehide / double-calls don't fire twice.
    pendingRollback.current = null;
    try {
      const response = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: pending.token,
          teamId: pending.teamId,
          action: "rollback-stamps",
          projectName: pending.projectName,
          previousVersion: pending.version,
          previousRelease: pending.release,
        }),
        keepalive: opts?.keepalive === true,
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        // Put it back so the user can retry from the error UI if needed.
        pendingRollback.current = pending;
        return (
          body.error ??
          "Could not restore the previous template stamps. The agent may stop offering this update until you retry."
        );
      }
      return null;
    } catch (error) {
      pendingRollback.current = pending;
      return error instanceof Error
        ? error.message
        : "Could not restore the previous template stamps after the failed build.";
    }
  }

  useEffect(() => {
    function onLeave() {
      // Best-effort: if the tab closes mid-build, restore stamps so a later
      // ERROR doesn't leave the project advertising a release that never shipped.
      if (pendingRollback.current !== null) {
        void rollbackStampsAfterFailedBuild({ keepalive: true });
      }
    }
    window.addEventListener("pagehide", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    };
  }, []);

  async function verifyToken() {
    setIdentifying(true);
    setIdentifyError(null);
    try {
      const response = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = (await response.json()) as Identity & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Token check failed");
      setIdentity(body);
      const scope = body.teams.length > 0 ? body.teams[0].id : null;
      setTeamId(scope);
      void loadProjects(scope);
    } catch (error) {
      setIdentity(null);
      setIdentifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setIdentifying(false);
    }
  }

  async function loadProjects(scope: string | null) {
    setProjects(null);
    setProjectsError(null);
    setSelected("");
    setInspect(null);
    setInspectError(null);
    setPhase({ kind: "idle" });
    try {
      const response = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), teamId: scope, action: "projects" }),
      });
      const body = (await response.json()) as {
        projects?: ProjectItem[];
        latestVersion?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not list projects");
      const list = (body.projects ?? []).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      setProjects(list);
      setLatestVersion(body.latestVersion ?? null);
      if (
        !prefillConsumed.current &&
        initialProjectName.length > 0 &&
        list.some((project) => project.name === initialProjectName)
      ) {
        prefillConsumed.current = true;
        void selectProject(initialProjectName, scope);
      }
    } catch (error) {
      setProjects([]);
      setProjectsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectProject(name: string, scope: string | null) {
    setSelected(name);
    setInspect(null);
    setInspectError(null);
    setPhase({ kind: "idle" });
    if (name.length === 0) return;
    setInspecting(true);
    try {
      const response = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim(),
          teamId: scope,
          action: "inspect",
          projectName: name,
        }),
      });
      const body = (await response.json()) as InspectResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not inspect that project");
      setInspect(body);
    } catch (error) {
      setInspectError(error instanceof Error ? error.message : String(error));
    } finally {
      setInspecting(false);
    }
  }

  function pollStatus(deploymentId: string, consecutiveFailures = 0) {
    if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/deploy/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: token.trim(), teamId, deploymentId }),
          });
          const body = (await response.json()) as {
            readyState?: string;
            url?: string;
            errorLog?: string | null;
            error?: string;
          };
          if (!response.ok) throw new Error(body.error ?? "Status check failed");
          if (body.readyState === "READY") {
            pendingRollback.current = null;
            setPhase({ kind: "finalizing" });
            const finalize = (await fetch("/api/deploy/finalize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // The production alias doesn't change on update, so an existing
              // Telegram webhook keeps pointing at the right place.
              body: JSON.stringify({ token: token.trim(), teamId, deploymentId, telegram: null }),
            })
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null)) as {
              sessionOk?: boolean;
              sessionError?: string | null;
              publicUrl?: string | null;
            } | null;
            setPhase({
              kind: "ready",
              url: finalize?.publicUrl ?? body.url ?? "",
              sessionOk: finalize?.sessionOk ?? false,
              sessionError: finalize === null ? "finalize-failed" : (finalize.sessionError ?? null),
            });
            return;
          }
          if (body.readyState === "ERROR" || body.readyState === "CANCELED") {
            const rollbackError = await rollbackStampsAfterFailedBuild();
            setPhase({
              kind: "error",
              message:
                rollbackError === null
                  ? "The remote build failed. Your agent keeps running on its previous deployment."
                  : `The remote build failed, and restoring the previous template stamps also failed: ${rollbackError}`,
              log: body.errorLog ?? null,
            });
            return;
          }
          pollStatus(deploymentId, 0);
        } catch (error) {
          console.error("status poll failed:", error);
          // Cap retries so a revoked token / deleted deployment / network
          // outage surfaces an error instead of polling forever.
          if (consecutiveFailures >= 5) {
            const lost =
              error instanceof Error
                ? error.message
                : "Lost contact with Vercel while waiting for the build.";
            const rollbackError = await rollbackStampsAfterFailedBuild();
            setPhase({
              kind: "error",
              message:
                rollbackError === null
                  ? `${lost} Previous template stamps were restored in case the build does not finish.`
                  : `${lost} Also failed to restore template stamps: ${rollbackError}`,
              log: null,
            });
            return;
          }
          pollStatus(deploymentId, consecutiveFailures + 1);
        }
      })();
    }, 3500);
  }

  async function runUpdate() {
    if (selected.length === 0) return;
    setPhase({ kind: "starting" });
    pendingRollback.current = null;
    try {
      const response = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim(),
          teamId,
          action: "update",
          projectName: selected,
        }),
      });
      const body = (await response.json()) as {
        deploymentId?: string;
        inspectorUrl?: string | null;
        fromVersion?: string | null;
        fromRelease?: number | null;
        error?: string;
      };
      if (!response.ok || body.deploymentId === undefined) {
        setPhase({ kind: "error", message: body.error ?? "Update failed", log: null });
        return;
      }
      pendingRollback.current = {
        token: token.trim(),
        teamId,
        projectName: selected,
        version: body.fromVersion ?? null,
        release: typeof body.fromRelease === "number" ? body.fromRelease : null,
      };
      setPhase({
        kind: "building",
        deploymentId: body.deploymentId,
        inspectorUrl: body.inspectorUrl ?? null,
      });
      pollStatus(body.deploymentId);
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        log: null,
      });
    }
  }

  const scopeItems: Record<string, string> =
    identity === null
      ? {}
      : {
          personal: `${identity.user.username} (personal)`,
          ...Object.fromEntries(identity.teams.map((team) => [team.id, team.name])),
        };

  const projectItems: Record<string, string> = Object.fromEntries(
    (projects ?? []).map((project) => [project.name, project.name]),
  );
  if (initialProjectName.length > 0 && projectItems[initialProjectName] === undefined) {
    projectItems[initialProjectName] = initialProjectName;
  }

  const busy = phase.kind === "starting" || phase.kind === "building" || phase.kind === "finalizing";

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <header>
          <Heading size="6">Update your agent</Heading>
          <Text render={<p />} size="2" color="gray" className="mt-1.5 max-w-xl">
            Redeploys an agent you built here onto the newest template. Your settings,
            instructions, schedules, keys, chat history, memories, and connections are all kept —
            only the code changes. Nothing is stored by the builder.
          </Text>
        </header>

        <div className="flex flex-col gap-4">
          {initialProjectName.length > 0 && identity === null && (
            <Callout.Root color="blue">
              <Callout.Icon>
                <Info className="size-4" />
              </Callout.Icon>
              <Callout.Title>Updating project “{initialProjectName}”</Callout.Title>
              <Callout.Description>
                Paste the Vercel token you deployed with to continue.
              </Callout.Description>
            </Callout.Root>
          )}
          <div className="flex flex-col gap-1.5">
            <Text render={<label htmlFor="update-token" />} size="2" weight="medium">
              Vercel token
            </Text>
            <TextField.Input
              id="update-token"
              size="3"
              type="password"
              suppressHydrationWarning
              value={token}
              placeholder="vercel_…"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => {
                setToken(event.target.value);
                setIdentity(null);
                setProjects(null);
                setInspect(null);
                setPhase({ kind: "idle" });
              }}
            />
            <Text render={<p />} size="1" color="gray">
              The same kind of token you deployed with — vercel.com → Account Settings → Tokens.
              It stays in this tab&apos;s memory.
            </Text>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="classic"
              size="3"
              disabled={busy || token.trim().length === 0 || identifying}
              onClick={() => void verifyToken()}
            >
              {identifying ? "Checking…" : "Verify token"}
            </Button>
            {identity !== null && (
              <span className="flex items-center gap-1.5 text-sm text-gray-12">
                <CircleCheck className="size-4 text-success-9" /> {identity.user.username}
              </span>
            )}
          </div>
          {identifyError !== null && (
            <Callout.Root color="red">
              <Callout.Icon>
                <TriangleAlert className="size-4" />
              </Callout.Icon>
              <Callout.Title>{identifyError}</Callout.Title>
            </Callout.Root>
          )}
          {identity !== null && identity.teams.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Text render={<p />} size="2" weight="medium">
                Account
              </Text>
              <Select.Root
                size="3"
                items={scopeItems}
                value={teamId ?? "personal"}
                disabled={busy}
                onValueChange={(value) => {
                  if (busy) return;
                  const scope = value === "personal" ? null : (value as string);
                  setTeamId(scope);
                  void loadProjects(scope);
                }}
              >
                <Select.Trigger className="w-full" aria-label="Vercel scope" />
                <Select.Content>
                  {Object.entries(scopeItems).map(([value, label]) => (
                    <Select.Item key={value} value={value}>
                      {label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </div>
          )}
        </div>

        {identity !== null && projects === null && projectsError === null && (
          <ProgressNote text="Listing the projects on your account…" />
        )}

        {projectsError !== null && (
          <Callout.Root color="yellow">
            <Callout.Icon>
              <Info className="size-4" />
            </Callout.Icon>
            <Callout.Title>Couldn&apos;t list your projects</Callout.Title>
            <Callout.Description>
              {projectsError} — type the project name below.
            </Callout.Description>
          </Callout.Root>
        )}

        {identity !== null && projects !== null && (
          <div className="flex flex-col gap-3">
            {Object.keys(projectItems).length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Text render={<p />} size="2" weight="medium">
                  Agent project
                </Text>
                <Select.Root
                  size="3"
                  items={projectItems}
                  value={selected}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (busy) return;
                    void selectProject(value as string, teamId);
                  }}
                >
                  <Select.Trigger
                    className="w-full"
                    aria-label="Agent project"
                    placeholder="Pick the project your agent lives in…"
                  />
                  <Select.Content>
                    {Object.entries(projectItems).map(([value, label]) => (
                      <Select.Item key={value} value={value}>
                        {label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <Text render={<p />} size="1" color="gray">
                  Showing your {Object.keys(projectItems).length} most recently updated projects.
                  If yours isn&apos;t listed, type its name below.
                </Text>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Text render={<label htmlFor="manual-project" />} size="2" weight="medium">
                {Object.keys(projectItems).length > 0 ? "Or type the project name" : "Agent project"}
              </Text>
              <div className="flex items-center gap-3">
                <TextField.Input
                  id="manual-project"
                  size="3"
                  className="flex-1"
                  value={manualName}
                  placeholder="my-eve-agent"
                  disabled={busy}
                  onChange={(event) => setManualName(event.target.value)}
                />
                <Button
                  variant="surface"
                  size="3"
                  disabled={busy || manualName.trim().length === 0}
                  onClick={() => void selectProject(manualName.trim(), teamId)}
                >
                  Check
                </Button>
              </div>
            </div>
          </div>
        )}

        {inspecting && <ProgressNote text="Reading the deployed agent…" />}

        {inspectError !== null && (
          <Callout.Root color="red">
            <Callout.Icon>
              <TriangleAlert className="size-4" />
            </Callout.Icon>
            <Callout.Title>Can&apos;t update this project</Callout.Title>
            <Callout.Description>{inspectError}</Callout.Description>
          </Callout.Root>
        )}

        {inspect !== null && phase.kind === "idle" && (
          <div className="flex flex-col gap-4 rounded-xl border border-gray-a4 bg-panel p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-gray-12">{inspect.projectName}</p>
                <p className="mt-0.5 text-sm text-gray-11">
                  {inspect.upToDate
                    ? "Already on the latest template."
                    : "A newer template is available."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="soft" color={inspect.upToDate ? "green" : "yellow"}>
                  {inspect.currentVersion ?? "pre-versioning"}
                </Badge>
                {!inspect.upToDate && (
                  <>
                    <span className="text-gray-11">→</span>
                    <Badge variant="soft" color="green">
                      {inspect.latestVersion}
                    </Badge>
                  </>
                )}
              </div>
            </div>
            <div className="text-sm text-gray-11">
              Features: {inspect.features.length > 0 ? inspect.features.join(", ") : "none"}
              {inspect.customScheduleCount > 0 &&
                ` · ${inspect.customScheduleCount} custom scheduled ${
                  inspect.customScheduleCount === 1 ? "job" : "jobs"
                } (kept)`}
            </div>
            <Text render={<p />} size="1" color="gray">
              The update replaces only the agent&apos;s code. Instructions (including your edits),
              schedules, env keys, push notification keys, database, chat history, memories,
              skills, and connections are preserved. The URL doesn&apos;t change. Takes 2–4
              minutes; the agent keeps running until the new build is live.
            </Text>
            <div>
              <Button
                variant="classic"
                color={inspect.upToDate ? "gray" : undefined}
                size="3"
                onClick={() => void runUpdate()}
              >
                <RefreshCw className="size-4" />
                {inspect.upToDate ? "Redeploy anyway" : "Update agent"}
              </Button>
            </div>
          </div>
        )}

        {phase.kind === "starting" && (
          <ProgressNote text="Reading the deployed agent and starting the update…" />
        )}

        {phase.kind === "building" && (
          <>
            <ProgressNote text="Vercel is building the updated agent — usually 2–4 minutes. The current version keeps serving until it's done." />
            {phase.inspectorUrl !== null && (
              <p className="text-sm text-gray-11">
                Watch the build in your{" "}
                <a
                  href={phase.inspectorUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-gray-12"
                >
                  Vercel dashboard
                </a>
                .
              </p>
            )}
          </>
        )}

        {phase.kind === "finalizing" && (
          <ProgressNote text="Build done — warming up the updated agent and running a test message…" />
        )}

        {phase.kind === "ready" && (
          <div className="flex flex-col gap-4">
            <Callout.Root color={phase.sessionOk ? "green" : "yellow"}>
              <Callout.Icon>
                {phase.sessionOk ? <CircleCheck className="size-4" /> : <Info className="size-4" />}
              </Callout.Icon>
              <Callout.Title>
                {phase.sessionOk ? "Agent updated" : "Updated, but not answering yet"}
              </Callout.Title>
              <Callout.Description>
                {phase.sessionOk
                  ? "The new version is live and answered a test message. Everything carried over."
                  : "The new build is live, but the post-update test message didn't get an answer yet — open the chat and try saying hi; the first minutes after a deploy can be slow."}
              </Callout.Description>
            </Callout.Root>
            {phase.url.length > 0 && (
              <a
                href={`https://${phase.url}`}
                target="_blank"
                rel="noreferrer"
                className="text-lg font-semibold text-gray-12 underline"
              >
                {phase.url}
              </a>
            )}
          </div>
        )}

        {phase.kind === "error" && (
          <div className="flex flex-col gap-3">
            <Callout.Root color="red">
              <Callout.Icon>
                <TriangleAlert className="size-4" />
              </Callout.Icon>
              <Callout.Title>Update failed</Callout.Title>
              <Callout.Description>{phase.message}</Callout.Description>
            </Callout.Root>
            {phase.log !== null && (
              <pre className="max-h-64 overflow-auto rounded-lg bg-gray-a2 p-3 text-xs">
                {phase.log}
              </pre>
            )}
            <div>
              <Button variant="surface" size="2" onClick={() => setPhase({ kind: "idle" })}>
                Back
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressNote({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-gray-12">
      <Spinner size="3" />
      {text}
    </div>
  );
}
