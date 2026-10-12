"use client";

import { useEffect, useState } from "react";
import { readDesktopFeature, type FeatureDetails } from "./task-desktop";

export type FeatureDetailsRead = { state: "pending" } | { state: "failed" } | ({ state: "ready" } & FeatureDetails);

/** Reads one feature (none for null)'s description and app version once, when the Feature modal opens. */
export function useFeatureDetails(repositoryId: string, featureId: string | null): FeatureDetailsRead {
  const [read, setRead] = useState<{ key: string; result: FeatureDetailsRead } | null>(null);
  const key = `${repositoryId}:${featureId}`;
  useEffect(() => {
    if (featureId === null) return undefined;
    let current = true;
    void readDesktopFeature(repositoryId, featureId).then((answer) => {
      if (current) setRead({ key, result: answer.ok ? { state: "ready", description: answer.description, appVersion: answer.appVersion } : { state: "failed" } });
    });
    return () => { current = false; };
  }, [key, repositoryId, featureId]);
  return read?.key === key ? read.result : { state: "pending" };
}
