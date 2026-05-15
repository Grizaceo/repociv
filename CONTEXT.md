# CONTEXT.md

## Glossary

- **Agent**: Generic term for an autonomous AI entity that performs specific tasks.
- **Hero**: The primary agent responsible for reasoning and user interaction (currently DAVI).
- **Scout**: Generic agent type for exploration, reconnaissance, and information gathering tasks.
- **Worker**: Generic agent type for background jobs, data processing, and maintenance tasks.
- **LexO-Alpha**: Specialized legal research agent focused on Chilean law.
- **DAVI**: The primary reasoning agent, currently serving as the Hero.
- **Orchestrator**: The system that coordinates agents, assigns tasks, and manages communication.
- **Task**: A unit of work assigned to an agent, defined by a goal and constraints.
- **Message**: Communication between agents or between agent and orchestrator.
- **State**: Shared data that agents read/write to coordinate.
- **Bridge**: The HTTP interface that allows Hermes (DAVI) to communicate with the RepoCiv backend.
- **Workbench**: Files or directories in a repository that agents interact with to perform tasks.

## Domain Model

RepoCiv visualizes the `~/.hermes/workspace/repos/` directory as a Civilization-style hexagonal map. Each repository is a city. Agents (Hero, Scout, Worker, LexO-Alpha) are units that move between cities to perform tasks on files (workbenches). The orchestrator simulates agent movement, task assignment, and resource consumption (fatigue).

## Current State

Only the Hero (DAVI) is operational. LexO-Alpha, Scout, and Worker agent types are not yet connected or implemented. The bridge exists but is primarily used for DAVI to send/receive messages to/from the frontend.

## Goals

1. Enable LexO-Alpha to perform legal research tasks via the bridge.
2. Enable Scout and Worker agents to execute their respective task types via the bridge.
3. Define clear communication protocols between agents and the orchestrator.
4. Implement fatigue and priority systems to simulate realistic agent behavior.
5. Provide visibility into agent activities across multiple repos.
