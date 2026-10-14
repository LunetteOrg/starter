// @ts-nocheck — fixture. Clean: mentions "throw new Error" and process.env only in
// a comment and a string, which must NOT be flagged.
export function ok() {
  const note = 'do not use process.env or throw new Error here'
  return { note }
}
