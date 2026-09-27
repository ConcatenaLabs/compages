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

// How soon an alert whose delivery failed is tried again.
const RETRY_MS = 5 * 60_000;

export class Alerts {
  constructor(cfg, log) {
    this.url = cfg.alertUrl ?? null;
    this.token = cfg.alertToken ?? null;
    this.cooldownMs = (cfg.alertCooldownMinutes ?? 360) * 60_000;
    this.log = log;
    this.active = new Map(); // key -> { nextAt, title }
  }

  /** Raise (or keep raising) the alert `key`. */
  async raise(key, title, message, { priority = 4, tags = ["warning"] } = {}) {
    const now = Date.now();
    const prev = this.active.get(key);
    if (prev && now < prev.nextAt) return;
    this.log(`ALERT ${title}: ${message}`);
    const delivered = await this.post(title, message, priority, tags);
    // An alert that never reached the operator has not been sent: try it
    // again soon rather than staying silent for the whole cooldown.
    const wait = delivered ? this.cooldownMs : Math.min(this.cooldownMs, RETRY_MS);
    this.active.set(key, { nextAt: now + wait, title });
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

  /** Send one message. Answers whether it was delivered (true when no
   *  alert URL is configured, since the log is then the only channel). */
  async post(title, message, priority, tags) {
    if (!this.url) return true;
    try {
      const res = await fetch(this.url, {
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
      if (!res.ok) {
        this.log(`alert delivery failed: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      this.log(`alert delivery failed: ${e.message}`);
      return false;
    }
  }
}
