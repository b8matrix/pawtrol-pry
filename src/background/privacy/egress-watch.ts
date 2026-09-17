// Counts the page's own outbound requests that the MAIN-world tripwire caught
// carrying PII, and renders the one-line summary shown in the transcript.

export interface TripwireAlert {
  url: string;
  method: string;
  piiType: string;
  sample: string;
  timestamp: number;
}

export function createEgressWatch() {
  let total = 0;
  const byType = new Map<string, number>();
  const byHost = new Map<string, number>();

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "") || "(unknown)";
    } catch {
      return "(unknown)";
    }
  }

  function summary(): string {
    const parts = [...byType.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, count]) => `${type} \xD7${count}`);
    const head = total === 1 ? "1 outbound PII leak blocked" : `${total} outbound PII leaks blocked`;
    return parts.length > 0 ? `${head} \xB7 ${parts.join(" \xB7 ")}` : head;
  }

  return {
    bump(alert: Pick<TripwireAlert, "piiType" | "url">): string {
      const type = String(alert.piiType || "PII").toUpperCase();
      total++;
      byType.set(type, (byType.get(type) ?? 0) + 1);
      const host = hostOf(alert.url);
      byHost.set(host, (byHost.get(host) ?? 0) + 1);
      return summary();
    },
    summary,
    total: () => total,
    counts: () => byType,
    hosts: () => byHost,
    reset: () => {
      total = 0;
      byType.clear();
      byHost.clear();
    },
  };
}
