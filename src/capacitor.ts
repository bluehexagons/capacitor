export type Comparator<V> = (a: V, b: V) => boolean

interface ClientProps<V> {
  comparator?: Comparator<V>
  sizeOffset?: number
}

const defaultComparator = () => true

export class Client<V> {
  comparator: Comparator<V>
  /** How many frames to allow interpolation */
  interpolate = 0
  /** Size of buffer, minus interpolation */
  size = 0
  /** Added to size when computing Capacitor size */
  sizeOffset = 0

  /** List of all commits */
  commits: (V | null)[] = []

  /** Cache current frame state */
  cache: V | null = null

  // TODO: is it better to store the comparator as a property,
  // or pass it from Capacitor to the commit method?
  constructor({
    comparator = defaultComparator,
    sizeOffset = 0
  }: ClientProps<V>) {
    this.comparator = comparator
    this.sizeOffset = sizeOffset
  }

  /** Returns true if no error correction necessary */
  commit(outerIndex: number, value: V): boolean {
    const index = outerIndex - this.sizeOffset
    if (index === this.size) {
      this.size++

      for (let i = this.size; i < this.commits.length; i++) {
        if (this.commits[i] === null) {
          break
        }

        this.size++
      }
    }

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

  /** returns the commit at the given index */
  read(outerIndex: number): (V | null) {
    const index = outerIndex - this.sizeOffset
    // TODO: interpolation logic will go here
    // TODO: swap length check for this.size + this.interpolate
    return this.size > index ? this.commits[index] : null
  }
}

export class Capacitor<C, V> {
  commits: C[] = []
  clients = new Set<Client<V>>()

  equality: Comparator<V> = () => false

  constructor(public comparator: Comparator<V>) { }

  /** Create a new client */
  connect(props: ClientProps<V>) {
    const client = new Client<V>({ comparator: this.comparator, ...props })

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

  size() {
    let size = Infinity

    if (this.clients.size === 0) {
      return 0
    }

    for (const client of this.clients) {
      size = Math.min(size, client.size + client.sizeOffset)
    }

    return size
  }
}
