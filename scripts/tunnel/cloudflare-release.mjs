/** @module Pinned cloudflared release assets; updating requires reviewing upstream asset digests. */

// GitHub's release asset digests, not the release-body checksums (macOS differs):
// https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.9.3
export const CLOUDFLARED_VERSION = "2026.9.3";
export const CLOUDFLARED_ASSETS = Object.freeze({
  "darwin-x64": { name: "cloudflared-darwin-amd64.tgz", sha256: "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977" },
  "darwin-arm64": { name: "cloudflared-darwin-arm64.tgz", sha256: "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095" },
  "linux-x64": { name: "cloudflared-linux-amd64", sha256: "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2" },
  "linux-arm64": { name: "cloudflared-linux-arm64", sha256: "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d" },
});
