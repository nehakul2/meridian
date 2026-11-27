"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { MarketsView } from "@/components/Markets";

function Inner() {
  const t = useSearchParams()?.get("t");
  return <MarketsView initial={t ? t.toUpperCase() : null} />;
}

export default function Page() {
  return <Suspense><Inner /></Suspense>;
}
