import { type Renderer } from '../../renderer.ts';

export function takeScreenshot(renderer: Renderer): void {
  const canvas = renderer.getCanvas();
  if (!canvas) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `repociv-${ts}.png`;
  a.click();
}
