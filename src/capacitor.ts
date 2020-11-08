export type Comparator<V> = (a: V, b: V) => boolean

export class Client<V> {
  /** How many frames to allow interpolation */
  interpolate = 0
  /** Size of buffer, minus interpolation */
  size = 0

  /** List of all commits */
  commits: (V | null)[] = []

  /** Cache current frame state */
  cache: V | null = null

  // TODO: is it better to store the comparator as a property,
  // or pass it from Capacitor to the commit method?
  constructor(public comparator: Comparator<V>) { }

  /** Returns true if no error correction necessary */
  commit(index: number, value: V): boolean {
    // TODO: update size

    while (this.commits.length < index + 1) {
      this.commits.push(null)
    }

    const before = this.commits[index]

    if (before !== null) {
      const compare = this.comparator(before, value)

      if (!compare) {
        this.commits[index] = value

        return false
      }
    }

    this.commits[index] = value

    return true
  }

  read(index: number): (V | null) {
    // TODO: interpolation logic will go here
    // TODO: swap length check for this.size + this.interpolate
    return this.commits.length > index ? this.commits[index] : null
  }
}

export class Capacitor<C, V> {
  commits: C[] = []
  clients = new Set<Client<V>>()

  equality: Comparator<V> = () => false

  constructor(public comparator: Comparator<V>) { }

  /** Create a new client */
  connect() {
    const client = new Client<V>(this.comparator)

    this.clients.add(client)

    return client
  }

  /**
   * Updates client caches
   * Returns true if all clients were updated, false if any were not
   * Short-circuits on first failed client update
   */
  read(index: number) {
    for (const client of this.clients) {
      client.cache = client.read(index)

      if (client.cache === null) {
        return false
      }
    }

    return true
  }

  /** Clears clients and commits */
  clear() {
    this.clients.clear()
    this.commits = []
  }
}
