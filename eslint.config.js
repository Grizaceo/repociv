// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

// HTML sinks (innerHTML, insertAdjacentHTML…) must receive escaped content.
// Agent output is attacker-influenced (prompt injection), and the UI server
// attaches the bridge token to /bridge calls, so an XSS is an agent launch.
const ESCAPERS = { escape: { methods: ['escapeHtml', 'esc', 'renderMarkdown'] } };

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**'],
  },
  {
    rules: {
      // Allow ternary-as-statement side-effects (common Canvas / DOM pattern)
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true, allowShortCircuit: true }],
      // Downgrade to warnings so existing code doesn't block CI immediately
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'warn',
    },
  },
  {
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      'no-unsanitized/property': ['error', ESCAPERS],
      'no-unsanitized/method': ['error', ESCAPERS],
    },
  },
  {
    // Baseline (2026-10-18): files that already had unescaped-looking sinks
    // when the rule was introduced (80 sites). New files are covered; remove a
    // file from this list once its sinks are escaped or moved to DOM APIs.
    files: [
      'src/main.ts',
      'src/renderer.ts',
      'src/three/TilePopup3D.ts',
      'src/ui/agentProfileStrip.ts',
      'src/ui/agentsPanel.ts',
      'src/ui/approvalPanel.ts',
      'src/ui/capabilityBadges.ts',
      'src/ui/capitalPanel.ts',
      'src/ui/chat/agentChip.ts',
      'src/ui/chat/clipboard.ts',
      'src/ui/chat/history.ts',
      'src/ui/chat/panel.ts',
      'src/ui/city.ts',
      'src/ui/commandPalette.ts',
      'src/ui/constructionPanel.ts',
      'src/ui/emptyStates.ts',
      'src/ui/firstRunTour.ts',
      'src/ui/foreignRelationsPanel.ts',
      'src/ui/gacetaWidget.ts',
      'src/ui/harnessPanel.ts',
      'src/ui/hermesStatusBanner.ts',
      'src/ui/hud.ts',
      'src/ui/kanbanPanel.ts',
      'src/ui/localChat/feed.ts',
      'src/ui/localSpatialPreview.ts',
      'src/ui/logPanel.ts',
      'src/ui/notificationBanner.ts',
      'src/ui/onboardingPanel.ts',
      'src/ui/ordenDeBatalla.ts',
      'src/ui/panelShell.ts',
      'src/ui/pendingPanel.ts',
      'src/ui/priorityPanel.ts',
      'src/ui/recoveryPanel.ts',
      'src/ui/spatialPreview/directive.ts',
      'src/ui/spatialPreview/tooltip.ts',
      'src/ui/subagentSessionPanel.ts',
      'src/ui/taskAssignPanel.ts',
      'src/ui/taskPanel.ts',
      'src/ui/validationVerdict.ts',
      'src/ui/wonderVignette.ts',
    ],
    rules: {
      'no-unsanitized/property': 'off',
      'no-unsanitized/method': 'off',
    },
  },
);
