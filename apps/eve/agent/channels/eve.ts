import {
  httpBasic,
  localDev,
  placeholderAuth,
  vercelOidc,
} from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const username = process.env.WEB_AUTH_USERNAME?.trim();
const password = process.env.WEB_AUTH_PASSWORD?.trim();
const webAuth =
  username && password
    ? httpBasic({ username, password }, { realm: "Ruth" })
    : placeholderAuth();

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // The personal web app fails closed in production until owner credentials
    // are configured. Browsers cache the Basic credential for same-origin API,
    // image, and stream requests after the first challenge.
    webAuth,
  ],
});
