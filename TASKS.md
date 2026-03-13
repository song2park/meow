# Tasks

## Status Legend
- [ ] Todo
- [x] Done
- [-] In Progress

---

## Milestone 0: Foundation
- [x] Define project concept and architecture
- [x] Initialize Node.js project (package.json, tsconfig, eslint)
- [x] Set up git branching strategy (main, dev, agent/* branches)
- [x] Set up Redis (local Docker for dev)
- [x] Set up PostgreSQL (local Docker for dev)

## Milestone 1: Core Agent System (v1 MVP)
### Slack Integration
- [x] Set up Slack app (bot token, event subscriptions, slash commands)
- [x] Implement Slack bolt server (receive messages/mentions)
- [x] Implement Slack message posting (agents publish updates)
- [x] PM orchestration — structured JSON plan dispatched to team by role
- [x] Error handling — try/catch on all handlers, user-facing error messages
- [x] Per-agent Redis lock to prevent race conditions

### Task Queue
- [x] Integrate BullMQ with Redis
- [x] Define job schema (taskId, agentRole, instruction, context)
- [x] Implement worker dispatcher (route jobs to correct agent by role)

### Agent Core
- [x] Define Agent base class (id, name, role, status: idle/busy)
- [x] Implement agent status tracking in Redis
- [x] Implement Claude API integration for agent reasoning
- [x] Agent posts Slack message on task start/complete/decision
- [x] Zod schema validation on PM JSON response

### Agent Roles (v1: one agent per role)
- [x] Developer agent (Tara)
- [x] Designer agent (Mary)
- [x] Product Manager agent (Charles)
- [x] Project Manager / orchestrator agent (Alex)
- [x] QA Engineer agent (Clare)

### Git Integration
- [x] Each agent commits to its own branch (agent/<name>)
- [x] Orchestrator creates PR when agent pushes changes

### User-facing Slack Commands
- [x] `@bot <instruction>` — routes to PM, PM orchestrates team
- [x] `/agent-status` — show all agents status (idle/busy + current task)
- [x] `@bot what are you doing` — inline status, no queue needed
- [x] `/add-agent`, `/remove-agent`, `/add-role`, `/list-agents`, `/list-roles`

## Milestone 2: Agent Management
- [x] Add/remove agents via Slack commands
- [x] Add custom roles via Slack commands
- [x] Edit agent name/role (`/edit-agent`)
- [x] Edit role name/description (`/edit-role`)
- [x] Assign multiple agents to same role (supported by default)

## Milestone 3: Live Dashboard (post-v1)
- [ ] Web dashboard showing real-time agent status
- [ ] Task history and logs
- [ ] Google Docs integration (agents publish decisions/docs)

---

## Architecture Decisions
- **Triggering**: Slack Events API → BullMQ queue → agent worker
- **Coordination**: BullMQ serializes tasks per resource (no conflicts)
- **State**: Redis (live status) + PostgreSQL (history/config)
- **Git**: agent/* branches, orchestrator creates PRs
- **LLM**: Claude API (claude-sonnet-4-6)
- **Slack SDK**: @slack/bolt
- **Language**: Node.js + TypeScript
