export type WorkflowPromptDefinition = {
  name: string;
  prompt: string;
};

export function createWorkflowPrompt(
  definition: WorkflowPromptDefinition,
): WorkflowPromptDefinition {
  return definition;
}

export const DEFAULT_WORKFLOW_PROMPTS = {
  compact: createWorkflowPrompt({
    name: "compact",
    prompt: `# Compact
Create a detailed summary of the conversation so far, capturing the technical details, code patterns, and decisions needed to continue the work without losing context. Do not use any tools while compacting — produce only the summary.

Structure the summary with these sections:
1. Primary Request and Intent — all of the user's explicit requests, in detail.
2. Key Technical Concepts — technologies, frameworks, and patterns discussed.
3. Files and Code Sections — specific files examined, modified, or created, with why each matters and key snippets.
4. Errors and Fixes — errors hit and how they were resolved, including any user feedback.
5. Problem Solving — problems solved and ongoing troubleshooting.
6. All User Messages — every non-tool-result user message, critical for tracking intent.
7. Pending Tasks — what remains explicitly requested.
8. Current Work — precisely what was being done immediately before this summary.
9. Next Step — the next step directly in line with the most recent work, with a verbatim quote of where you left off. Omit if the last task was concluded.`,
  }),
  memoryUpdate: createWorkflowPrompt({
    name: "memoryUpdate",
    prompt: `# Memory Update
Update the durable memory/notes file from the recent conversation. Use the Edit tool to update content, then stop — do not call other tools, and do not reference this update process anywhere in the notes.

Rules:
- Preserve the file's structure exactly: never add, remove, or modify section headers or their italic _descriptions_ — those are template instructions, not content.
- Only update the actual content that appears below each section's description.
- Write dense, specific content: file paths, function names, exact commands, error messages. Skip a section rather than adding filler like "No info yet."
- Don't duplicate what's already in project documentation. Always keep the current-state section reflecting the most recent work.`,
  }),
  sessionSummary: createWorkflowPrompt({
    name: "sessionSummary",
    prompt: `# Session Summary
Produce a concise handoff summary so another agent or a resumed session can pick up cold. Cover what the user wanted, what was done, the current state of the work, and the immediate next step. Include concrete anchors — file paths, key decisions, and any open problems. Keep it tight and factual; this is a handoff, not a transcript.`,
  }),
  promptSuggestion: createWorkflowPrompt({
    name: "promptSuggestion",
    prompt: `# Prompt Suggestion
Predict what the user would naturally type next — not what you think they should do. The test: would they think "I was just about to type that"?

- Be specific: "run the tests" beats "continue".
- Match the user's style; keep it to 2-12 words.
- Never suggest evaluative phrases ("looks good"), questions, assistant-voice openers ("Let me...", "I'll...", "Here's..."), new ideas the user didn't raise, or multiple sentences.
- Stay silent if the next step isn't obvious from what the user said.

Reply with only the suggestion, no quotes or explanation.`,
  }),
} as const;
