// An agent decides entries; exits are applied by the team from the same config.
export class Agent {
  constructor(name, cfg, global) {
    this.name = name;
    this.cfg = cfg;
    this.global = global;
    this.style = cfg.style;
    this.funnel = {};
  }

  mcapUsd(token) { return token.mcapSol * this.global.solUsd; }

  // Counts why tokens were rejected during the current scan (shown on the dashboard).
  no(reason) {
    this.funnel[reason] = (this.funnel[reason] || 0) + 1;
    return null;
  }

  // Returns { action: 'buy' | 'watch', reason } or null.
  evaluate(_token, _now, _market) { return null; }
}
