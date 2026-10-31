import { render } from "@testing-library/react";
import { AgentChatDock } from "../../app/components/agent-chat/AgentChatDock";
import { settle } from "./agent-chat-fixture";

/**
 * Renders the dock and lets it learn the switch. The dock draws nothing of Aril until the desktop has said whether Aril is On, so a test that looks
 * for the launcher right after the render would look before it exists.
 */
export async function renderDock() {
  const view = render(<AgentChatDock />);
  await settle();
  return view;
}
