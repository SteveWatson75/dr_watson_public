import type { TaskTier } from "../config.js";
import { taskTier } from "../routing/provider-chain.js";
import type { ChatMessage, CompletionInput } from "./protocol.js";

export const TIER_RANK: Readonly<Record<TaskTier, number>> = { cheap: 0, standard: 1, hard: 2 };
const continuationOnly =
  /^(?:continue|go on|proceed|carry on|keep going|do it|go ahead|yes|ok|okay)[.!\s]*$/i;
// Mirrors provider-chain CODE_REVIEW_REQUEST for bounded-mode review detection.
const REVIEW_REQUEST =
  /\b(?:code review|(?:pull request|pr) review|review(?:ing)? (?:of )?(?:(?:this|the|my|these) )?(?:pull request|pr|code|changes|diff))\b/i;
export const BOUNDED_REVIEW_MARKER = /BOUNDED REVIEW MODE/;
const BOUNDED_REVIEW_INSTRUCTION = `BOUNDED REVIEW MODE: Review only the PR description, the linked issue, and the file diff already provided. Do not call tools, fetch additional files or commits, or search. Write the review now and end with **Approved** or **Has blocking changes needed**.`;

function messageText(value: ChatMessage): string {
  return typeof value.content === "string"
    ? value.content
    : (value.content?.map((part) => part.text).join("\n") ?? "");
}

function normalizeUserText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function isOpenCodeStateSummary(text: string): boolean {
  const markers = ["objective", "requirements", "work state", "next move"];
  const lower = text.toLowerCase();
  return (
    markers.filter((marker) =>
      new RegExp(`(?:^|\\n)#{0,3}\\s*${marker}\\s*(?:\\n|$)`, "i").test(lower),
    ).length >= 3
  );
}

export function isOpenCodeCompactionRequest(messages: CompletionInput["messages"]): boolean {
  const lastUser = [...messages].reverse().find((item) => item.role === "user");
  const text = lastUser ? messageText(lastUser) : "";
  // V2's first checkpoint has a different instruction from subsequent updates.
  // Without this check its headings are mistaken for an existing state summary
  // and prepareOpenCodeMessages removes the actual compaction request.
  if (
    text.startsWith(
      "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
    )
  )
    return true;
  return /(?:consolidated summary|update the existing checkpoint|compaction summary|summarize the conversation into)/i.test(
    text,
  );
}

function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^#{0,3}\\s*${heading}\\s*$`, "i").test(line.trim()),
  );
  if (start < 0) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s*[A-Za-z]/.test(line.trim()) && line.trim().length < 80) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

function completedContext(text: string): string {
  const completed = section(text, "Completed");
  if (!completed) return "";
  return `OpenCode progress already completed (context only; do not restart it):\n${completed}`;
}

function summaryTask(text: string): string {
  const objective = section(text, "Objective");
  const requirements = section(text, "Requirements");
  return [objective && `Objective:\n${objective}`, requirements && `Requirements:\n${requirements}`]
    .filter(Boolean)
    .join("\n\n");
}

function taskAnchorMessage(anchor: string): ChatMessage {
  return {
    role: "developer",
    content: `Task anchor (original user intent):\n${anchor}\n\nStay focused on this task until completion. Do not restart completed reconnaissance unless a concrete tool/test failure requires it.`,
  };
}

export function prepareOpenCodeMessages(
  messages: CompletionInput["messages"],
): CompletionInput["messages"] {
  if (isOpenCodeCompactionRequest(messages)) return messages;
  const summaries = messages.filter((item) => isOpenCodeStateSummary(messageText(item)));
  const genuineUsers = messages.filter(
    (item) =>
      item.role === "user" &&
      !isOpenCodeStateSummary(messageText(item)) &&
      !continuationOnly.test(messageText(item).trim()),
  );
  const anchor = genuineUsers.length
    ? messageText(genuineUsers[0]!)
    : summaryTask(messageText(summaries.at(-1) ?? messages[0]!));
  const latestProgress = completedContext(messageText(summaries.at(-1) ?? messages[0]!));
  const seenUsers = new Set<string>();
  const result: CompletionInput["messages"] = [];
  let injectedAnchor = false;

  for (const item of messages) {
    const text = messageText(item);
    const stateSummary = isOpenCodeStateSummary(text);
    if (stateSummary && !(item.role === "assistant" && item.tool_calls?.length)) continue;
    if (item.role === "user") {
      if (continuationOnly.test(text.trim())) continue;
      const key = normalizeUserText(text);
      if (seenUsers.has(key)) continue;
      seenUsers.add(key);
    }
    if (!injectedAnchor && anchor && item.role !== "system" && item.role !== "developer") {
      result.push(taskAnchorMessage(anchor));
      if (latestProgress) result.push({ role: "developer", content: latestProgress });
      injectedAnchor = true;
    }
    result.push(item);
  }

  if (!injectedAnchor && anchor) {
    result.push(taskAnchorMessage(anchor));
    if (latestProgress) result.push({ role: "developer", content: latestProgress });
    if (!genuineUsers.length) result.push({ role: "user", content: anchor });
  } else if (!genuineUsers.length && anchor && !result.some((item) => item.role === "user")) {
    result.push({ role: "user", content: anchor });
  }
  return result;
}

// GitHub Actions runs are bounded on purpose: review and owner-comment tasks must
// not be re-anchored to a coding task, because that anchoring drives the agent back
// into open-ended reconnaissance. This path keeps the caller's messages (minus
// continuation noise) and never injects a task anchor or a synthetic user turn.
// When a review request is detected, a boundary developer message is injected that
// forbids tool use and requires a single-pass review from the provided context,
// which is what actually breaks the continual research loop.
export function prepareGithubActionMessages(
  messages: CompletionInput["messages"],
): CompletionInput["messages"] {
  const seenUsers = new Set<string>();
  const result: CompletionInput["messages"] = [];
  const alreadyHasBoundary = messages.some((item) => BOUNDED_REVIEW_MARKER.test(messageText(item)));
  let reviewDetected = false;
  let boundaryInjected = alreadyHasBoundary;

  for (const item of messages) {
    const text = messageText(item);

    if (item.role === "user") {
      if (continuationOnly.test(text.trim())) continue;
      const key = normalizeUserText(text);
      if (seenUsers.has(key)) continue;
      seenUsers.add(key);
      if (REVIEW_REQUEST.test(text)) reviewDetected = true;
    }

    if (
      reviewDetected &&
      !boundaryInjected &&
      item.role !== "system" &&
      item.role !== "developer"
    ) {
      result.push({ role: "developer", content: BOUNDED_REVIEW_INSTRUCTION });
      boundaryInjected = true;
    }

    result.push(item);
  }

  return result;
}

export function conversationTier(
  messages: CompletionInput["messages"],
  fallback?: TaskTier,
  githubAction = false,
): TaskTier {
  const prepared = githubAction
    ? prepareGithubActionMessages(messages)
    : prepareOpenCodeMessages(messages);
  let selected: TaskTier = fallback ?? "cheap";
  for (const item of prepared) {
    // Once OpenCode starts invoking tools, this is an agentic task rather than a
    // routine chat, even when the original request did not match a routing keyword.
    if (item.role === "tool" || (item.role === "assistant" && item.tool_calls?.length)) {
      if (TIER_RANK.standard > TIER_RANK[selected]) selected = "standard";
      continue;
    }
    if (item.role !== "user" && item.role !== "developer") continue;
    const candidate = taskTier(messageText(item));
    if (TIER_RANK[candidate] > TIER_RANK[selected]) selected = candidate;
  }
  return selected;
}
