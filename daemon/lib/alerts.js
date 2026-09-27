// Push alerts for the things an operator must hear about without watching a
// page: a record that needs a person, a phase that stopped succeeding, a
// balance about to stop the bridge, a supply invariant that broke.
//
// Delivery is an HTTP POST to `alertUrl`, in the form ntfy accepts
// (https://ntfy.sh/<topic>, or a self-hosted server): the body is the message,
// and `Title`, `Priority` and `Tags` ride in headers. Any endpoint that takes a
// plain-text POST works. With no `alertUrl` configured, alerts go to the log
// only.
//
// Each alert has a key. The same key is sent at most once per `cooldownMs`
// while it stays active, and a single "resolved" note is sent when it clears,
// so a condition that lasts a day produces a few messages rather than a
// thousand.

export class Alerts {
  constructor(cfg, log) {
    this.url = cfg.alertUrl ?? null;
    this.token = cfg.alertToken ?? null;
    this.cooldownMs = (cfg.alertCooldownMinutes ?? 360) * 60_000;
    this.log = log;
    this.active = new Map(); // key -> { lastSent, title }
  }

  /** Raise (or keep raising) the alert `key`. */
  async raise(key, title, message, { priority = 4, tags = ["warning"] } = {}) {
    const now = Date.now();
    const prev = this.active.get(key);
    if (prev && now - prev.lastSent < this.cooldownMs) return;
    this.active.set(key, { lastSent: now, title });
    this.log(`ALERT ${title}: ${message}`);
    await this.post(title, message, priority, tags);
  }

  /** Clear every active alert whose key is not in `stillActive`, telling the
   *  operator once that it resolved. */
  async settle(stillActive) {
    for (const [key, a] of this.active) {
      if (stillActive.has(key)) continue;
      this.active.delete(key);
      this.log(`RESOLVED ${a.title}`);
      await this.post(`Resolved: ${a.title}`, "The condition has cleared.", 2, ["white_check_mark"]);
    }
  }

  async post(title, message, priority, tags) {
    if (!this.url) return;
    try {
      await fetch(this.url, {
        method: "POST",
        headers: {
          Title: `Compages: ${title}`.slice(0, 250),
          Priority: String(priority),
          Tags: tags.join(","),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: message,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.log(`alert delivery failed: ${e.message}`);
    }
  }
}
