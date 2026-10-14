export type LooseCounts = Record<any, number>;

interface Spec<Nodes extends string = any> {
    nodes: { [name in Nodes]: boolean };
}

export type DefaultSpec = Spec;
