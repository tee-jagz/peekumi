/** @module Strict share argument parsing; public tunnels require an explicit CLI choice. */

/**
 * Returns tailscale by default, or an explicitly selected provider. Rejects unknown,
 * duplicate and incomplete arguments before any commands, downloads or state writes.
 * @param {string[]} args Arguments after share; environment/configuration cannot opt in.
 * @returns {"tailscale"|"cloudflare"} Requested provider.
 */
export function tunnelName(args) {
  if (!args.length) return "tailscale";
  if (args.length === 2 && args[0] === "--tunnel" && ["tailscale", "cloudflare"].includes(args[1]))
    return args[1];
  throw new Error("Use peekumi share [--tunnel tailscale|cloudflare]; Cloudflare requires explicit --tunnel cloudflare and exposes a public URL");
}
