import { Ajv2020 } from 'ajv/dist/2020.js';
import toolsSpec from '../../spec/mcp-tools.json';
import { ensure } from './errors.js';

export const toolDefinitions = toolsSpec.tools;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map(toolDefinitions.map((t) => [t.name, ajv.compile(t.inputSchema)]));
export function validateTool(name: string, args: unknown) {
  const validate = validators.get(name);
  ensure(validate, 'TOOL_NOT_FOUND', '工具名称无效。', 404);
  ensure(validate(args), 'INVALID_ARGUMENTS', '工具参数与公开 schema 不匹配。');
}
