// ─── RepoCiv — Side panel: Chat / Git / Files (Civ V Aesthetic) ────────────
// Barrel: re-exporta la API publica desde los submodulos en src/ui/chat/.
// El split se hizo en commit posterior a b70167e; previamente todo vivía aqui.

export {
  markAgentHasNewMessages,
  appendChatChunk,
  appendUserMessage,
  appendSystemMessage,
  resetChatHistory,
  clearChat,
} from './chat/history.ts';

export { getSelectedConfig } from './chat/modelSelector.ts';

export {
  openSidePanel,
  closeSidePanel,
  isSidePanelOpen,
  wireSideTabs,
  loadGitInfo,
  loadFilesInfo,
} from './chat/panel.ts';
