/**
 * WebSocket client for the gateway (spec 7.5, MER-65). One connection per tab; channels are
 * reference counted so several components can listen to the same `book:` or `px:` channel.
 * Reconnects with backoff and re-sends `auth` and every subscription, so a book channel gets
 * a fresh snapshot after a reconnect.
 */
export type WsMessage = { type: string; channel?: string; [k: string]: unknown };
type Handler = (m: WsMessage) => void;

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Realtime {
  subscribe(channel: string, h: Handler): () => void;
  /** Ask for a fresh `book_snapshot` on a subscribed book channel (seq gap). */
  snapshot(channel: string): void;
  auth(token: string | null): void;
  /** Messages without a channel (heartbeat, pong, auth_ok, errors). */
  onSystem(h: Handler): () => void;
  close(): void;
}

export function createRealtime(url: string, make: (u: string) => SocketLike = (u) => new WebSocket(u) as unknown as SocketLike): Realtime {
  const handlers = new Map<string, Set<Handler>>();
  const system = new Set<Handler>();
  let sock: SocketLike | null = null;
  let token: string | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const send = (o: object) => {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(o));
  };

  function connect() {
    if (closed) return;
    try {
      sock = make(url);
    } catch {
      schedule();
      return;
    }
    sock.onopen = () => {
      attempt = 0;
      if (token) send({ op: "auth", token });
      const chans = [...handlers.keys()].filter((c) => c !== "user");
      for (let i = 0; i < chans.length; i += 50) send({ op: "subscribe", channels: chans.slice(i, i + 50) });
    };
    sock.onmessage = (ev) => {
      let m: WsMessage;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === "auth_ok" && handlers.has("user")) send({ op: "subscribe", channels: ["user"] });
      if (m.channel) {
        for (const h of handlers.get(m.channel) ?? []) h(m);
      } else {
        for (const h of system) h(m);
      }
    };
    sock.onclose = () => {
      sock = null;
      schedule();
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  }

  function schedule() {
    if (closed || timer) return;
    const delay = Math.min(10_000, 500 * 2 ** attempt++);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    subscribe(channel, h) {
      let set = handlers.get(channel);
      const fresh = !set;
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(h);
      if (fresh && (channel !== "user" || token)) send({ op: "subscribe", channels: [channel] });
      return () => {
        const s = handlers.get(channel);
        if (!s) return;
        s.delete(h);
        if (s.size === 0) {
          handlers.delete(channel);
          send({ op: "unsubscribe", channels: [channel] });
        }
      };
    },
    snapshot(channel) {
      send({ op: "snapshot", channel });
    },
    auth(t) {
      token = t;
      if (t) send({ op: "auth", token: t });
    },
    onSystem(h) {
      system.add(h);
      return () => system.delete(h);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      sock?.close();
    },
  };
}
