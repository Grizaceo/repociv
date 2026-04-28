// Type declarations for CDN-loaded libraries (lucide, @formkit/auto-animate)

interface LucideLib {
  createIcons(options?: { attrs?: Record<string, string> }): void;
}

type AutoAnimateFunction = (el: Element, options?: {
  duration?: number;
  easing?: string;
  disrespectUserMotionPreference?: boolean;
}) => void;

declare global {
  interface Window {
    lucide: LucideLib;
    autoAnimate: AutoAnimateFunction;
  }
}

export {};
