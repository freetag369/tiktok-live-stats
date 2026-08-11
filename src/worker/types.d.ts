declare module '*.sql?raw' {
  const content: string;
  export default content;
}

declare const __GIT_SHA__: string;
declare const __BUILD_TIME__: string;
