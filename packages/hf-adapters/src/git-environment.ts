const GIT_CONFIG = [
  ["credential.helper", ""],
  ["credential.https://huggingface.co.helper", "harbor-hf"],
  ["filter.lfs.clean", "git-lfs clean -- %f"],
  ["filter.lfs.smudge", "git-lfs smudge -- %f"],
  ["filter.lfs.process", "git-lfs filter-process"],
  ["filter.lfs.required", "true"],
] as const;

/** Clean, non-persistent Git settings for Harbor's native source clients. */
export function isolatedGitSourceEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(GIT_CONFIG.length),
  };
  for (const [index, [key, value]] of GIT_CONFIG.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return environment;
}
