import { deepMergeContext, type ContextObject } from "./deep-merge.js";

export interface OrgTreeNode {
  id: string;
  parent?: string | null;
  context?: ContextObject;
}

export class OrgTreeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgTreeResolutionError";
  }
}

function indexOrgTree(nodes: readonly OrgTreeNode[]): Map<string, OrgTreeNode> {
  const index = new Map<string, OrgTreeNode>();

  for (const node of nodes) {
    if (index.has(node.id)) {
      throw new OrgTreeResolutionError(`Duplicate org-tree node id: ${node.id}`);
    }
    index.set(node.id, node);
  }

  return index;
}

export function resolveOrgTreePath(
  nodes: readonly OrgTreeNode[],
  assignedNodeId: string,
): OrgTreeNode[] {
  const index = indexOrgTree(nodes);
  const assignedNode = index.get(assignedNodeId);
  if (!assignedNode) {
    throw new OrgTreeResolutionError(`Unknown org-tree node id: ${assignedNodeId}`);
  }

  const pathFromChildToRoot: OrgTreeNode[] = [];
  const seen = new Set<string>();
  let current: OrgTreeNode | undefined = assignedNode;

  while (current) {
    if (seen.has(current.id)) {
      throw new OrgTreeResolutionError(`Cycle detected in org-tree parent chain at ${current.id}`);
    }
    seen.add(current.id);
    pathFromChildToRoot.push(current);

    if (!current.parent) break;
    const parent = index.get(current.parent);
    if (!parent) {
      throw new OrgTreeResolutionError(
        `Org-tree node ${current.id} references missing parent ${current.parent}`,
      );
    }
    current = parent;
  }

  return pathFromChildToRoot.reverse();
}

export function resolveOrgTreeContext(
  nodes: readonly OrgTreeNode[],
  assignedNodeId: string,
): ContextObject {
  return resolveOrgTreePath(nodes, assignedNodeId).reduce<ContextObject>(
    (context, node) => deepMergeContext(context, node.context ?? {}),
    {},
  );
}
