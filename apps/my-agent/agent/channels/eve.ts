import { httpBasic, localDev, vercelOidc, type AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// Single-user web chat: HTTP Basic with credentials from the environment.
// If the env vars are missing, the walk exhausts and requests get a 401
// (fail closed), so a misconfigured deploy never opens the agent up.
function webBasicAuth(): AuthFn<Request>[] {
  const username = process.env.EVE_WEB_USERNAME;
  const password = process.env.EVE_WEB_PASSWORD;
  if (!username || !password) return [];
  return [httpBasic({ username, password }, { realm: "eve-agent" })];
}

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    ...webBasicAuth(),
  ],
});
