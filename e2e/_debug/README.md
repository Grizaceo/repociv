# Debug specs (off by default)

These Playwright specs are diagnostic scripts used during local-view
investigation. They are excluded from the default Playwright runner via
`testIgnore: ['**/_debug/**']` in `playwright.config.ts`.

To run a single debug spec manually when investigating local-view
issues:

```
npx playwright test e2e/_debug/local-view-debug3.spec.ts --project=chromium
```

They are kept here (not deleted) because they encode useful diagnostic
queries against `/api/repos`, game state cities, camera, and double-click
hit testing that are easy to forget once a feature stabilizes.

If a debug spec is no longer relevant, delete it. Do not promote a
debug spec to a formal regression test without first rewriting it to
assert behavior, not just print state.
