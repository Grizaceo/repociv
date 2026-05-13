# Contributing to RepoCiv

RepoCiv es un proyecto personal (por ahora) pero las PRs y sugerencias son bienvenidas.

## Development Setup

```bash
git clone <repo-url>
cd repociv
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pre-commit install
```

## Workflow

1. **Branch:** `git checkout -b feat/descripcion-corta`
2. **Code:** haz tus cambios
3. **Check:** `npm run check` (lint + typecheck + tests + build)
4. **Test Python:** `pytest --tb=short`
5. **Commit:** usa conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`)
6. **Push:** `git push origin feat/descripcion-corta`
7. **PR:** describe qué cambia y por qué

## Conventional Commits

| Prefix | Uso |
|--------|-----|
| `feat:` | Nueva feature |
| `fix:` | Bugfix |
| `docs:` | Documentación |
| `test:` | Tests |
| `refactor:` | Refactor sin cambio de comportamiento |
| `chore:` | Mantenimiento, deps, scripts |
| `style:` | Formato (prettier, etc.) |

## Pre-commit Hooks

Si instalaste pre-commit, los hooks corren automáticamente en cada commit:
- Prettier formatting
- ESLint check
- Vitest unit tests
- TypeScript type check
- pytest Python tests

Para correr manualmente: `pre-commit run --all-files`

## Testing

- **Frontend:** `npm test` (Vitest, 314 tests)
- **Backend:** `pytest` (544 tests)
- **E2E:** `npm run test:e2e` (Playwright)
- **Smoke:** `./scripts/smoke-test.sh`

## CI

GitHub Actions corre en cada push/PR:
- Frontend: lint, typecheck, format, tests, coverage, build
- Backend: pytest + coverage (min 70%)

## Style Guide

- TypeScript: strict mode, no `any` si se puede evitar.
- Python: type hints donde aportan claridad.
- Canvas: preferir `requestAnimationFrame`, evitar alloc en el loop.

## Questions?

Abre un issue o menciona en el chat de desarrollo.

