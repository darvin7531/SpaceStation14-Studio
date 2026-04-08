import { SS14Prototype } from '../types';

export function resolvePrototype(
  key: string,
  prototypes: Record<string, SS14Prototype>,
  visited = new Set<string>()
): any {
  const proto = prototypes[key];
  if (!proto) return null;

  if (visited.has(key)) {
    console.warn(`Cyclic inheritance detected for ${key}`);
    return { ...proto, _cyclic: true };
  }
  
  visited.add(key);

  let resolved = { ...proto };
  
  if (proto.parent) {
    const parents = Array.isArray(proto.parent) ? proto.parent : [proto.parent];
    
    // Resolve parents from left to right (or right to left depending on SS14 rules, usually left to right overrides)
    // Actually SS14 merges components.
    for (const parentId of parents) {
      const parentKey = findPrototypeKey(parentId, proto.type, prototypes);
      const parentResolved = parentKey ? resolvePrototype(parentKey, prototypes, new Set(visited)) : null;
      if (parentResolved) {
        resolved = mergePrototypes(parentResolved, resolved);
      }
    }
  }

  return resolved;
}

function findPrototypeKey(id: string | number, type: string | number, prototypes: Record<string, SS14Prototype>) {
  if (prototypes[`${type}:${id}`]) return `${type}:${id}`;
  const found = Object.values(prototypes).find(proto => String(proto.id) === String(id));
  return found?._key ?? null;
}

function mergePrototypes(parent: any, child: any) {
  const merged = { ...parent, ...child };
  
  // Merge components
  if (parent.components || child.components) {
    const compMap = new Map<string, any>();
    
    if (parent.components) {
      for (const comp of parent.components) {
        compMap.set(comp.type, { ...comp, _source: parent.id });
      }
    }
    
    if (child.components) {
      for (const comp of child.components) {
        const existing = compMap.get(comp.type);
        if (existing) {
          compMap.set(comp.type, { ...existing, ...comp, _source: child.id });
        } else {
          compMap.set(comp.type, { ...comp, _source: child.id });
        }
      }
    }
    
    merged.components = Array.from(compMap.values());
  }
  
  return merged;
}
