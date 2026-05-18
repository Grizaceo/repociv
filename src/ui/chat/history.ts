// ─── Chat message rendering + streaming buffer management ──────────────────
import {
  chatHistory,
  chatBuffers,
  currentAgentBubble,
  currentAgentMessageIndex,
  agentsWithNewMessages,
  getActiveChatUnit,
} from './state.ts';
import {
  COPY_SVG,
  attachCopyListeners,
  escapeHtml,
  hasErrorLine,
} from './clipboard.ts';

/** Render the chat history for a specific unit */
export function renderChatHistory(unitId: string): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';

  const history = chatHistory.get(unitId) ?? [];
  for (const msg of history) {
    const msgEl = document.createElement('div');
    msgEl.className = `chat-msg ${msg.role}`;
    msgEl.dataset['raw'] = msg.text;
    msgEl.innerHTML = `<div class="chat-msg-head">
      <div class="chat-msg-meta">
        <span>${msg.role === 'user' ? 'TÚ' : unitId.toUpperCase()} · ${msg.timestamp}</span>
        <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">${COPY_SVG}</button>
      </div>
    </div>
    <div class="chat-body">${escapeHtml(msg.text)}</div>`;
    container.appendChild(msgEl);
  }
}

/** Mark an agent as having new messages (for notification badge) */
export function markAgentHasNewMessages(unitId: string): void {
  agentsWithNewMessages.add(unitId);
  const selector = document.getElementById('chat-agent-selector') as HTMLSelectElement | null;
  if (selector) {
    const opt = selector.querySelector(`option[value="${unitId}"]`);
    if (opt) opt.classList.add('new-message');
  }
}

export function appendChatChunk(unitId: string, text: string): void {
  const prev = chatBuffers.get(unitId) ?? '';
  const newText = prev + text;
  chatBuffers.set(unitId, newText);

  const activeChatUnit = getActiveChatUnit();

  // If this agent is not the active one, mark it as having new messages
  // and update history so the full text is available when switching back
  if (activeChatUnit !== unitId) {
    markAgentHasNewMessages(unitId);
    const selector = document.getElementById('chat-agent-selector') as HTMLSelectElement | null;
    if (selector && !selector.querySelector(`option[value="${unitId}"]`)) {
      const opt = document.createElement('option');
      opt.value = unitId;
      opt.textContent = unitId.toUpperCase();
      opt.classList.add('new-message');
      selector.appendChild(opt);
    }
    const history = chatHistory.get(unitId) ?? [];
    const idx = currentAgentMessageIndex.get(unitId);
    if (idx !== undefined && idx >= 0 && idx < history.length) {
      const msg = history[idx];
      if (msg) {
        history[idx] = { role: msg.role, text: newText, timestamp: msg.timestamp };
        chatHistory.set(unitId, history);
      }
    }
  }

  if (activeChatUnit === unitId) {
    ensureLiveAgentBubble(unitId);
    const history = chatHistory.get(unitId) ?? [];
    const idx = currentAgentMessageIndex.get(unitId);
    if (idx !== undefined && idx >= 0 && idx < history.length) {
      const msg = history[idx];
      if (!msg) return;
      history[idx] = { role: msg.role, text: newText, timestamp: msg.timestamp };
      chatHistory.set(unitId, history);
    }
    const bubble = currentAgentBubble.get(unitId);
    if (bubble) {
      const body = bubble.querySelector<HTMLElement>('.chat-body');
      if (body) body.textContent = newText;
      bubble.dataset['raw'] = newText;
      const errBtn = bubble.querySelector<HTMLElement>('.chat-error-btn');
      if (errBtn) {
        errBtn.classList.toggle('hidden', !hasErrorLine(newText));
      }
    }
    const container = document.getElementById('chat-messages');
    if (container) {
      const isNearBottom =
        container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
      if (isNearBottom) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }
}

export function appendUserMessage(unitId: string, text: string): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const activeChatUnit = getActiveChatUnit();

  if (activeChatUnit !== unitId) {
    markAgentHasNewMessages(unitId);
    const selector = document.getElementById('chat-agent-selector') as HTMLSelectElement | null;
    if (selector && !selector.querySelector(`option[value="${unitId}"]`)) {
      const opt = document.createElement('option');
      opt.value = unitId;
      opt.textContent = unitId.toUpperCase();
      opt.classList.add('new-message');
      selector.appendChild(opt);
    }
    const userTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
    const history = chatHistory.get(unitId) ?? [];
    history.push({ role: 'user', text, timestamp: userTime });
    chatHistory.set(unitId, history);
    const agentTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
    history.push({ role: 'agent', text: '', timestamp: agentTime });
    currentAgentMessageIndex.set(unitId, history.length - 1);
    chatHistory.set(unitId, history);
    return;
  }

  // Finalize previous agent bubble (turn it into history)
  const prevBubble = currentAgentBubble.get(unitId);
  if (prevBubble) {
    prevBubble.id = '';
    prevBubble.classList.add('history');
    currentAgentBubble.delete(unitId);
  }

  const userTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const history = chatHistory.get(unitId) ?? [];
  history.push({ role: 'user', text, timestamp: userTime });
  chatHistory.set(unitId, history);

  const msg = document.createElement('div');
  msg.className = 'chat-msg user';
  msg.dataset['raw'] = text;
  msg.innerHTML = `<div class="chat-msg-head">
   <div class="chat-msg-meta">
     <span>TÚ · ${userTime}</span>
     <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">${COPY_SVG}</button>
   </div>
 </div>
 <div class="chat-body">${escapeHtml(text)}</div>`;
  container.appendChild(msg);

  chatBuffers.set(unitId, '');
  const agentTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg';
  bubble.id = `chat-current-${unitId}`;
  bubble.dataset['raw'] = '';
  bubble.innerHTML = `<div class="chat-msg-head">
   <div class="chat-msg-meta">
     <span>${unitId.toUpperCase()} · ${agentTime}</span>
     <div class="chat-msg-actions">
       <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">${COPY_SVG}</button>
       <button class="chat-error-btn hidden" title="Copiar solo la línea de error" aria-label="Copiar línea de error al portapapeles">Copiar error</button>
     </div>
   </div>
 </div>
 <span class="chat-body"></span>`;
  container.appendChild(bubble);
  currentAgentBubble.set(unitId, bubble);

  history.push({ role: 'agent', text: '', timestamp: agentTime });
  currentAgentMessageIndex.set(unitId, history.length - 1);

  container.scrollTop = container.scrollHeight;
  attachCopyListeners(container, unitId);
}

export function ensureLiveAgentBubble(unitId: string): void {
  if (currentAgentBubble.has(unitId)) return;
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const agentTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg';
  bubble.id = `chat-current-${unitId}`;
  bubble.dataset['raw'] = '';
  bubble.innerHTML = `<div class="chat-msg-head">
   <div class="chat-msg-meta">
     <span>${unitId.toUpperCase()} · ${agentTime}</span>
     <div class="chat-msg-actions">
       <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">${COPY_SVG}</button>
       <button class="chat-error-btn hidden" title="Copiar solo la línea de error" aria-label="Copiar línea de error al portapapeles">Copiar error</button>
     </div>
   </div>
 </div>
 <span class="chat-body"></span>`;
  container.appendChild(bubble);
  currentAgentBubble.set(unitId, bubble);
  attachCopyListeners(container, unitId);
}

export function renderChatBuffer(unitId: string): void {
  const current = document.getElementById(`chat-current-${unitId}`);
  if (!current) return;
  const body = current.querySelector<HTMLElement>('.chat-body');
  const text = chatBuffers.get(unitId) ?? '';
  if (body) body.textContent = text;
  current.dataset['raw'] = text;
  const errBtn = current.querySelector<HTMLElement>('.chat-error-btn');
  if (errBtn) {
    errBtn.classList.toggle('hidden', !hasErrorLine(text));
  }
  const container = document.getElementById('chat-messages');
  if (container) {
    const isNearBottom =
      container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
    if (isNearBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }
}

export function clearChat(unitId: string): void {
  // Only clear buffer and active bubble, NOT the history
  chatBuffers.delete(unitId);
  currentAgentBubble.delete(unitId);
  currentAgentMessageIndex.delete(unitId);
  if (getActiveChatUnit() === unitId) {
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';
  }
}
