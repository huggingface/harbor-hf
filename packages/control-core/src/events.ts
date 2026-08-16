export interface ControlEvent {
  id: string;
  type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

export type EventListener = (event: ControlEvent) => void;

export function eventCursor(occurredAt: string, key: string): string {
  return Buffer.from(`${occurredAt}\u0000${key}`, "utf8").toString("base64url");
}

export function decodeEventCursor(cursor: string): {
  occurred_at: string;
  key: string;
} {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("\u0000");
  if (separator < 1 || separator === decoded.length - 1)
    throw new Error("invalid event cursor");
  return {
    occurred_at: decoded.slice(0, separator),
    key: decoded.slice(separator + 1),
  };
}

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  publish(event: ControlEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
