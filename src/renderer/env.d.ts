/// <reference types="vite/client" />
import type { Api } from '../preload/index';

// The only surface the sandboxed renderer has. Declared here rather than beside
// the preload script, because an `index.d.ts` next to `index.ts` shadows it.
declare global {
  interface Window {
    api: Api;
  }
  const __GIT_SHA__: string;
  const __BUILD_TIME__: string;
}

export {};
