"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { TradeView } from "@/components/TradeView";
import type { Intent } from "@/lib/types";

const INTENTS = ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"];

function Inner() {
  const q = useSearchParams();
  const i = q?.get("intent") ?? "";
  return <TradeView marketId={q?.get("m") ?? null} intent={INTENTS.includes(i) ? (i as Intent) : undefined} />;
}

export default function Page() {
  return <Suspense><Inner /></Suspense>;
}
