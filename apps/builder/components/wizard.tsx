"use client";

import {
  Badge,
  Button,
  Callout,
  Heading,
  Select,
  Spinner,
  Switch,
  Text,
  TextArea,
  TextField,
} from "frosted-ui";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  Info,
  Plus,
  Rocket,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  requiredKeys,
  slugify,
  type AgentConfig,
  type BlobSource,
  type CustomSchedule,
  type FeatureId,
  type PostgresSource,
} from "@/lib/config";
import { generateInstructions } from "@/lib/instructions";
import { cn } from "@/lib/utils";

// The whole builder is one wizard. Everything lives in client memory — the
// token and keys are sent to our API only inside the deploy (and identify)
// requests and are never persisted anywhere.

const STEPS = [
  "Vercel account",
  "Identity",
  "Capabilities",
  "Channels",
  "Schedules",
  "Instructions",
  "Keys",
  "Deploy",
] as const;

interface FeatureInfo {
  id: FeatureId;
  name: string;
  description: string;
  needs: string | null;
}

const FEATURES: FeatureInfo[] = [
  {
    id: "memory",
    name: "Long-term memory",
    description: "Remembers facts across conversations, with a nightly consolidation pass.",
    needs: "Supermemory API key",
  },
  {
    id: "proactive",
    name: "Reminders & webhooks",
    description: "One-off and recurring reminders, plus webhook URLs that wake the agent.",
    needs: null,
  },
  {
    id: "integrations",
    name: "App integrations",
    description: "Gmail, Calendar, Notion, Slack, GitHub and more via Composio.",
    needs: "Composio API key",
  },
  {
    id: "skills",
    name: "Chat-created skills",
    description: "The agent saves reusable procedures it can load later.",
    needs: "Vercel Blob",
  },
  {
    id: "file-sharing",
    name: "File sharing",
    description: "Uploads files the agent produces and hands back a link.",
    needs: "Vercel Blob",
  },
  {
    id: "receipts",
    name: "Receipt tracking",
    description: "Photograph receipts; log, query, and summarize spending.",
    needs: null,
  },
  {
    id: "browser",
    name: "Browser control",
    description: "A real browser in the sandbox for sites without an API.",
    needs: null,
  },
  {
    id: "utilities",
    name: "Utilities",
    description: "Weather lookups and dice rolls.",
    needs: null,
  },
];

const MODEL_OPTIONS: Record<string, string> = {
  "anthropic/claude-sonnet-5": "Claude Sonnet (recommended)",
  "anthropic/claude-haiku-4-5": "Claude Haiku (fast)",
  "openai/gpt-5.2": "GPT-5.2",
  "google/gemini-3-pro": "Gemini 3 Pro",
};

interface Identity {
  user: { id: string; username: string; email?: string };
  teams: { id: string; slug: string; name: string }[];
}

interface StoreOption {
  id: string;
  name: string;
  productName: string | null;
}

interface AccountStores {
  databases: StoreOption[];
  blobStores: StoreOption[];
}

type DeployPhase =
  | { kind: "idle" }
  | { kind: "confirm-existing"; message: string }
  | { kind: "creating" }
  | { kind: "building"; deploymentId: string; url: string; inspectorUrl: string | null }
  | {
      kind: "ready";
      url: string;
      healthy: boolean;
      sessionOk: boolean;
      telegramWebhook: "set" | "failed" | null;
    }
  | { kind: "error"; stage: string; message: string; log: string | null };

export function BuilderWizard() {
  const [step, setStep] = useState(0);

  // Step 1: Vercel account
  const [token, setToken] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [identifyError, setIdentifyError] = useState<string | null>(null);

  // Step 2: identity
  const [agentName, setAgentName] = useState("Eve");
  const [projectName, setProjectName] = useState("eve");
  const [projectNameEdited, setProjectNameEdited] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [personality, setPersonality] = useState("");
  const [model, setModel] = useState("anthropic/claude-sonnet-5");
  const [customModel, setCustomModel] = useState("");

  // Step 3: capabilities
  const [features, setFeatures] = useState<Set<FeatureId>>(
    () => new Set<FeatureId>(FEATURES.map((feature) => feature.id)),
  );

  // Step 4: channels
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramBotUsername, setTelegramBotUsername] = useState("");
  const [telegramAllowedIds, setTelegramAllowedIds] = useState("");
  const webhookSecretRef = useRef<string>(crypto.randomUUID().replaceAll("-", ""));

  // Step 5: schedules
  const [schedules, setSchedules] = useState<CustomSchedule[]>([]);

  // Step 6: instructions
  const [instructions, setInstructions] = useState("");
  const [instructionsEdited, setInstructionsEdited] = useState(false);

  // Step 7: keys. Postgres and Blob default to Vercel-side provisioning
  // ("connect an existing database" / "create a Blob store"); manual paste is
  // the fallback. Stores are fetched with the verified token on step entry.
  const [stores, setStores] = useState<AccountStores | null>(null);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [postgresChoice, setPostgresChoice] = useState<string>(""); // "" = unresolved, storeId, or "manual"
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [blobChoice, setBlobChoice] = useState<string>("create"); // "create", storeId, or "manual"
  const [supermemoryKey, setSupermemoryKey] = useState("");
  const [composioKey, setComposioKey] = useState("");
  const [blobToken, setBlobToken] = useState("");

  // Step 8: deploy
  const [phase, setPhase] = useState<DeployPhase>({ kind: "idle" });
  const [dryRun, setDryRun] = useState<{ files: string[]; envKeys: string[] } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveModel = model === "custom" ? customModel.trim() : model;
  const keyNeeds = requiredKeys([...features]);

  const postgres: PostgresSource =
    postgresChoice === "create"
      ? { mode: "create" }
      : postgresChoice === "manual" || postgresChoice === ""
        ? { mode: "manual", url: databaseUrl }
        : { mode: "connect", storeId: postgresChoice };
  const blob: BlobSource =
    blobChoice === "create"
      ? { mode: "create" }
      : blobChoice === "manual"
        ? { mode: "manual", token: blobToken }
        : { mode: "connect", storeId: blobChoice };

  const config: AgentConfig = useMemo(
    () => ({
      agentName: agentName.trim(),
      projectName,
      ownerName: ownerName.trim(),
      model: effectiveModel,
      features: [...features],
      instructions,
      telegram: telegramEnabled
        ? {
            botToken: telegramBotToken,
            botUsername: telegramBotUsername,
            webhookSecret: webhookSecretRef.current,
            allowedUserIds: telegramAllowedIds,
          }
        : null,
      schedules,
      postgres,
      blob,
      keys: {
        supermemoryApiKey: keyNeeds.supermemory ? supermemoryKey : undefined,
        composioApiKey: keyNeeds.composio ? composioKey : undefined,
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- postgres/blob are derived fresh each render
    [
      agentName,
      projectName,
      ownerName,
      effectiveModel,
      features,
      instructions,
      telegramEnabled,
      telegramBotToken,
      telegramBotUsername,
      telegramAllowedIds,
      schedules,
      postgresChoice,
      databaseUrl,
      blobChoice,
      blobToken,
      supermemoryKey,
      composioKey,
      keyNeeds.supermemory,
      keyNeeds.composio,
      keyNeeds.blob,
    ],
  );

  function loadStores() {
    setStoresError(null);
    void fetch("/api/stores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.trim(), teamId }),
    })
      .then(async (response) => {
        const body = (await response.json()) as AccountStores & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not list storage");
        setStores(body);
        // Default to provisioning a fresh database on their account.
        setPostgresChoice((current) => (current !== "" ? current : "create"));
      })
      .catch((error: unknown) => {
        setStores({ databases: [], blobStores: [] });
        setPostgresChoice((current) => (current === "" ? "manual" : current));
        setStoresError(error instanceof Error ? error.message : String(error));
      });
  }

  function regenerateInstructions(): string {
    return generateInstructions({
      agentName: agentName.trim() || "Eve",
      ownerName: ownerName.trim() || "your user",
      personality,
      features: [...features],
      telegramEnabled,
    });
  }

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
      setTeamId(body.teams.length > 0 ? body.teams[0].id : null);
    } catch (error) {
      setIdentity(null);
      setIdentifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setIdentifying(false);
    }
  }

  function toggleFeature(id: FeatureId, on: boolean) {
    setFeatures((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function goTo(next: number) {
    // Entering the instructions step regenerates the draft unless the user
    // has taken over editing.
    if (STEPS[next] === "Instructions" && !instructionsEdited) {
      setInstructions(regenerateInstructions());
    }
    if (STEPS[next] === "Keys" && stores === null) {
      loadStores();
    }
    if (STEPS[next] === "Deploy") {
      setDryRun(null);
      void fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun: true,
          config: { ...config, instructions: instructions || regenerateInstructions() },
        }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { files?: string[]; envKeys?: string[] } | null) => {
          if (body?.files !== undefined) {
            setDryRun({ files: body.files, envKeys: body.envKeys ?? [] });
          }
        })
        .catch(() => undefined);
    }
    setStep(next);
  }

  function stepValid(index: number): boolean {
    switch (STEPS[index]) {
      case "Vercel account":
        return identity !== null;
      case "Identity":
        return (
          agentName.trim().length > 0 &&
          ownerName.trim().length > 0 &&
          /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(projectName) &&
          effectiveModel.length > 0
        );
      case "Channels":
        return !telegramEnabled || telegramBotToken.trim().length > 0;
      case "Schedules":
        return schedules.every(
          (schedule) =>
            schedule.name.trim().length > 0 &&
            schedule.cron.trim().length > 0 &&
            schedule.prompt.trim().length > 0,
        );
      case "Instructions":
        return instructions.trim().length > 0;
      case "Keys":
        return (
          (postgresChoice === "manual" ? databaseUrl.trim().length > 0 : postgresChoice !== "") &&
          (!keyNeeds.supermemory || supermemoryKey.trim().length > 0) &&
          (!keyNeeds.composio || composioKey.trim().length > 0) &&
          (!keyNeeds.blob || blobChoice !== "manual" || blobToken.trim().length > 0)
        );
      default:
        return true;
    }
  }

  function pollStatus(deploymentId: string) {
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
            const finalize = await fetch("/api/deploy/finalize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                token: token.trim(),
                teamId,
                deploymentId,
                telegram: telegramEnabled
                  ? { botToken: telegramBotToken.trim(), webhookSecret: webhookSecretRef.current }
                  : null,
              }),
            })
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null) as {
              healthy?: boolean;
              sessionOk?: boolean;
              telegramWebhook?: "set" | "failed" | null;
            } | null;
            setPhase({
              kind: "ready",
              url: body.url ?? "",
              healthy: finalize?.healthy ?? false,
              sessionOk: finalize?.sessionOk ?? false,
              telegramWebhook: finalize?.telegramWebhook ?? null,
            });
            return;
          }
          if (body.readyState === "ERROR" || body.readyState === "CANCELED") {
            setPhase({
              kind: "error",
              stage: "build",
              message: "The remote build failed.",
              log: body.errorLog ?? null,
            });
            return;
          }
          pollStatus(deploymentId);
        } catch (error) {
          // Transient poll failures shouldn't kill the wait; try again.
          console.error("status poll failed:", error);
          pollStatus(deploymentId);
        }
      })();
    }, 3500);
  }

  async function deploy(confirmExisting = false) {
    setPhase({ kind: "creating" });
    try {
      const response = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: { token: token.trim(), teamId }, config, confirmExisting }),
      });
      const body = (await response.json()) as {
        deploymentId?: string;
        url?: string;
        inspectorUrl?: string | null;
        error?: string;
        stage?: string;
        code?: string;
      };
      if (body.code === "project_exists") {
        setPhase({ kind: "confirm-existing", message: body.error ?? "Project already exists." });
        return;
      }
      if (!response.ok || body.deploymentId === undefined) {
        setPhase({
          kind: "error",
          stage: body.stage ?? "deploy",
          message: body.error ?? "Deploy failed",
          log: null,
        });
        return;
      }
      setPhase({
        kind: "building",
        deploymentId: body.deploymentId,
        url: body.url ?? "",
        inspectorUrl: body.inspectorUrl ?? null,
      });
      pollStatus(body.deploymentId);
    } catch (error) {
      setPhase({
        kind: "error",
        stage: "deploy",
        message: error instanceof Error ? error.message : String(error),
        log: null,
      });
    }
  }

  const scopeLabel =
    identity === null
      ? null
      : teamId === null
        ? `${identity.user.username} (personal)`
        : (identity.teams.find((team) => team.id === teamId)?.name ?? "team");

  const scopeItems: Record<string, string> =
    identity === null
      ? {}
      : {
          personal: `${identity.user.username} (personal)`,
          ...Object.fromEntries(identity.teams.map((team) => [team.id, team.name])),
        };

  const databaseItems: Record<string, string> =
    stores === null
      ? {}
      : {
          create: "Create a new Neon database (recommended)",
          ...Object.fromEntries(
            stores.databases.map((store) => [
              store.id,
              `Existing — ${store.productName !== null ? `${store.productName} — ` : ""}${store.name}`,
            ]),
          ),
          manual: "Paste a connection string…",
        };

  const blobItems: Record<string, string> =
    stores === null
      ? {}
      : {
          create: "Create a new Blob store (recommended)",
          ...Object.fromEntries(
            stores.blobStores.map((store) => [store.id, `Existing — ${store.name}`]),
          ),
          manual: "Paste a token…",
        };

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-6 py-10">
      {/* Step rail */}
      <nav className="hidden w-52 shrink-0 flex-col gap-1 md:flex" aria-label="Wizard steps">
        {STEPS.map((label, index) => {
          const done = index < step;
          const active = index === step;
          return (
            <button
              key={label}
              type="button"
              disabled={index > step}
              onClick={() => goTo(index)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm",
                active ? "bg-gray-a3 text-gray-12" : "text-gray-11",
                index < step && "hover:bg-gray-a2 hover:text-gray-12",
                index > step && "cursor-not-allowed opacity-50",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                  done
                    ? "border-accent-9 bg-accent-9 text-accent-contrast"
                    : active
                      ? "border-accent-9 text-gray-12"
                      : "border-gray-a6",
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : index + 1}
              </span>
              {label}
            </button>
          );
        })}
      </nav>

      {/* Active step */}
      <div className="min-w-0 flex-1">
        {STEPS[step] === "Vercel account" && (
          <StepShell
            title="Connect your Vercel account"
            lead="Your agent deploys into your own Vercel account. Create a token at vercel.com → Account Settings → Tokens. It stays in this tab's memory and is never stored."
          >
            <FormField label="Vercel token" htmlFor="vercel-token">
              <TextField.Input
                id="vercel-token"
                size="3"
                type="password"
                suppressHydrationWarning
                value={token}
                placeholder="vercel_…"
                autoComplete="off"
                onChange={(event) => {
                  setToken(event.target.value);
                  setIdentity(null);
                }}
              />
            </FormField>
            <div className="flex items-center gap-3">
              <Button
                variant="classic"
                size="3"
                disabled={token.trim().length === 0 || identifying}
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
            {identity !== null && (
              <FormField label="Deploy into" description="Personal scope or one of your teams.">
                <Select.Root
                  size="3"
                  items={scopeItems}
                  value={teamId ?? "personal"}
                  onValueChange={(value) => setTeamId(value === "personal" ? null : (value as string))}
                >
                  <Select.Trigger className="w-full" aria-label="Deploy scope" />
                  <Select.Content>
                    {Object.entries(scopeItems).map(([value, label]) => (
                      <Select.Item key={value} value={value}>
                        {label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </FormField>
            )}
          </StepShell>
        )}

        {STEPS[step] === "Identity" && (
          <StepShell title="Who is your agent?" lead="Names, personality, and the default model.">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Agent name" htmlFor="agent-name">
                <TextField.Input
                  id="agent-name"
                  size="3"
                  value={agentName}
                  placeholder="Eve"
                  onChange={(event) => {
                    setAgentName(event.target.value);
                    if (!projectNameEdited) setProjectName(slugify(event.target.value));
                  }}
                />
              </FormField>
              <FormField label="Your name" htmlFor="owner-name" description="How the agent addresses you.">
                <TextField.Input
                  id="owner-name"
                  size="3"
                  value={ownerName}
                  placeholder="Ada"
                  onChange={(event) => setOwnerName(event.target.value)}
                />
              </FormField>
            </div>
            <FormField
              label="Vercel project name"
              htmlFor="project-name"
              description="Lowercase letters, digits, and dashes. Also the deployment URL prefix."
            >
              <TextField.Input
                id="project-name"
                size="3"
                value={projectName}
                onChange={(event) => {
                  setProjectNameEdited(true);
                  setProjectName(event.target.value);
                }}
              />
            </FormField>
            <FormField
              label="Personality notes"
              htmlFor="personality"
              description="Anything about tone, priorities, or context. Woven into the generated instructions."
            >
              <TextArea
                id="personality"
                size="3"
                className="[&>textarea]:field-sizing-content [&>textarea]:min-h-20 [&>textarea]:max-h-56"
                value={personality}
                placeholder="Dry sense of humor. I work in UTC+1. Never schedule anything before 10am."
                onChange={(event) => setPersonality(event.target.value)}
              />
            </FormField>
            <FormField
              label="Default model"
              description="Routed through your Vercel AI Gateway — billing lands on your account, no provider keys needed."
            >
              <Select.Root
                size="3"
                items={{ ...MODEL_OPTIONS, custom: "Custom model id…" }}
                value={model}
                onValueChange={(value) => setModel(value as string)}
              >
                <Select.Trigger className="w-full" aria-label="Default model" />
                <Select.Content>
                  {Object.entries({ ...MODEL_OPTIONS, custom: "Custom model id…" }).map(
                    ([value, label]) => (
                      <Select.Item key={value} value={value}>
                        {label}
                      </Select.Item>
                    ),
                  )}
                </Select.Content>
              </Select.Root>
            </FormField>
            {model === "custom" && (
              <FormField
                label="Custom model id"
                htmlFor="custom-model"
                description='Format: "provider/model", e.g. openai/gpt-5.2-mini'
              >
                <TextField.Input
                  id="custom-model"
                  size="3"
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                />
              </FormField>
            )}
          </StepShell>
        )}

        {STEPS[step] === "Capabilities" && (
          <StepShell
            title="Capabilities"
            lead="Everything is on by default. Turning a feature off removes its tools from the deployment entirely."
          >
            <ul className="flex flex-col divide-y divide-gray-a4">
              {FEATURES.map((feature) => (
                <li key={feature.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-gray-12">
                      {feature.name}
                      {feature.needs !== null && features.has(feature.id) && (
                        <Badge variant="soft" color="gray">
                          needs {feature.needs}
                        </Badge>
                      )}
                    </p>
                    <p className="mt-0.5 text-sm text-gray-11">{feature.description}</p>
                  </div>
                  <Switch
                    aria-label={feature.name}
                    checked={features.has(feature.id)}
                    onCheckedChange={(checked) => toggleFeature(feature.id, checked)}
                  />
                </li>
              ))}
            </ul>
          </StepShell>
        )}

        {STEPS[step] === "Channels" && (
          <StepShell
            title="Channels"
            lead="Web chat is always on — it's the app itself. Add Telegram if you want your agent in your DMs."
          >
            <label className="flex w-fit items-center gap-3 text-sm font-medium text-gray-12">
              <Switch checked={telegramEnabled} onCheckedChange={setTelegramEnabled} />
              Telegram
            </label>
            {telegramEnabled && (
              <div className="mt-2 flex flex-col gap-4">
                <FormField
                  label="Bot token"
                  htmlFor="bot-token"
                  description="From @BotFather. The webhook is registered automatically after deploy."
                >
                  <TextField.Input
                    id="bot-token"
                    size="3"
                    type="password"
                    suppressHydrationWarning
                    value={telegramBotToken}
                    autoComplete="off"
                    onChange={(event) => setTelegramBotToken(event.target.value)}
                  />
                </FormField>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField label="Bot username" htmlFor="bot-username">
                    <TextField.Input
                      id="bot-username"
                      size="3"
                      value={telegramBotUsername}
                      placeholder="my_eve_bot"
                      onChange={(event) => setTelegramBotUsername(event.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="Allowed user ids"
                    htmlFor="allowed-ids"
                    description="Comma-separated Telegram user ids. Empty = anyone can DM it."
                  >
                    <TextField.Input
                      id="allowed-ids"
                      size="3"
                      value={telegramAllowedIds}
                      placeholder="12345678"
                      onChange={(event) => setTelegramAllowedIds(event.target.value)}
                    />
                  </FormField>
                </div>
              </div>
            )}
          </StepShell>
        )}

        {STEPS[step] === "Schedules" && (
          <StepShell
            title="Scheduled jobs"
            lead="Optional recurring work baked into the deployment — a morning brief, a nightly digest. Results land as new chat threads. (Your agent can also create reminders later from chat.)"
          >
            {schedules.map((schedule, index) => (
              <div key={index} className="rounded-xl border border-gray-a4 bg-panel p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_180px]">
                  <FormField label="Name" htmlFor={`schedule-name-${index}`}>
                    <TextField.Input
                      id={`schedule-name-${index}`}
                      size="3"
                      value={schedule.name}
                      placeholder="Morning brief"
                      onChange={(event) =>
                        setSchedules((prev) =>
                          prev.map((entry, i) =>
                            i === index ? { ...entry, name: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </FormField>
                  <FormField
                    label="Cron (UTC)"
                    htmlFor={`schedule-cron-${index}`}
                    description='e.g. "0 12 * * 1-5"'
                  >
                    <TextField.Input
                      id={`schedule-cron-${index}`}
                      size="3"
                      value={schedule.cron}
                      placeholder="0 12 * * *"
                      onChange={(event) =>
                        setSchedules((prev) =>
                          prev.map((entry, i) =>
                            i === index ? { ...entry, cron: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </FormField>
                </div>
                <div className="mt-4">
                  <FormField
                    label="Prompt"
                    htmlFor={`schedule-prompt-${index}`}
                    description="Instructions to the agent each time it fires. It wakes with no chat history, so include everything."
                  >
                    <TextArea
                      id={`schedule-prompt-${index}`}
                      size="3"
                      className="[&>textarea]:field-sizing-content [&>textarea]:min-h-16 [&>textarea]:max-h-48"
                      value={schedule.prompt}
                      placeholder="Check my calendar and email, then send me a brief of the day."
                      onChange={(event) =>
                        setSchedules((prev) =>
                          prev.map((entry, i) =>
                            i === index ? { ...entry, prompt: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </FormField>
                </div>
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="ghost"
                    color="red"
                    size="2"
                    onClick={() => setSchedules((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button
                variant="surface"
                size="3"
                onClick={() => setSchedules((prev) => [...prev, { name: "", cron: "", prompt: "" }])}
              >
                <Plus className="size-4" /> Add a scheduled job
              </Button>
            </div>
          </StepShell>
        )}

        {STEPS[step] === "Instructions" && (
          <StepShell
            title="Instructions"
            lead="Generated from your answers — edit freely. This becomes the agent's instructions.md."
          >
            <TextArea
              size="2"
              className="[&>textarea]:field-sizing-content [&>textarea]:min-h-96 [&>textarea]:max-h-[42rem] [&>textarea]:font-mono [&>textarea]:text-xs"
              value={instructions}
              aria-label="Agent instructions"
              onChange={(event) => {
                setInstructions(event.target.value);
                setInstructionsEdited(true);
              }}
            />
            <div>
              <Button
                variant="surface"
                size="2"
                onClick={() => {
                  setInstructions(regenerateInstructions());
                  setInstructionsEdited(false);
                }}
              >
                Reset to generated
              </Button>
            </div>
          </StepShell>
        )}

        {STEPS[step] === "Keys" && (
          <StepShell
            title="Keys & storage"
            lead="Storage comes from your Vercel account using the token you already gave — no pasting needed. Nothing is ever stored by the builder."
          >
            {stores === null ? (
              <ProgressNote text="Looking up databases and Blob stores on your account…" />
            ) : (
              <>
                {storesError !== null && (
                  <Callout.Root color="yellow">
                    <Callout.Icon>
                      <Info className="size-4" />
                    </Callout.Icon>
                    <Callout.Title>Couldn&apos;t list your Vercel storage</Callout.Title>
                    <Callout.Description>
                      {storesError} — you can still paste values manually.
                    </Callout.Description>
                  </Callout.Root>
                )}
                <FormField
                  label="Database"
                  description={
                    postgresChoice === "create"
                      ? "A fresh Neon Postgres database is provisioned on your account (free plan) and connected — DATABASE_URL is injected automatically."
                      : postgresChoice === "manual"
                        ? "Threads, reminders, and receipts. A free neon.tech database works — tables create themselves."
                        : "Connected to the new project during deploy; Vercel injects DATABASE_URL. Heads up: sharing a database with another agent shares its threads."
                  }
                >
                  <Select.Root
                    size="3"
                    items={databaseItems}
                    value={postgresChoice}
                    onValueChange={(value) => setPostgresChoice(value as string)}
                  >
                    <Select.Trigger className="w-full" aria-label="Database source" />
                    <Select.Content>
                      {Object.entries(databaseItems).map(([value, label]) => (
                        <Select.Item key={value} value={value}>
                          {label}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </FormField>
                {postgresChoice === "manual" && (
                  <FormField label="Postgres connection string" htmlFor="database-url">
                    <TextField.Input
                      id="database-url"
                      size="3"
                      type="password"
                      suppressHydrationWarning
                      value={databaseUrl}
                      placeholder="postgresql://…"
                      autoComplete="off"
                      onChange={(event) => setDatabaseUrl(event.target.value)}
                    />
                  </FormField>
                )}
                {keyNeeds.blob && (
                  <>
                    <FormField
                      label="Blob storage"
                      description="Skills + file sharing. Created and connected automatically — Vercel injects BLOB_READ_WRITE_TOKEN."
                    >
                      <Select.Root
                        size="3"
                        items={blobItems}
                        value={blobChoice}
                        onValueChange={(value) => setBlobChoice(value as string)}
                      >
                        <Select.Trigger className="w-full" aria-label="Blob storage source" />
                        <Select.Content>
                          {Object.entries(blobItems).map(([value, label]) => (
                            <Select.Item key={value} value={value}>
                              {label}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Root>
                    </FormField>
                    {blobChoice === "manual" && (
                      <FormField label="Vercel Blob token" htmlFor="blob-token">
                        <TextField.Input
                          id="blob-token"
                          size="3"
                          type="password"
                          suppressHydrationWarning
                          value={blobToken}
                          placeholder="vercel_blob_rw_…"
                          autoComplete="off"
                          onChange={(event) => setBlobToken(event.target.value)}
                        />
                      </FormField>
                    )}
                  </>
                )}
              </>
            )}
            {keyNeeds.supermemory && (
              <FormField
                label="Supermemory API key"
                htmlFor="supermemory-key"
                description="Long-term memory backend — supermemory.ai."
              >
                <TextField.Input
                  id="supermemory-key"
                  size="3"
                  type="password"
                  suppressHydrationWarning
                  value={supermemoryKey}
                  placeholder="sm_…"
                  autoComplete="off"
                  onChange={(event) => setSupermemoryKey(event.target.value)}
                />
              </FormField>
            )}
            {keyNeeds.composio && (
              <FormField
                label="Composio API key"
                htmlFor="composio-key"
                description="App integrations — composio.dev."
              >
                <TextField.Input
                  id="composio-key"
                  size="3"
                  type="password"
                  suppressHydrationWarning
                  value={composioKey}
                  placeholder="ck_…"
                  autoComplete="off"
                  onChange={(event) => setComposioKey(event.target.value)}
                />
              </FormField>
            )}
            <Text render={<p />} size="2" color="gray">
              Push notification keys are generated for you. Models run through your Vercel AI
              Gateway — no model provider keys needed.
            </Text>
          </StepShell>
        )}

        {STEPS[step] === "Deploy" && (
          <StepShell
            title="Review & deploy"
            lead={`Deploying "${projectName}" into ${scopeLabel ?? "your account"}.`}
          >
            {phase.kind === "idle" && (
              <>
                <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                  <SummaryRow label="Agent" value={`${agentName.trim()} (for ${ownerName.trim()})`} />
                  <SummaryRow label="Model" value={effectiveModel} />
                  <SummaryRow
                    label="Features"
                    value={FEATURES.filter((feature) => features.has(feature.id))
                      .map((feature) => feature.name)
                      .join(", ")}
                  />
                  <SummaryRow
                    label="Channels"
                    value={telegramEnabled ? "Web chat + Telegram" : "Web chat"}
                  />
                  <SummaryRow
                    label="Scheduled jobs"
                    value={schedules.length === 0 ? "None" : schedules.map((s) => s.name).join(", ")}
                  />
                  <SummaryRow
                    label="Env vars"
                    value={dryRun === null ? "…" : dryRun.envKeys.join(", ")}
                  />
                </dl>
                {dryRun !== null && (
                  <details className="text-sm text-gray-11">
                    <summary className="cursor-pointer select-none">
                      {dryRun.files.length} files will be deployed
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-gray-a2 p-3 text-xs">
                      {dryRun.files.join("\n")}
                    </pre>
                  </details>
                )}
                <Callout.Root color="blue">
                  <Callout.Icon>
                    <Info className="size-4" />
                  </Callout.Icon>
                  <Callout.Title>The deployed chat has no login</Callout.Title>
                  <Callout.Description>
                    Anyone with the URL can talk to your agent. Enable Vercel Deployment Protection
                    on the project if you want a gate.
                  </Callout.Description>
                </Callout.Root>
                <div>
                  <Button variant="classic" size="3" onClick={() => void deploy()}>
                    <Rocket className="size-4" /> Deploy to Vercel
                  </Button>
                </div>
              </>
            )}

            {phase.kind === "confirm-existing" && (
              <div className="flex flex-col gap-4">
                <Callout.Root color="yellow">
                  <Callout.Icon>
                    <Info className="size-4" />
                  </Callout.Icon>
                  <Callout.Title>Project already exists</Callout.Title>
                  <Callout.Description>{phase.message}</Callout.Description>
                </Callout.Root>
                <div className="flex items-center gap-3">
                  <Button variant="classic" color="yellow" size="3" onClick={() => void deploy(true)}>
                    Deploy into the existing project
                  </Button>
                  <Button variant="surface" size="3" onClick={() => setPhase({ kind: "idle" })}>
                    Cancel
                  </Button>
                </div>
                <Text render={<p />} size="1" color="gray">
                  To keep the existing project untouched, go back to Identity and pick a
                  different project name.
                </Text>
              </div>
            )}

            {phase.kind === "creating" && (
              <ProgressNote text="Creating the project, env vars, and deployment…" />
            )}

            {phase.kind === "building" && (
              <>
                <ProgressNote text="Vercel is building your agent — usually 2–4 minutes." />
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

            {phase.kind === "ready" && (
              <div className="flex flex-col gap-4">
                <Callout.Root color={phase.sessionOk ? "green" : "yellow"}>
                  <Callout.Icon>
                    {phase.sessionOk ? <CircleCheck className="size-4" /> : <Info className="size-4" />}
                  </Callout.Icon>
                  <Callout.Title>
                    {phase.sessionOk ? "Your agent is live" : "Deployed, but the agent isn't answering yet"}
                  </Callout.Title>
                  <Callout.Description>
                    {phase.sessionOk
                      ? "Health check and a test message both passed."
                      : "The app is up, but starting a conversation failed. If you recently deleted a project with this same name, Vercel serves stale identity tokens for up to ~2 hours — wait, then redeploy from your Vercel dashboard (or rename the project and redeploy). Otherwise check the runtime logs."}
                  </Callout.Description>
                </Callout.Root>
                <a
                  href={`https://${phase.url}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-lg font-semibold text-gray-12 underline"
                >
                  {phase.url}
                </a>
                <ul className="flex flex-col gap-1.5 text-sm text-gray-11">
                  <li>• Open the chat and say hi — the first reply may take a few seconds.</li>
                  <li>• Enable notifications (bell icon) for proactive reminders.</li>
                  {features.has("integrations") && <li>• Connect apps under Manage → Connections.</li>}
                  {telegramEnabled && (
                    <li>
                      • Telegram webhook:{" "}
                      {phase.telegramWebhook === "set"
                        ? "registered ✓"
                        : "registration failed — check the bot token"}
                    </li>
                  )}
                  <li>
                    • Want a login gate? Enable Deployment Protection in your Vercel project
                    settings.
                  </li>
                </ul>
              </div>
            )}

            {phase.kind === "error" && (
              <div className="flex flex-col gap-3">
                <Callout.Root color="red">
                  <Callout.Icon>
                    <TriangleAlert className="size-4" />
                  </Callout.Icon>
                  <Callout.Title>Deploy failed ({phase.stage})</Callout.Title>
                  <Callout.Description>{phase.message}</Callout.Description>
                </Callout.Root>
                {phase.log !== null && (
                  <pre className="max-h-64 overflow-auto rounded-lg bg-gray-a2 p-3 text-xs">
                    {phase.log}
                  </pre>
                )}
                <div>
                  <Button variant="surface" size="2" onClick={() => setPhase({ kind: "idle" })}>
                    Back to review
                  </Button>
                </div>
              </div>
            )}
          </StepShell>
        )}

        {/* Footer nav */}
        {!(STEPS[step] === "Deploy" && phase.kind !== "idle") && (
          <div className="mt-8 flex items-center justify-between border-t border-gray-a4 pt-5">
            <Button variant="ghost" size="2" color="gray" disabled={step === 0} onClick={() => goTo(step - 1)}>
              <ArrowLeft className="size-4" /> Back
            </Button>
            {step < STEPS.length - 1 && (
              <Button variant="classic" size="3" disabled={!stepValid(step)} onClick={() => goTo(step + 1)}>
                Continue <ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StepShell({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      <header>
        <Heading size="6">{title}</Heading>
        <Text render={<p />} size="2" color="gray" className="mt-1.5 max-w-xl">
          {lead}
        </Text>
      </header>
      {children}
    </section>
  );
}

function FormField({
  label,
  htmlFor,
  description,
  children,
}: {
  label: string;
  htmlFor?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Text render={<label htmlFor={htmlFor} />} size="2" weight="medium">
        {label}
      </Text>
      {children}
      {description !== undefined && (
        <Text render={<p />} size="1" color="gray">
          {description}
        </Text>
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-gray-11">{label}</dt>
      <dd className="text-gray-12">{value}</dd>
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
