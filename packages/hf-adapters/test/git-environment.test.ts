import { expect, it } from "vitest";
import { isolatedGitSourceEnvironment } from "../src/index.js";

it("configures an isolated host-restricted credential helper and Git LFS", () => {
  expect(isolatedGitSourceEnvironment()).toEqual({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://huggingface.co.helper",
    GIT_CONFIG_VALUE_1: "harbor-hf",
    GIT_CONFIG_KEY_2: "filter.lfs.clean",
    GIT_CONFIG_VALUE_2: "git-lfs clean -- %f",
    GIT_CONFIG_KEY_3: "filter.lfs.smudge",
    GIT_CONFIG_VALUE_3: "git-lfs smudge -- %f",
    GIT_CONFIG_KEY_4: "filter.lfs.process",
    GIT_CONFIG_VALUE_4: "git-lfs filter-process",
    GIT_CONFIG_KEY_5: "filter.lfs.required",
    GIT_CONFIG_VALUE_5: "true",
  });
});
