// @actions/workflow-parser, loadable by plain Node. The package imports its JSON
// schemas without `with { type: 'json' }`, which Node's ESM loader refuses; a load
// hook serves those two files as modules exporting the parsed JSON. The version is
// pinned in package.json because the hook names the package's own files.

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, nextLoad) {
    if (url.includes('/@actions/workflow-parser/') && url.endsWith('.min.json')) {
      return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const parser = await import('@actions/workflow-parser')

export const { convertWorkflowTemplate, isBasicExpression, isLiteral, isMapping, isSequence, isString, parseWorkflow } =
  parser
export const NoOperationTraceWriter = parser.NoOperationTraceWriter
export type { WorkflowTemplate } from '@actions/workflow-parser'
