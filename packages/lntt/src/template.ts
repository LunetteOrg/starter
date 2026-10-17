// The templates of agents/*.md: `{{key}}` is replaced once, in one pass, so a value that
// holds braces (a context file) is never read as a placeholder.

export type Values = Record<string, string | number | null | undefined>

// A key the template names and the values do not have is an error: a typo in a template
// must not reach an agent as literal braces. A key whose value is empty is an optional
// part that is absent; a line that holds only that slot (`{{key}}`, or `- {{key}}` in a
// list) goes away, with the blank line that separated it from the text before.
export function fill(template: string, values: Values): string {
  const lines: string[] = []
  for (const line of template.split('\n')) {
    const slot = /^(- )?\{\{(\w+)\}\}$/.exec(line)
    if (slot && isEmpty(values, slot[2] as string)) {
      if (!slot[1] && lines.at(-1) === '') lines.pop()
      continue
    }
    lines.push(
      line.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        if (!Object.hasOwn(values, key)) throw new Error(`the template names {{${key}}}, which has no value`)
        return String(values[key] ?? '')
      }),
    )
  }
  return lines.join('\n')
}

function isEmpty(values: Values, key: string): boolean {
  return Object.hasOwn(values, key) && (values[key] === undefined || values[key] === null || values[key] === '')
}
