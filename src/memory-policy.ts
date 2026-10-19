export function shouldExtractMemory(
  enabled: boolean,
  userMessage: string,
  assistantResponse: string,
): boolean {
  if (!enabled) return false;

  const user = userMessage.trim().toLowerCase();
  const acknowledgements = new Set([
    "ok",
    "okay",
    "good",
    "great",
    "done",
    "merged",
    "thanks",
    "thank you",
    "go ahead",
  ]);

  if (acknowledgements.has(user)) return false;

  return userMessage.trim().length >= 40 || assistantResponse.trim().length >= 300;
}
