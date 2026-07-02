import type { NodeModule } from "@autonimbus/shared";

export const manualTrigger: NodeModule = {
  manifest: {
    slug: "core.manual-trigger",
    kind: "trigger",
    name: "When I click Run",
    description: "Starts the automation when you press the Run button.",
    inputHint: "Nothing — you start it yourself.",
    outputHint: "The sample data you configured, if any.",
  },
  async run(ctx) {
    return ctx.config.payload ?? {};
  },
};
