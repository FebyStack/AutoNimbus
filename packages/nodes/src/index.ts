import type { NodeModule } from "@autonimbus/shared";
import { manualTrigger } from "./triggers/manual-trigger.js";
import { setData } from "./actions/set-data.js";
import { ifRule } from "./rules/if.js";

export { manualTrigger, setData, ifRule };

export const builtinNodes: NodeModule[] = [manualTrigger, setData, ifRule];
