/**
 * A minimal `defineTool` for the dispatch tools: the compact authoring form of `@deepseek-ai/dsh-tools` (a property
 * carries `required: true`; an object states `additionalProperties`) compiled to the raw JSON Schema subset the tool
 * registry enforces, plus strict validation of the model's arguments before the body runs.
 *
 * The registry itself validates every returned value against the output schema and accepts any registered
 * `ToolDefinition`; only the argument check and the schema projection live in `defineTool`, so this module carries
 * those two and the plugin needs no runtime import of the tools package. The supported vocabulary is exactly what the
 * dispatch tools use: `type` (string, integer, number, boolean, null, array, object), `properties`,
 * `additionalProperties`, `items`, `enum`, `const`, `description` and `oneOf`.
 *
 * @module dsh-im-dispatch/schema
 */

import type { ContentBlockLike, JsonSchemaLike, ToolDefinitionLike, ToolRunContextLike } from './types.ts'

/** One authored value schema. */
export interface ValueSpec {
  readonly type?: 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'array' | 'object'
  readonly description?: string
  /** Inside a property map: the property must be present. */
  readonly required?: true
  readonly enum?: readonly (string | number | boolean)[]
  readonly const?: string | number | boolean
  readonly properties?: Readonly<Record<string, ValueSpec>>
  readonly additionalProperties?: boolean
  readonly items?: ValueSpec
  readonly oneOf?: readonly ValueSpec[]
}

/** The authored parameters of one tool: an implicit object of named properties. */
export type ParameterSpec = Readonly<Record<string, ValueSpec>>

/**
 * Compile one authored value schema to raw JSON Schema.
 * @param spec - the authored schema.
 * @returns the raw schema node.
 */
export function compileValue(spec: ValueSpec): JsonSchemaLike {
  if (spec.oneOf !== undefined) {
    return { ...spec.description === undefined ? {} : { description: spec.description }, oneOf: spec.oneOf.map(compileValue) }
  }
  const node: JsonSchemaLike = {}
  if (spec.type !== undefined) node.type = spec.type
  if (spec.description !== undefined) node.description = spec.description
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.const !== undefined) node.const = spec.const
  if (spec.type === 'object') {
    node.additionalProperties = spec.additionalProperties ?? false
    if (spec.properties !== undefined) Object.assign(node, compileProperties(spec.properties))
  }
  if (spec.type === 'array' && spec.items !== undefined) node.items = compileValue(spec.items)
  return node
}

/** Compile one property map: the properties and the names marked required. */
function compileProperties(properties: Readonly<Record<string, ValueSpec>>): JsonSchemaLike {
  const compiled: Record<string, JsonSchemaLike> = {}
  const required: string[] = []
  for (const [key, property] of Object.entries(properties)) {
    compiled[key] = compileValue(property)
    if (property.required === true) required.push(key)
  }
  return { properties: compiled, ...required.length === 0 ? {} : { required } }
}

/**
 * Compile the implicit parameter object of one tool.
 * @param spec - the authored parameters.
 * @returns an object-rooted raw schema.
 */
export function compileParameters(spec: ParameterSpec): JsonSchemaLike {
  return { type: 'object', ...compileProperties(spec) }
}

/** Whether one value has the given JSON type. */
function hasType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'integer': return Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'array': return Array.isArray(value)
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    default: return true
  }
}

/**
 * Validate one value against a compiled schema.
 * @param schema - the raw schema node.
 * @param value - the candidate value.
 * @param path - path of the value, for the messages.
 * @returns path-qualified violations; empty means valid.
 */
export function validate(schema: JsonSchemaLike, value: unknown, path = 'value'): string[] {
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as JsonSchemaLike[]).filter(branch => validate(branch, value, path).length === 0)
    return passing.length === 1 ? [] : [`${path} must match exactly one schema of oneOf`]
  }
  if (schema.type !== undefined && !hasType(schema.type, value)) return [`${path} must be ${String(schema.type)}`]
  const violations: string[] = []
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.map(entry => JSON.stringify(entry)).join(', ')}`)
  }
  if (schema.const !== undefined && value !== schema.const) violations.push(`${path} must be ${JSON.stringify(schema.const)}`)
  if (schema.type === 'object') {
    const record = value as Record<string, unknown>
    const properties = (schema.properties ?? {}) as Record<string, JsonSchemaLike>
    for (const key of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key)) violations.push(`${path}.${key} is required`)
    }
    for (const [key, entry] of Object.entries(record)) {
      const property = properties[key]
      if (property === undefined) {
        if (schema.additionalProperties !== true) violations.push(`${path}.${key} is not allowed`)
        continue
      }
      violations.push(...validate(property, entry, `${path}.${key}`))
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    for (const [index, entry] of (value as unknown[]).entries()) {
      violations.push(...validate(schema.items as JsonSchemaLike, entry, `${path}[${index}]`))
    }
  }
  return violations
}

/** Arguments the model sent that do not satisfy the tool's parameters (`ToolArgsError`). */
export class ToolArgsError extends Error {
  /** Individual violations in schema-walk order. */
  readonly violations: string[]

  /**
   * @param violations - the violations found.
   */
  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/** One tool as this plugin authors it; `A` is the argument shape the parameters guarantee once validated. */
export interface ToolOptions<A> {
  name: string
  description: string
  parameters: ParameterSpec
  output: { schema: ValueSpec; render(args: A, value: unknown): ContentBlockLike[] }
  execute(args: A, exec: ToolRunContextLike): Promise<unknown>
  isConcurrencySafe?(args: A): boolean
}

/**
 * Build one registry-ready tool definition: compiled schemas, and an `execute` that refuses invalid arguments.
 * @param options - the authored tool.
 * @returns the definition `ctx.tools.register` takes.
 */
export function defineTool<A>(options: ToolOptions<A>): ToolDefinitionLike {
  const parameters = compileParameters(options.parameters)
  const check = (args: unknown): string[] => validate(parameters, args, 'arguments')
  const safe = options.isConcurrencySafe
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: compileValue(options.output.schema),
      render: (args, value) => options.output.render(args as A, value),
    },
    async execute(args, exec) {
      const violations = check(args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return await options.execute(args as A, exec)
    },
    ...safe === undefined ? {} : {
      isConcurrencySafe: (args: unknown) => check(args).length === 0 && safe(args as A),
    },
  }
}
