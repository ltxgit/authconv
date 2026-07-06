declare const __AUTHCONV_VERSION__: string | undefined;

const PACKAGE_VERSION = "0.1.1";
const injectedVersion = typeof __AUTHCONV_VERSION__ === "string"
  ? __AUTHCONV_VERSION__.trim()
  : "";

export const VERSION = injectedVersion || PACKAGE_VERSION;
