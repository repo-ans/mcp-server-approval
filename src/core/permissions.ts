import type { Role, ToolType } from './types.js';

const allowed: Record<Role, ToolType[]> = {
  read_only: ['read'],
  writer: ['read', 'write'],
};

export const canCall = (role: Role, toolType: ToolType) => allowed[role].includes(toolType);
