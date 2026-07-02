import { AppError, type NodeManifest, type NodeModule } from "@autonimbus/shared";

export class NodeRegistry {
  private readonly modules = new Map<string, NodeModule>();

  register(mod: NodeModule): void {
    if (this.modules.has(mod.manifest.slug)) {
      throw new AppError({
        code: "NODE_DUPLICATE",
        friendlyMessage: `A node called "${mod.manifest.slug}" is already registered.`,
      });
    }
    this.modules.set(mod.manifest.slug, mod);
  }

  get(slug: string): NodeModule {
    const mod = this.modules.get(slug);
    if (!mod) {
      throw new AppError({
        code: "NODE_UNKNOWN",
        friendlyMessage: `The node type "${slug}" isn't installed.`,
        suggestedFix: "Ask Nimbus to create it, or pick a different node.",
      });
    }
    return mod;
  }

  list(): NodeManifest[] {
    return [...this.modules.values()].map((m) => m.manifest);
  }
}
