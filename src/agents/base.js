// An agent decides entries; exits are applied by the team from the same config.
export class Agent {
  constructor(name, cfg, global) {
    this.name = name;
    this.cfg = cfg;
    this.global = global;
    this.style = cfg.style;
  }

  mcapUsd(token) { return token.mcapSol * this.global.solUsd; }

  // Returns { action: 'buy' | 'watch', reason } or null.
  evaluate(_token, _now, _market) { return null; }
}
