import { Capacitor } from '../src/capacitor'

interface State {
  text: string
}

interface Packet {
  value: number
}

const compare = (a: Packet, b: Packet) => a.value === b.value

describe('usage', () => {
  test('client creation and use', () => {
    const cap = new Capacitor<State, Packet>(compare)
    const client = cap.connect()
    let v = client.read(0)
    expect(v).toBe(null)

    let ok = client.commit(0, { value: 0 })
    expect(ok).toBe(true)
    v = client.read(0)
    expect(v?.value).toBe(0)

    ok = client.commit(0, { value: 1 })
    expect(ok).toBe(false)
    v = client.read(0)
    expect(v?.value).toBe(1)

    ok = client.commit(0, { value: 1 })
    expect(ok).toBe(true)
    v = client.read(0)
    expect(v?.value).toBe(1)

    ok = client.commit(1, { value: 0 })
    expect(ok).toBe(true)
    v = client.read(0)
    expect(v?.value).toBe(1)
    v = client.read(1)
    expect(v?.value).toBe(0)
    v = client.read(2)
    expect(v).toBe(null)
  })

  test('server creation and use', () => {
    const cap = new Capacitor<State, Packet>(compare)
    const client = cap.connect()

    let ok = cap.read(0)
    expect(ok).toBe(false)
    expect(client.cache).toBe(null)

    ok = client.commit(1, { value: 0 })
    expect(ok).toBe(true)

    ok = cap.read(0)
    expect(ok).toBe(false)
    expect(client.cache).toBe(null)

    // TODO: enable this test when future data is correctly disallowed
    // ok = cap.read(1)
    // expect(ok).toBe(false)

    ok = client.commit(0, {value: 1})
    expect(ok).toBe(true)
    ok = cap.read(0)
    expect(ok).toBe(true)
    expect(client.cache?.value).toBe(1)

    ok = cap.read(1)
    expect(ok).toBe(true)
    expect(client.cache?.value).toBe(0)

    ok = cap.read(2)
    expect(ok).toBe(false)

    const client2 = cap.connect()
    ok = cap.read(0)
    expect(ok).toBe(false)

    ok = client2.commit(0, {value: 0})
    expect(ok).toBe(true)
    ok = cap.read(0)
    expect(ok).toBe(true)
    expect(client.cache?.value).toBe(1)
    expect(client2.cache?.value).toBe(0)

    ok = cap.read(1)
    expect(ok).toBe(false)

    ok = client2.commit(1, {value: 1})
    expect(ok).toBe(true)

    const testSize = 16
    for (let i = 1; i < testSize; i++) {
      // client overwrites
      expect(client.commit(i, {value: i - 1})).toBe(true)
      expect(client2.commit(i, {value: i})).toBe(true)
    }

    ok = true
    for (let i = 1; i < testSize; i++) {
      expect(cap.read(i)).toBe(true)
      expect(client.cache?.value).toBe(i - 1)
      expect(client2.cache?.value).toBe(i)
    }

    expect(cap.read(testSize)).toBe(false)
  })
})
