/** "michael@example.com" -> "m•••@example.com"; null when not an email. */
export function maskEmail(address: string): string | null {
  const at = address.indexOf("@");
  if (at < 1 || at === address.length - 1) return null;
  return `${address[0]}•••${address.slice(at)}`;
}
