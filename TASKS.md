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
- [ ] Set up Slack app (bot token, event subscriptions, slash commands)
- [x] Implement Slack bolt server (receive messages/mentions)
- [x] Implement Slack message posting (agents publish updates)

### Task Queue
- [x] Integrate BullMQ with Redis
- [x] Define job schema (taskId, agentRole, instruction, context)
- [x] Implement worker dispatcher (route jobs to correct agent by role)

### Agent Core
- [x] Define Agent base class (id, name, role, status: idle/busy)
- [x] Implement agent status tracking in Redis
- [x] Implement Claude API integration for agent reasoning
- [x] Agent posts Slack message on task start/complete/decision

### Agent Roles (v1: one agent per role)
- [x] Developer agent
- [x] Designer agent
- [x] Product Manager agent
- [x] Project Manager (orchestrator) agent

### Git Integration
- [ ] Each agent commits to its own branch (agent/<name>)
- [ ] Orchestrator creates PR when agent pushes changes

### User-facing Slack Commands
- [ ] `@bot <instruction>` — assign task to appropriate agent
- [ ] `/status` — show all agents status (idle/busy + current task)
- [ ] `@bot show me what you're doing` — agents describe current task

## Milestone 2: Agent Management
- [ ] Add/edit/remove agents via Slack command or config
- [ ] Add/edit custom roles (name + description)
- [ ] Assign multiple agents to same role

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
