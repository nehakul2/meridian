"use client";
/**
 * Everything a component talks to (REST, Tx Builder, gateway, RPC) comes from this context,
 * so the component tests can hand in fakes and the pages never construct clients themselves.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createApi, type ApiClient } from "./api";
import { config as defaultConfig, type AppConfig } from "./config";
import { createRpc, type Rpc } from "./rpc";
import { createRealtime, type Realtime, type WsMessage } from "./ws";

export interface Services {
  api: ApiClient;
  rt: Realtime;
  rpc: Rpc;
  config: AppConfig;
}

const Ctx = createContext<Services | null>(null);

export function ServicesProvider({ value, children }: { value?: Services; children: ReactNode }) {
  const [s] = useState<Services | null>(() => value ?? null);
  const [made, setMade] = useState<Services | null>(null);
  useEffect(() => {
    if (s) return;
    const cfg = defaultConfig;
    const built: Services = { api: createApi(cfg.apiUrl, cfg.txbUrl), rt: createRealtime(cfg.wsUrl), rpc: createRpc(cfg.rpcUrl, cfg.usdcMint), config: cfg };
    setMade(built);
    return () => built.rt.close();
  }, [s]);
  const v = s ?? made;
  if (!v) return null; // first client render; static HTML has the shell from the layout
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useServices(): Services {
  const s = useContext(Ctx);
  if (!s) throw new Error("useServices outside ServicesProvider");
  return s;
}

/** Listen to one gateway channel for the life of the component. */
export function useChannel(channel: string | null, handler: (m: WsMessage) => void) {
  const { rt } = useServices();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!channel) return;
    return rt.subscribe(channel, (m) => ref.current(m));
  }, [rt, channel]);
}
