/**
 * Identity of the agent template baked into this deployment. The builder
 * overwrites this file at assemble time so update-check can read the running
 * code's release — not project env vars that can drift when a deploy fails.
 *
 * Empty values mean "not a builder deployment" (personal/dev app).
 */
export const TEMPLATE_STAMP: { version: string; release: number | null } = {
  version: "",
  release: null,
};
