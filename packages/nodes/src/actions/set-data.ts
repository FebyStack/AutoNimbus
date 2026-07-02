import type { NodeModule } from "@autonimbus/shared";

export const setData: NodeModule = {
  manifest: {
    slug: "core.set-data",
    kind: "action",
    name: "Set data",
    description: "Replaces the flowing data with values you type in.",
    inputHint: "Anything (it will be replaced).",
    outputHint: "Exactly the data you configured.",
  },
  async run(ctx) {
    return ctx.config.data ?? {};
  },
};
