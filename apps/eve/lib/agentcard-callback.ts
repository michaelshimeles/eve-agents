/**
 * Where Agentcard sends the owner back after he signs in. Shared because the
 * value is registered with Agentcard by the connect route and must be repeated
 * byte-for-byte when the callback route redeems the code.
 */
export const AGENTCARD_CALLBACK_PATH = "/api/agentcard/callback";
