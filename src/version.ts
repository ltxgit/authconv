declare const __AUTHCONV_VERSION__: string | undefined;

const injectedVersion = typeof __AUTHCONV_VERSION__ === "string"
  ? __AUTHCONV_VERSION__.trim()
  : "";

export const VERSION = injectedVersion || "dev";
