import { SS14Prototype, RSI, ValidationIssue } from '../types';

export function validateProject(
  prototypes: Record<string, SS14Prototype>,
  rsis: Record<string, RSI>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [id, proto] of Object.entries(prototypes)) {
    // Check parents
    if (proto.parent) {
      const parents = Array.isArray(proto.parent) ? proto.parent : [proto.parent];
      for (const parentId of parents) {
        if (!prototypes[parentId]) {
          issues.push({
            level: 'error',
            message: `Missing parent '${parentId}'`,
            prototypeId: id,
            field: 'parent'
          });
        }
      }
    }

    // Check Sprite components
    if (proto.components) {
      const spriteComp = proto.components.find(c => c.type === 'Sprite');
      if (spriteComp) {
        if (spriteComp.sprite) {
          const rsiPath = spriteComp.sprite.replace('Textures/', '') + '.rsi';
          // This is a naive check, actual paths might differ
          const foundRsi = Object.keys(rsis).find(p => p.endsWith(rsiPath));
          if (!foundRsi) {
            issues.push({
              level: 'warning',
              message: `Sprite RSI not found: ${spriteComp.sprite}`,
              prototypeId: id,
              field: 'Sprite.sprite'
            });
          } else if (spriteComp.state) {
            const rsi = rsis[foundRsi];
            const hasState = rsi.meta.states.some(s => s.name === spriteComp.state);
            if (!hasState) {
              issues.push({
                level: 'error',
                message: `State '${spriteComp.state}' not found in RSI ${spriteComp.sprite}`,
                prototypeId: id,
                field: 'Sprite.state'
              });
            }
          }
        }
      }
    }
  }

  return issues;
}
