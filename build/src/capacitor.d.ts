export type Comparator<V> = (a: V, b: V) => boolean;
interface ClientProps<V> {
    comparator?: Comparator<V>;
    sizeOffset?: number;
}
export declare class Client<V> {
    comparator: Comparator<V>;
    interpolate: number;
    size: number;
    sizeOffset: number;
    commits: (V | null)[];
    cache: V | null;
    constructor({ comparator, sizeOffset }: ClientProps<V>);
    commit(outerIndex: number, value: V): boolean;
    read(outerIndex: number): V | null;
}
export declare class Capacitor<C, V> {
    comparator: Comparator<V>;
    commits: C[];
    clients: Set<Client<V>>;
    equality: Comparator<V>;
    constructor(comparator: Comparator<V>);
    connect(props: ClientProps<V>): Client<V>;
    disconnect(client: Client<V>): void;
    read(index: number): boolean;
    clear(): void;
    size(): number;
}
export {};
