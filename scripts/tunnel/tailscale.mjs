/** @module Tailscale tunnel provider for dependency diagnostics and private HTTPS sharing. */

/**
 * Creates a provider using a synchronous command runner that returns stdout and
 * throws on command failure. No commands run until a provider method is called.
 * @param {(program: string, args: string[]) => string} run Command runner.
 * @returns {object} Tunnel availability, status, exposure and URL operations.
 */
export function createTailscaleProvider(run) {
  return {
    /** Reports CLI availability and its first version line; failures become an install hint. */
    available() {
      try {
        return {
          ok: true,
          detail: run("tailscale", ["version"]).split("\n")[0],
        };
      } catch {
        return {
          ok: false,
          detail: "Install Tailscale to enable its optional integration",
        };
      }
    },

    /**
     * Reads the signed-in DNS host and current Serve configuration without changing either.
     * Throws on command/JSON errors or a missing host, before reading Serve configuration.
     * @returns {{host: string, configuration: object}} Current tunnel status.
     */
    status() {
      const ts = JSON.parse(run("tailscale", ["status", "--json"]));
      const host = ts.Self?.DNSName?.replace(/\.$/, "");
      if (!host) throw new Error("Sign into Tailscale first");
      const configuration = JSON.parse(
        run("tailscale", ["serve", "status", "--json"]),
      );
      return { host, configuration };
    },

    /**
     * Exposes a loopback port through private tailnet Serve, never Funnel.
     * Throws if the supplied status has another configuration or the command fails.
     * @param {number} port Local Peekumi port.
     * @param {{configuration: object}} status Status read before exposure.
     */
    expose(port, status) {
      const target = `http://127.0.0.1:${port}`;
      if (
        Object.keys(status.configuration).length &&
        !JSON.stringify(status.configuration).includes(target)
      )
        throw new Error(
          "Tailscale Serve already has another configuration. Keep it intact and configure a separate HTTPS endpoint for Peekumi.",
        );
      run("tailscale", ["serve", "--bg", target]);
    },

    /**
     * Returns the HTTPS origin from a previously read status without running commands.
     * @param {{host: string}} status Signed-in tunnel status.
     * @returns {string} Phone-facing HTTPS origin.
     */
    url(status) {
      return "https://" + status.host;
    },
  };
}
