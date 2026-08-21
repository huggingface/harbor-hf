const ALLOWED_CHILD_ENVIRONMENT = [
  "HOME",
  "HF_DEBUG",
  "HF_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
] as const;

export function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
  };
  for (const name of ALLOWED_CHILD_ENVIRONMENT) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}
