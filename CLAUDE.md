# RepoCiv — Imperial Agent Dashboard

You are inside the **RepoCiv** repository (`/home/gris/.hermes/workspace/repos/repociv`).
This is a Civilization V-style hexagonal dashboard for Cristóbal's agents — single-user alpha.
Stack: TypeScript + Vite (Canvas 2D) · Python HTTP bridge · DuckDB ledger.
See `AGENTS.md` and `docs/SCOPE.md` for full context.

---

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
