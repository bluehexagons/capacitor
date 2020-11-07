export type Comparator<V> = (a: V, b: V) => boolean

// const maxRollback = 0

export class Client<V> {
  commits: (V | null)[] = []
  lastReal = -1

  /** Returns true if no error correction necessary */
  commit(index: number, value: V, comparator: Comparator<V>): boolean {
    while (this.commits.length < index - 1) {
      this.commits.push(null)
    }

    const before = this.commits[index]

    if (before !== null) {
      const compare = comparator(before, value)

      if (!compare) {
        this.commits[index] = value
        return false
      }
    }

    this.commits[index] = value
    return true
  }

  read(index: number): (V | null) {
    return this.commits.length > index ? this.commits[index] : null
  }
}

export class Capacitor<C, V> {
  commits: C[] = []
  clients = new Map<number, Client<V>>()

  equality: Comparator<V> = () => false
}
