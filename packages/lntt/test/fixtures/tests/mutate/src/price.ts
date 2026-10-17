export function discount(total: number, member: boolean): number {
  if (total <= 0) return 0
  return member ? total * 0.9 : total
}

export function label(total: number): string {
  return total > 100 ? 'big' : 'small'
}

export function next(n: number): number {
  return n + 1
}
