"use client";

import { useSyncExternalStore } from "react";
import { CommandEmpty, CommandPage } from "../command-center/CommandPage";
import { useClientAccess } from "../../hooks/ClientAccessContext";
import { AgentInspectorSection, AgentRosterSection, InspectorSheetSection } from "./DesignSystemAgentSamples";
import { AgentGridSection } from "./DesignSystemAgentGridSample";
import { RepositorySetupSection, RevisionEvidenceSection } from "./DesignSystemRepositorySamples";
import { ButtonsSection, ChipsSection, FormFieldsSection, PanelsSection } from "./DesignSystemControlSamples";
import { FileHistoryPanelSection, FileTreeSection } from "./DesignSystemFileSamples";
import { CacheRefillEvidenceSection, RequestChartsSection, RoleFamilySection } from "./DesignSystemRequestSamples";
import { ShellSection, StorageUsageSection, TypographySection } from "./DesignSystemShellSamples";
import { EventsRailSection } from "./DesignSystemEventsSample";
import { SessionTerminalSection } from "./DesignSystemTerminalSample";
import { HomeSection, HomeUpdateSection } from "./DesignSystemHomeUpdateSample";
import { TaskFieldsSection } from "./DesignSystemTaskFieldsSample";
import { TaskBoardSection } from "./DesignSystemTaskBoardSample";
import { TaskPlanSection } from "./DesignSystemTaskPlanSample";
import { QueueControlsSection, TaskGatesSection } from "./DesignSystemTaskGatesSample";
import { PromoteIssuesSection } from "./DesignSystemPromoteIssuesSample";
import { ScorecardSection } from "./DesignSystemScorecardSample";
import { GitHubSettingsSection } from "./DesignSystemGitHubSettingsSample";
import { AgentChatSection } from "./DesignSystemAgentChatSample";
import { SessionTaskSection } from "./DesignSystemSessionTaskSample";
import { AssignedSessionsSection } from "./DesignSystemAssignedSessionsSample";
import { CommandTableSection, SettingsRailSection } from "./DesignSystemLayoutSamples";

function subscribeAvailability() { return () => {}; }
function isDesktopRuntime() {
  return typeof window !== "undefined" && Boolean((window as Window & { pomegrDesktop?: unknown }).pomegrDesktop);
}

export function DesignSystemUnavailable() {
  return <CommandPage title="Not found" description="This page is not part of the Pomegr application.">
    <CommandEmpty icon="close" title="Design system unavailable here" detail="The design-system reference renders only on the web development server. It never appears in the desktop app, in phone access, or in navigation." />
  </CommandPage>;
}

export function DesignSystemView() {
  const desktop = useSyncExternalStore(subscribeAvailability, isDesktopRuntime, () => false);
  const { mode } = useClientAccess();
  if (desktop || mode === "lan") return <DesignSystemUnavailable />;
  return <CommandPage title="Design system" description="Every control below is the real shared class or component, rendered with static sample data. Nothing on this page reads session state.">
    <ButtonsSection />
    <FormFieldsSection />
    <ShellSection />
    <StorageUsageSection />
    <RoleFamilySection />
    <RequestChartsSection />
    <CacheRefillEvidenceSection />
    <AgentRosterSection />
    <AgentGridSection />
    <AgentInspectorSection />
    <InspectorSheetSection />
    <ChipsSection />
    <FileTreeSection />
    <FileHistoryPanelSection />
    <RepositorySetupSection />
    <RevisionEvidenceSection />
    <PanelsSection />
    <EventsRailSection />
    <SessionTerminalSection />
    <HomeSection />
    <HomeUpdateSection />
    <TaskFieldsSection />
    <TaskBoardSection />
    <TaskPlanSection />
    <QueueControlsSection />
    <TaskGatesSection />
    <ScorecardSection />
    <SessionTaskSection />
    <AssignedSessionsSection />
    <PromoteIssuesSection />
    <GitHubSettingsSection />
    <AgentChatSection />
    <CommandTableSection />
    <SettingsRailSection />
    <TypographySection />
  </CommandPage>;
}
