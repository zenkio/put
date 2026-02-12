# Proposed Features for Nanoclaw

*Drafted by Gemini, 2026-02-12*

## 1. Group Digest Subscriptions

**Description**: Allows group members to subscribe to specific topics (e.g., "AI news," "local weather," "stock updates"). The AI agent, leveraging its scheduling capabilities, will proactively fetch, summarize, and deliver relevant information to the group at chosen intervals (e.g., daily, weekly), personalizing the content based on group preferences.

**Suggested Files**:
- `src/handlers/messageHandler.ts` - Process subscription commands (e.g., `/subscribe AI news`)
- `src/services/scheduler.ts` - Manage cron jobs for fetching and delivering digests
- `src/services/aiService.ts` - Handle content summarization using Claude
- Database/persistence layer - Store group-specific subscription preferences

---

## 2. Meeting Facilitator

**Description**: Within a group, the AI can be invoked to help facilitate discussions. It can automatically generate a meeting agenda based on recent chat topics, identify and track action items during the conversation, and provide a concise summary of discussions or decisions made, even sending follow-up reminders for pending tasks.

**Suggested Files**:
- `src/handlers/messageHandler.ts` - Detect meeting commands (e.g., `/start_meeting`)
- `src/services/aiService.ts` - Agenda generation, action item extraction, summarization
- `src/services/scheduler.ts` - Schedule follow-up reminders
- Database layer - Store meeting states, agendas, action items per group

---

## 3. Group Persona Customization

**Description**: Enables group administrators to define a unique persona or set of instructions for the AI within their specific group. This allows the AI to adopt a particular tone, style, or "role" (e.g., a formal assistant, a casual friend, a specific domain expert), making interactions more tailored and engaging for that group's context.

**Suggested Files**:
- `src/handlers/messageHandler.ts` - Process commands like `/set_persona "witty assistant"`
- `src/services/aiService.ts` - Integrate persona instructions into Claude prompts
- Database layer - Store custom persona instructions per group

---

## Implementation Priority

1. **Group Persona Customization** - Easiest to implement, high impact
2. **Group Digest Subscriptions** - Medium complexity, leverages existing scheduler
3. **Meeting Facilitator** - Most complex, requires conversation tracking
