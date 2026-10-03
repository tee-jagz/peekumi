/** @module Peek, the Peekumi mascot, as an inline SVG whose state is animated by CSS.
 * States: `idle` blinks and glances, `loading` bobs and scans, `thinking` looks up with
 * thought dots, `success` hops with a happy eye, `error` sinks with a droopy eye, `empty`
 * peeks up, looks around and ducks back down, `working` reads while its layers lift and
 * settle in turn (an agent running), `peeking` ducks behind its layers and looks over them
 * (Ask lookups), `ready` bounces once and waits (a task to review), `merged` slides its
 * layers into one with a sparkle (applied to main), `asleep` breathes with its eye closed
 * (offline) and `stopped` droops with its layers out of line (a task that stopped). Reduced
 * motion holds each state still. The drawing is a fixed template with no inserted text, so
 * building it from markup is safe. */

let instances = 0;

/** Returns a decorative Peek element (`span.peek-mark`) in the given state. `tiled` adds the
 * dark app-icon tile; `className` adds classes that size it for its context. */
export function peek(state = "idle", { tiled = false, className = "" } = {}) {
  const s = "peek" + ++instances;
  const host = document.createElement("span");
  host.className = `peek-mark ${className}`.trim();
  host.dataset.state = state;
  host.setAttribute("aria-hidden", "true");
  host.innerHTML = `<svg viewBox="0 0 200 200" class="peek is-${state}${tiled ? " tiled" : ""}" focusable="false">
<defs>
<radialGradient id="${s}-tile" cx="50%" cy="36%" r="78%"><stop offset="0" stop-color="#1b4a44"/><stop offset="1" stop-color="#0a1a19"/></radialGradient>
<radialGradient id="${s}-dome" cx="36%" cy="26%" r="82%"><stop offset="0" stop-color="#78e2c0"/><stop offset=".42" stop-color="#36a98a"/><stop offset="1" stop-color="#1a6553"/></radialGradient>
<linearGradient id="${s}-mint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bff7e6"/><stop offset="1" stop-color="#68cfb0"/></linearGradient>
<linearGradient id="${s}-sand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5e2bf"/><stop offset="1" stop-color="#cda874"/></linearGradient>
<linearGradient id="${s}-clay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfa673"/><stop offset="1" stop-color="#916a40"/></linearGradient>
<radialGradient id="${s}-sclera" cx="42%" cy="32%" r="72%"><stop offset="0" stop-color="#fff"/><stop offset=".7" stop-color="#f1f7f5"/><stop offset="1" stop-color="#c9ddd8"/></radialGradient>
<radialGradient id="${s}-iris" cx="50%" cy="50%" r="50%"><stop offset=".5" stop-color="#0d2120"/><stop offset=".85" stop-color="#1f564d"/><stop offset="1" stop-color="#2c7466"/></radialGradient>
<clipPath id="${s}-horizon"><rect width="200" height="127"/></clipPath>
<clipPath id="${s}-eye"><circle cx="100" cy="94" r="22"/></clipPath>
</defs>
<rect class="tile" width="200" height="200" rx="44" fill="url(#${s}-tile)"/>
<g clip-path="url(#${s}-horizon)"><g class="head">
<circle cx="100" cy="122" r="60" fill="url(#${s}-dome)"/>
<ellipse cx="74" cy="84" rx="15" ry="7" fill="#fff" opacity=".2" transform="rotate(-34 74 84)"/>
<g class="open">
<circle cx="100" cy="94" r="22" fill="url(#${s}-sclera)"/>
<circle cx="100" cy="94" r="22" fill="none" stroke="#0c2724" stroke-opacity=".28" stroke-width="2"/>
<g class="pupil"><circle cx="105" cy="91" r="11.5" fill="url(#${s}-iris)"/><circle cx="109" cy="86.5" r="3.6" fill="#fff"/><circle cx="101.5" cy="95.5" r="1.5" fill="#fff" opacity=".75"/></g>
<g clip-path="url(#${s}-eye)"><rect class="lid" x="76" y="70" width="48" height="48" fill="#33a385"/></g>
</g>
<g class="squint"><path d="M84 90 Q100 106 116 90" fill="none" stroke="#0d2120" stroke-width="5.5" stroke-linecap="round"/><ellipse cx="74" cy="106" rx="8" ry="4.5" fill="#ff9aa8" opacity=".55"/><ellipse cx="126" cy="106" rx="8" ry="4.5" fill="#ff9aa8" opacity=".55"/></g>
</g></g>
<ellipse cx="100" cy="128" rx="56" ry="4.5" fill="#050f0e" opacity=".3"/>
<g class="l1"><rect x="24" y="125" width="152" height="15" rx="7.5" fill="url(#${s}-mint)"/>
<rect x="30" y="126.5" width="140" height="3.5" rx="1.75" fill="#fff" opacity=".45"/></g>
<g class="l2"><rect x="40" y="148" width="120" height="13" rx="6.5" fill="url(#${s}-sand)"/>
<rect x="46" y="149.5" width="108" height="3" rx="1.5" fill="#fff" opacity=".35"/></g>
<g class="l3"><rect x="58" y="169" width="84" height="12" rx="6" fill="url(#${s}-clay)"/>
<rect x="64" y="170.5" width="72" height="2.6" rx="1.3" fill="#fff" opacity=".25"/></g>
<g class="dots"><circle cx="138" cy="44" r="5" fill="#68cfb0"/><circle cx="152" cy="32" r="6.5" fill="#68cfb0"/><circle cx="168" cy="20" r="8" fill="#68cfb0"/></g>
<g class="zz" fill="#9fd9c7"><circle cx="140" cy="62" r="5"/><circle cx="156" cy="46" r="3.5"/></g>
<g class="sparkle" fill="#f2c94c"><path d="M44 52l3 9 9 3-9 3-3 9-3-9-9-3 9-3z"/><path d="M156 40l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></g>
</svg>`;
  return host;
}
